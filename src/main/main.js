'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const fp = require('./flatpak');
const ar = require('./archive');
const { recommend } = require('./recommend');
const { runBackup, packName } = require('./backup');
const { runRestore } = require('./restore');
const applist = require('./applist');

// Where the dot looks for a newer build: this repository's GitHub releases,
// which carry the AppImage and the `latest-linux.yml` electron-builder writes
// beside it to say which version is current.
const UPDATE_FEED = {
  provider: 'github',
  owner: 'lightmorphic',
  repo: 'flat',
};

let mainWindow = null;
let tray = null;
let busy = false;
// Set while the window is being hidden to the tray rather than closed, so
// the close handler can tell the two apart.
let reallyQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icons', '256x256.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Nothing in this app is a web page. Anything that wants to be one opens
  // in the user's own browser instead of inside the window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // Closing while a backup, restore or install is running hides the window
  // instead of ending the job. The tray icon is then the only thing on
  // screen, and it says how far along the job is. With nothing running,
  // closing means closing — an app that refuses to go away when you have
  // finished with it is a nuisance, not a feature.
  mainWindow.on('close', (event) => {
    if (reallyQuitting || !busy) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function iconPath(size) {
  return path.join(__dirname, '..', '..', 'build', 'icons', `${size}x${size}.png`);
}

function showWindow(tab) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    if (tab) mainWindow.webContents.once('did-finish-load', () => send('go-to-tab', tab));
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  if (tab) send('go-to-tab', tab);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'All apps', click: () => showWindow('all') },
    { label: 'My apps', click: () => showWindow('mine') },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        reallyQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  // 64px rather than 22: the desktop scales it down itself, and a icon sized
  // for a standard panel comes out soft on a HiDPI screen.
  const image = nativeImage.createFromPath(iconPath(64));
  tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(iconPath(32)) : image);
  tray.setToolTip('Flat');
  tray.setContextMenu(buildTrayMenu());
  // Not every Linux panel delivers a plain click, which is why the menu
  // carries every destination rather than relying on this.
  tray.on('click', () => showWindow());
}

// The tray is the only thing on screen once the window is hidden, so it has
// to say where a running job has got to.
function trayStatus(text) {
  if (tray && !tray.isDestroyed()) tray.setToolTip(text ? `Flat — ${text}` : 'Flat');
}

function send(channel, payload) {
  if (channel === 'job-progress' && payload && payload.total) {
    trayStatus(`${Math.min(payload.index + 1, payload.total)} of ${payload.total}`);
  }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  carryOverOldSettings();
  createWindow();
  createTray();
  setupUpdates();
});

// With a tray icon the app is still there after the last window goes, so
// this must not end it — but only while something is actually running.
app.on('window-all-closed', () => {
  if (!busy) app.quit();
});

// A job half way through writing or deleting a data directory must not be
// cut off. Quit is refused outright while one is running; the tray's own
// Quit item sets `reallyQuitting`, and even that waits for `busy` to clear.
app.on('before-quit', (event) => {
  if (busy) {
    event.preventDefault();
    showWindow();
  }
});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

ipcMain.handle('app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  hostname: os.hostname(),
  updatesConfigured: Boolean(UPDATE_FEED),
}));

ipcMain.handle('flatpak-probe', async () => {
  const probe = await fp.probe();
  const compressor = await ar.detectCompressor();
  return { ...probe, compression: compressor.name };
});

// ---------------------------------------------------------------------------
// Backup side
// ---------------------------------------------------------------------------

ipcMain.handle('scan-apps', async () => {
  const listed = await fp.listApps();
  if (!listed.ok) return { ok: false, error: listed.error };

  const withData = listed.apps.map((a) => {
    const hasData = fp.hasData(a.id);
    return { ...a, hasData, hasSettings: hasData && fp.hasSettings(a.id) };
  });
  const ids = withData.filter((a) => a.hasData).map((a) => a.id);

  // Both sizes for every app with a folder: the whole thing ("Full"), and
  // its settings without what it rebuilds by itself. A handful at a time, so
  // sixty apps do not all hit the disk at once.
  const sizes = {};
  const queue = [...ids];
  let done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      sizes[id] = await fp.settingsSizes(id);
      done += 1;
      send('scan-progress', { done, total: ids.length });
    }
  }));

  const apps = withData.map((a) => {
    const size = sizes[a.id] || { full: 0, trimmed: 0, trimmable: false };
    const dataBytes = size.trimmed;
    const advice = recommend({ ...a, dataBytes });
    return {
      ...a,
      dataBytes,
      fullBytes: size.full,
      trimmable: size.trimmable,
      icon: fp.iconDataUrl(a.id),
      recommended: advice.recommended,
      reason: advice.reason,
    };
  });

  const running = await fp.runningApps();
  return { ok: true, apps, running };
});

ipcMain.handle('running-apps', async () => fp.runningApps());

ipcMain.handle('close-apps', async (event, ids) => {
  const stillRunning = [];
  for (const id of ids) {
    await fp.killApp(id);
  }
  // Give them a moment, then report what actually let go, rather than
  // claiming success and leaving a live profile to be copied.
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const running = new Set(await fp.runningApps());
  for (const id of ids) if (running.has(id)) stillRunning.push(id);
  return { ok: stillRunning.length === 0, stillRunning };
});

ipcMain.handle('choose-backup-file', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save the backup',
    defaultPath: path.join(app.getPath('documents') || os.homedir(), packName(os.hostname())),
    filters: [{ name: 'Flat backup', extensions: ['fmpack'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const file = result.filePath.endsWith('.fmpack') ? result.filePath : `${result.filePath}.fmpack`;
  return { canceled: false, file };
});

ipcMain.handle('run-backup', async (event, { apps, list, outFile }) => {
  if (busy) return { ok: false, error: 'Something is already running.' };
  busy = true;
  try {
    return await runBackup({ apps, list, outFile }, (progress) => {
      send('job-progress', progress);
    });
  } finally {
    busy = false;
    trayStatus(null);
  }
});




// ---------------------------------------------------------------------------
// The standing list: what is wanted on any machine
// ---------------------------------------------------------------------------

// Where a portable `flat-apps.json` is looked for. APPIMAGE is set by
// the AppImage runtime and is the path of the AppImage file itself, so its
// directory is the folder the file was downloaded into — which is where a
// list file downloaded alongside it will be.
function listSearchDirs() {
  const dirs = [];
  if (process.env.APPIMAGE) dirs.push(path.dirname(process.env.APPIMAGE));
  dirs.push(process.cwd());
  dirs.push(app.getPath('downloads'));
  return [...new Set(dirs)];
}

function listPlaces() {
  return { settingsDir: app.getPath('userData'), searchDirs: listSearchDirs() };
}

// The app was called Flatmorphic until 18 September 2026, and Electron keeps
// its settings in a folder named after the app. Without this the first run
// as Flat would open on an empty list and look as if everything had been
// lost. Copy, never move: the old folder stays until someone deletes it.
function carryOverOldSettings() {
  const here = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'Flatmorphic');
  for (const name of [applist.FILE_NAME]) {
    const from = path.join(old, name);
    const to = path.join(here, name);
    try {
      if (fs.existsSync(to) || !fs.existsSync(from)) continue;
      fs.mkdirSync(here, { recursive: true });
      fs.copyFileSync(from, to);
    } catch { /* a fresh list is the worst case, and the old file is still there */ }
  }
}

ipcMain.handle('applist-read', async () => {
  const loaded = applist.load(listPlaces());
  const installed = new Set((await fp.listApps()).apps.map((a) => a.id));
  const remotes = await fp.listRemotes();
  return {
    ...loaded,
    apps: loaded.apps.map((a) => ({ ...a, installed: installed.has(a.id) })),
    hasFlathub: remotes.some((r) => r.name === 'flathub'),
    remotes: remotes.map((r) => r.name),
    portableName: applist.PORTABLE_NAME,
  };
});

ipcMain.handle('applist-write', async (event, { apps, never }) => applist.save(listPlaces(), apps, never));

// Building the list from the machine that already has everything on it, so
// it never has to be typed out once.
ipcMain.handle('applist-from-installed', async () => {
  const listed = await fp.listApps();
  return listed.apps.map((a) => ({
    id: a.id,
    name: a.name,
    remote: a.origin || 'flathub',
  }));
});

ipcMain.handle('applist-search', async (event, term) => fp.searchApps(term));

ipcMain.handle('add-flathub', async () => {
  const result = await fp.addFlathub();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
});

ipcMain.handle('applist-export', async (event, { apps, never }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save the app list',
    defaultPath: path.join(app.getPath('downloads') || os.homedir(), applist.PORTABLE_NAME),
    filters: [{ name: 'Flat app list', extensions: ['json'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    applist.writeTo(result.filePath, apps, never);
    return { canceled: false, file: result.filePath };
  } catch (error) {
    return { canceled: false, error: error.message };
  }
});

ipcMain.handle('applist-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open an app list',
    defaultPath: app.getPath('downloads') || os.homedir(),
    filters: [
      { name: 'Flat app list', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, ...applist.readFrom(result.filePaths[0]) };
});

// The backup the Keep settings apps get their settings from. Looked for in
// the same places as the list file — beside the AppImage, where it was run
// from, and Downloads — newest first, because the routine on a new machine is
// "download everything into one folder and open Flat".
function findBackups() {
  const found = [];
  for (const dir of listSearchDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.fmpack')) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) found.push({ file, mtime: stat.mtimeMs });
      } catch { /* vanished between the listing and the look */ }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.file);
}

async function describeBackup(file) {
  const read = await ar.readManifest(file);
  if (!read.ok) return { ok: false, error: read.error };
  const installed = new Set((await fp.listApps()).apps.map((a) => a.id));
  const sizes = new Map((read.manifest.apps || []).map((a) => [a.id, Number(a.data_bytes) || 0]));
  return {
    ok: true,
    file,
    name: path.basename(file),
    created: read.manifest.created,
    host: read.manifest.source_host,
    ids: (read.manifest.apps || []).map((a) => a.id),
    // Everything the backup would put on this machine, in the order it was
    // saved, and whether each one is here already.
    entries: read.manifest.list.map((e) => ({
      ...e,
      installed: installed.has(e.id),
      bytes: (sizes.get(e.id) || 0),
    })),
  };
}

ipcMain.handle('settings-backup-find', async () => {
  for (const file of findBackups()) {
    const described = await describeBackup(file);
    if (described.ok) return described;
  }
  return null;
});

ipcMain.handle('settings-backup-describe', async (event, file) => {
  if (typeof file !== 'string' || !file.endsWith('.fmpack')) return { ok: false };
  return describeBackup(file);
});

ipcMain.handle('settings-backup-choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Which backup holds the settings?',
    defaultPath: app.getPath('downloads') || os.homedir(),
    filters: [{ name: 'Flat backup', extensions: ['fmpack'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, ...(await describeBackup(result.filePaths[0])) };
});

ipcMain.handle('install-apps', async (event, payload) => {
  const apps = Array.isArray(payload) ? payload : (payload && payload.apps) || [];
  const packFile = payload && !Array.isArray(payload) ? payload.packFile : null;
  if (busy) return { ok: false, error: 'Something is already running.' };
  busy = true;
  try {
    // Every app on the list is walked, including the ones already here.
    // Those are named and passed over rather than left out: a run that
    // silently shows fifty-nine of sixty-seven rows leaves you counting to
    // work out what happened to the other eight. Nothing stops the walk —
    // an app that is already installed, and an app that fails, both just
    // move it on to the next one.
    const wanted = applist.cleanEntries(apps);
    const installed = new Set((await fp.listApps()).apps.map((a) => a.id));
    const results = [];
    const total = wanted.length;

    for (let index = 0; index < total; index += 1) {
      const entry = wanted[index];

      if (installed.has(entry.id)) {
        results.push({ id: entry.id, name: entry.name, ok: true, skipped: true, notes: [] });
        send('job-progress', {
          index, total, appId: entry.id,
          step: 'skipped', message: `${entry.name} is already here`,
        });
        continue;
      }

      send('job-progress', {
        index, total, appId: entry.id,
        step: 'install', message: `Installing ${entry.name}`,
      });
      const outcome = await fp.installLatest(entry);
      results.push({
        id: entry.id, name: entry.name, ok: outcome.ok, skipped: false,
        error: outcome.error, notes: [],
      });
      send('job-progress', {
        index, total, appId: entry.id,
        step: outcome.ok ? 'done' : 'failed',
        message: outcome.ok ? `${entry.name} installed` : outcome.error,
      });
    }

    // Second pass: settings for the Keep settings apps. Only for apps this
    // run actually installed. An app that was already here has settings of
    // its own on this machine, and pressing Install must never be the thing
    // that overwrites them.
    const settingsNotes = {};
    let settingsRestored = 0;
    let settingsMissed = 0;
    const keepInstalledNow = wanted.filter((a) => a.keep
      && results.some((r) => r.id === a.id && r.ok && !r.skipped));

    let manifest = null;
    if (keepInstalledNow.length && packFile) {
      const read = await ar.readManifest(packFile);
      if (read.ok) manifest = read.manifest;
    }
    const inPack = new Set(manifest ? (manifest.apps || []).map((a) => a.id) : []);

    const restoreIds = [];
    for (const entry of keepInstalledNow) {
      if (!packFile || !manifest) {
        settingsNotes[entry.id] = { bad: true, text: 'Marked Keep settings, but there was no backup to take them from, so it is installed fresh.' };
        settingsMissed += 1;
      } else if (!inPack.has(entry.id)) {
        settingsNotes[entry.id] = { bad: true, text: 'Marked Keep settings, but it is not in the backup, so it is installed fresh.' };
        settingsMissed += 1;
      } else {
        restoreIds.push(entry.id);
      }
    }

    if (restoreIds.length) {
      const restored = await runRestore(
        { packFile, manifest, selection: restoreIds },
        (p) => send('job-progress', {
          index: total - 1, total, appId: p.appId,
          step: p.step === 'done' ? 'settings-done' : p.step === 'failed' ? 'settings-failed' : 'settings',
          message: p.step === 'done' || p.step === 'failed' ? p.message : `Settings: ${p.message}`,
        }),
      );
      for (const r of restored.results || []) {
        if (r.ok) {
          settingsRestored += 1;
          settingsNotes[r.id] = { bad: false, text: 'Settings brought back from the backup.' };
        } else {
          settingsMissed += 1;
          settingsNotes[r.id] = { bad: true, text: `Installed, but the settings could not be brought back: ${r.error}` };
        }
      }
    }

    return {
      ok: true,
      results,
      settingsNotes,
      settingsRestored,
      settingsMissed,
      succeeded: results.filter((r) => r.ok && !r.skipped).length,
      failed: results.filter((r) => !r.ok).length,
      skipped: results.filter((r) => r.skipped).length,
    };
  } finally {
    busy = false;
    trayStatus(null);
  }
});

ipcMain.handle('reveal-file', async (event, file) => {
  shell.showItemInFolder(file);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Update widget: one dot, five states, no banner anywhere else.
// ---------------------------------------------------------------------------

let lastUpdateState = null;

ipcMain.handle('update-state-get', () => lastUpdateState);

function setupUpdates() {
  if (!UPDATE_FEED) return;
  // eslint-disable-next-line global-require
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = null;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL(UPDATE_FEED);

  // Remembered as well as sent. The first check starts before the window
  // has finished loading, and an answer sent to a page that is not listening
  // yet is simply lost — which left the dot sitting there with no state.
  const push = (state) => {
    lastUpdateState = state;
    send('update-state', state);
  };
  autoUpdater.on('update-available', (info) => push({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => push({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => push({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => push({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', () => push({ status: 'error' }));

  // A check that cannot run at all — no network, or a copy run from the
  // source rather than the AppImage, where the updater declines — must still
  // end in an answer, or the dot pulses for ever. Red is the honest one.
  const check = () => autoUpdater.checkForUpdates()
    .then((result) => { if (!result) push({ status: 'error' }); })
    .catch(() => push({ status: 'error' }));
  check();
  setInterval(check, 30 * 60 * 1000);

  ipcMain.handle('update-check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return { error: true };
      return { ok: true };
    } catch {
      return { error: true };
    }
  });
  ipcMain.handle('update-download', async () => {
    autoUpdater.downloadUpdate().catch(() => {});
    return { ok: true };
  });
  ipcMain.handle('update-install', async () => {
    if (busy) {
      return { error: 'A backup or restore is running. Let it finish before restarting to update.' };
    }
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
}

// With no feed configured the renderer still calls these; answering keeps it
// from having to know whether updates exist.
if (!UPDATE_FEED) {
  ipcMain.handle('update-check', async () => ({ error: true }));
  ipcMain.handle('update-download', async () => ({ ok: false }));
  ipcMain.handle('update-install', async () => ({ error: 'Updates are not configured in this build.' }));
}
