'use strict';

// Every piece of Flatpak knowledge in the app comes through this file, and
// every one of them shells out to the `flatpak` CLI. Nothing links against
// libflatpak: the app ships as an AppImage so it can run on a bare install
// where no matching library is present.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const VAR_APP = path.join(HOME, '.var', 'app');
const USER_OVERRIDES = path.join(HOME, '.local', 'share', 'flatpak', 'overrides');
const SYSTEM_OVERRIDES = '/var/lib/flatpak/overrides';
const SYSTEM_REPO = '/var/lib/flatpak/repo';

const ICON_ROOTS = [
  path.join(HOME, '.local', 'share', 'flatpak', 'exports', 'share', 'icons', 'hicolor'),
  '/var/lib/flatpak/exports/share/icons/hicolor',
];
const ICON_SIZES = ['128x128', '256x256', '64x64', '96x96', '48x48'];

// A generous ceiling rather than a real timeout: `flatpak install` on a slow
// connection is allowed to take as long as it takes, but a hung CLI must not
// wedge the app for ever.
const LONG_MS = 60 * 60 * 1000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeout || 120000,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? (stderr || error.message).trim() : null,
      });
    });
  });
}

function runLong(cmd, args) {
  return run(cmd, args, { timeout: LONG_MS });
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

async function probe() {
  const result = await run('flatpak', ['--version'], { timeout: 10000 });
  if (!result.ok) {
    return { present: false, version: null };
  }
  const version = (result.stdout.trim().split(/\s+/).pop() || '').trim();
  return { present: true, version };
}

// ---------------------------------------------------------------------------
// Installed apps
// ---------------------------------------------------------------------------

// `flatpak list` gives tab-separated columns in the order asked for. Asking
// for `installation` rather than deriving the scope means a user install that
// lives somewhere non-standard still reports itself correctly.
const LIST_COLUMNS = ['name', 'application', 'version', 'branch', 'arch', 'origin', 'installation'];

async function listApps() {
  const result = await run('flatpak', [
    'list', '--app', `--columns=${LIST_COLUMNS.join(',')}`,
  ]);
  if (!result.ok) return { ok: false, error: result.error, apps: [] };

  const apps = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    if (cells.length < LIST_COLUMNS.length) continue;
    const [name, id, version, branch, arch, origin, installation] = cells.map((c) => c.trim());
    if (!id) continue;
    apps.push({
      id,
      name: name || id,
      version: version || '',
      branch: branch || 'stable',
      arch: arch || (process.arch === 'arm64' ? 'aarch64' : 'x86_64'),
      origin: origin || '',
      scope: installation === 'user' ? 'user' : 'system',
    });
  }
  // Flatpak lists the same id once per installation when an app is in both.
  // The user copy wins: its data directory is the one under ~/.var/app.
  const byId = new Map();
  for (const app of apps) {
    const existing = byId.get(app.id);
    if (!existing || (existing.scope === 'system' && app.scope === 'user')) byId.set(app.id, app);
  }
  return { ok: true, apps: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

// `flatpak ps` prints one line per running instance, so an app with three
// windows open appears three times. The warning only ever needs the app.
async function runningApps() {
  const result = await run('flatpak', ['ps', '--columns=application']);
  if (!result.ok) return [];
  const ids = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return [...new Set(ids)];
}

// Everything Flat installs goes in at user scope, so every remote it
// installs from has to exist at user scope. Most distros add Flathub
// system-wide, which looks present in `flatpak remotes` and then fails the
// install with nothing more useful than "no remote refs found".
//
// The user copy is NOT given the same name when the name is already taken
// system-wide. Two remotes called `flathub` make every `flatpak install -y
// flathub <app>` on the machine stop and ask which one is meant, including
// the ones a person types themselves. That is this app breaking somebody
// else's habit to save itself a few lines, which is not a trade it gets to
// make. The user copy becomes `flathub-user` instead and nothing typed
// anywhere else changes meaning.
//
// Returns the remote name to actually install from.
async function ensureUserRemote(name, url) {
  if (!name) return { ok: false, error: 'No remote was recorded for this app.' };

  const userRemotes = await listRemotes('user');
  if (userRemotes.some((r) => r.name === name)) return { ok: true, remote: name, added: false };

  const systemRemotes = await listRemotes('system');
  const clashes = systemRemotes.some((r) => r.name === name);
  const localName = clashes ? `${name}-user` : name;
  if (userRemotes.some((r) => r.name === localName)) {
    return { ok: true, remote: localName, added: false };
  }

  // Flathub publishes a .flatpakrepo that carries its own signing key, which
  // is the cleanest way to add it and the only one that works on a machine
  // with nothing on it to borrow a key from.
  if (name === FLATHUB.name) {
    const added = await run('flatpak', [
      'remote-add', '--if-not-exists', '--user', localName, FLATHUB.url,
    ], { timeout: 120000 });
    return added.ok
      ? { ok: true, remote: localName, added: true }
      : { ok: false, error: added.error };
  }

  let address = url;
  if (!address) {
    const match = systemRemotes.find((r) => r.name === name);
    address = match && match.url;
  }
  if (!address) {
    return { ok: false, error: `The ${name} remote is not on this machine and no address for it was recorded.` };
  }

  // Borrow the system installation's trusted key rather than turning
  // signature checking off to get past it.
  const args = ['remote-add', '--if-not-exists', '--user'];
  const key = path.join(SYSTEM_REPO, `${name}.trustedkeys.gpg`);
  try {
    fs.accessSync(key, fs.constants.R_OK);
    args.push(`--gpg-import=${key}`);
  } catch { /* no system copy to borrow a key from */ }
  args.push(localName, address);

  const result = await run('flatpak', args, { timeout: 120000 });
  return result.ok
    ? { ok: true, remote: localName, added: true }
    : { ok: false, error: result.error };
}

async function killApp(id) {
  return run('flatpak', ['kill', id], { timeout: 20000 });
}

// `scope` is 'user', 'system', or nothing for both. The distinction matters
// more than it looks: a remote that exists only system-wide cannot be named
// by a `--user` install, and flatpak's error for that says only "no remote
// refs found", which sends you hunting for the wrong thing entirely.
async function listRemotes(scope) {
  const args = ['remotes'];
  if (scope === 'user' || scope === 'system') args.push(`--${scope}`);
  args.push('--columns=name,url,options');
  const result = await run('flatpak', args);
  if (!result.ok) return [];
  const remotes = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, url, options] = line.split('\t').map((c) => (c || '').trim());
    if (!name || !url) continue;
    if (remotes.some((r) => r.name === name)) continue;
    remotes.push({ name, url, options: options || '' });
  }
  return remotes;
}

// ---------------------------------------------------------------------------
// Data directories
// ---------------------------------------------------------------------------

function dataDir(id) {
  return path.join(VAR_APP, id);
}

function hasData(id) {
  try {
    return fs.statSync(dataDir(id)).isDirectory();
  } catch {
    return false;
  }
}

// Whether an app has saved anything worth keeping: at least one real file
// in its folder outside `cache`. A folder alone is not settings — Flatpak
// makes an empty one for any app that has merely been launched, and an app
// that has only cached things has nothing a new machine would miss.
// Stops at the first file found, so a large profile costs no more than a
// small one.
function hasSettings(id) {
  const root = dataDir(id);
  const stack = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'cache') continue;
      stack.push({ dir: root, entry });
    }
  } catch {
    return false;
  }
  let looked = 0;
  while (stack.length) {
    const { dir, entry } = stack.pop();
    const full = path.join(dir, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      looked += 1;
      if (looked > 5000) return true; // that many folders is not an empty profile
      try {
        for (const child of fs.readdirSync(full, { withFileTypes: true })) {
          stack.push({ dir: full, entry: child });
        }
      } catch { /* unreadable folder: say nothing about it */ }
    }
  }
  return false;
}

// `du -sb` counts apparent size in bytes, which is what the archive will
// roughly hold. Failing quietly to 0 matters: a permission error on one
// stray directory must not lose the whole listing.
async function dataSize(id, { includeCache }) {
  const dir = dataDir(id);
  if (!hasData(id)) return 0;
  const args = ['-sb'];
  if (!includeCache) args.push('--exclude=cache');
  args.push(dir);
  const result = await run('du', args, { timeout: 120000 });
  if (!result.ok && !result.stdout) return 0;
  const bytes = parseInt(result.stdout.split(/\s+/)[0], 10);
  return Number.isFinite(bytes) ? bytes : 0;
}

// Sizing every app at once fires one `du` per app; a handful at a time keeps
// a machine with sixty Flatpaks from thrashing the disk.
async function dataSizes(ids, { includeCache }, onProgress) {
  const sizes = {};
  const queue = [...ids];
  let done = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      sizes[id] = await dataSize(id, { includeCache });
      done += 1;
      if (onProgress) onProgress(done, ids.length);
    }
  });
  await Promise.all(workers);
  return sizes;
}

// ---------------------------------------------------------------------------
// Permissions and overrides
// ---------------------------------------------------------------------------

function readOverrideFile(id) {
  const user = path.join(USER_OVERRIDES, id);
  const system = path.join(SYSTEM_OVERRIDES, id);
  for (const [scope, file] of [['user', user], ['system', system]]) {
    try {
      return { scope, text: fs.readFileSync(file, 'utf8') };
    } catch { /* not there, try the next one */ }
  }
  return null;
}

function readGlobalOverride() {
  try {
    return fs.readFileSync(path.join(USER_OVERRIDES, 'global'), 'utf8');
  } catch {
    return null;
  }
}

async function showPermissions(id) {
  const result = await run('flatpak', ['info', '--show-permissions', id], { timeout: 30000 });
  return result.ok ? result.stdout : '';
}

// The permission dump is an ini file. Turning it into `flatpak override`
// flags is the fallback path for a restore where no overrides file existed:
// it reproduces the permission set the app actually had, rather than
// whatever the newly installed build happens to ask for.
const CONTEXT_FLAGS = {
  shared: ['--share=', '--unshare='],
  sockets: ['--socket=', '--nosocket='],
  devices: ['--device=', '--nodevice='],
  features: ['--allow=', '--disallow='],
  filesystems: ['--filesystem=', '--nofilesystem='],
};

function permissionsToArgs(text) {
  const args = [];
  let section = '';
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (section === 'Context') {
      const flags = CONTEXT_FLAGS[key];
      if (!flags) continue;
      for (const item of value.split(';')) {
        const entry = item.trim();
        if (!entry) continue;
        args.push(entry.startsWith('!')
          ? `${flags[1]}${entry.slice(1)}`
          : `${flags[0]}${entry}`);
      }
    } else if (section === 'Session Bus Policy' || section === 'System Bus Policy') {
      const system = section.startsWith('System') ? '--system-' : '--';
      if (value === 'talk') args.push(`${system}talk-name=${key}`);
      else if (value === 'own') args.push(`${system}own-name=${key}`);
      else if (value === 'none') args.push(`${system}no-talk-name=${key}`);
    } else if (section === 'Environment') {
      args.push(`--env=${key}=${value}`);
    }
  }
  return args;
}

async function applyOverrideArgs(id, args) {
  if (!args.length) return { ok: true };
  // One call: `flatpak override` takes the whole set at once, and a single
  // failure is easier to report than twenty partial ones.
  return run('flatpak', ['override', '--user', ...args, id], { timeout: 60000 });
}

function writeOverrideFile(id, text) {
  fs.mkdirSync(USER_OVERRIDES, { recursive: true });
  fs.writeFileSync(path.join(USER_OVERRIDES, id), text, 'utf8');
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

// Read straight off disk into a data URL. The renderer never gets a path to
// load itself, so nothing outside these two export directories is reachable
// from the page.
function iconDataUrl(id) {
  for (const root of ICON_ROOTS) {
    for (const size of ICON_SIZES) {
      const file = path.join(root, size, 'apps', `${id}.png`);
      try {
        const data = fs.readFileSync(file);
        if (data.length && data.length < 2 * 1024 * 1024) {
          return `data:image/png;base64,${data.toString('base64')}`;
        }
      } catch { /* next size */ }
    }
    const svg = path.join(root, 'scalable', 'apps', `${id}.svg`);
    try {
      const data = fs.readFileSync(svg);
      if (data.length && data.length < 512 * 1024) {
        return `data:image/svg+xml;base64,${data.toString('base64')}`;
      }
    } catch { /* no scalable icon */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

// The one remote that has to exist on a machine with nothing on it. Adding
// it is the first thing the standing-list screen offers when it is missing,
// because without a remote there is nothing to search and nothing to install.
const FLATHUB = { name: 'flathub', url: 'https://dl.flathub.org/repo/flathub.flatpakrepo' };

async function addFlathub() {
  const ready = await ensureUserRemote(FLATHUB.name);
  return ready.ok ? { ok: true, remote: ready.remote } : { ok: false, error: ready.error };
}

// `flatpak search` answers out of the configured remotes' appstream data, so
// it needs no internet service of its own and no API key. It also returns
// runtimes, themes and locale packs, which are not things anybody means to
// install by name — those are filtered out here rather than shown and
// explained.
const NOT_AN_APP = [
  /^org\.gtk\.Gtk3theme\./,
  /^org\.kde\.(Platform|Sdk|KStyle)/,
  /^org\.freedesktop\.(Platform|Sdk)/,
  /^org\.gnome\.(Platform|Sdk)/,
  /\.(Locale|Debug|Sources|BaseApp|Extension)$/,
];

async function searchApps(term) {
  const text = String(term || '').trim();
  if (text.length < 2) return [];
  const result = await run('flatpak', [
    'search', '--columns=name,application,remotes,description', text,
  ], { timeout: 60000 });
  if (!result.ok) return [];

  const found = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, id, remotes, description] = line.split('\t').map((c) => (c || '').trim());
    if (!id || NOT_AN_APP.some((pattern) => pattern.test(id))) continue;
    if (found.some((f) => f.id === id)) continue;
    found.push({
      id,
      name: name || id,
      remote: (remotes || 'flathub').split(',')[0].trim(),
      description: description || '',
    });
    if (found.length >= 30) break;
  }

  // An exact id match is what somebody pasting an id wants at the top.
  const lower = text.toLowerCase();
  found.sort((a, b) => {
    const score = (x) => (x.id.toLowerCase() === lower ? 0
      : x.name.toLowerCase() === lower ? 1
        : x.name.toLowerCase().startsWith(lower) ? 2 : 3);
    return score(a) - score(b) || a.name.localeCompare(b.name);
  });
  return found;
}

// The standing list records no branch on purpose: it says "the current
// Firefox", not "the Firefox that machine happened to have".
async function installLatest({ id, remote }) {
  const ready = await ensureUserRemote(remote);
  if (!ready.ok) return { ok: false, error: ready.error };

  const result = await runLong('flatpak', [
    'install', '--user', '--noninteractive', '-y', ready.remote, id,
  ]);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error || 'install failed' };
}

async function addRemote(name, url) {
  return run('flatpak', [
    'remote-add', '--if-not-exists', '--user', name, url,
  ], { timeout: 60000 });
}

async function isInstalled(id) {
  const result = await run('flatpak', ['info', id], { timeout: 30000 });
  return result.ok;
}

// Returns { ok, branch, fellBack, error }. A target distro that never
// carried the recorded branch is a warning, not a failure: installing the
// default branch keeps the data restore useful.
async function installApp({ id, remote, branch, remoteUrl }) {
  const ready = await ensureUserRemote(remote, remoteUrl);
  if (!ready.ok) return { ok: false, error: ready.error };

  const exact = await runLong('flatpak', [
    'install', '--user', '--noninteractive', '-y', ready.remote, `${id}//${branch}`,
  ]);
  if (exact.ok) return { ok: true, branch, fellBack: false };

  const fallback = await runLong('flatpak', [
    'install', '--user', '--noninteractive', '-y', ready.remote, id,
  ]);
  if (fallback.ok) return { ok: true, branch: null, fellBack: true };

  return { ok: false, error: (exact.error || fallback.error || 'install failed') };
}

module.exports = {
  HOME,
  VAR_APP,
  USER_OVERRIDES,
  SYSTEM_OVERRIDES,
  run,
  runLong,
  probe,
  listApps,
  runningApps,
  killApp,
  listRemotes,
  dataDir,
  hasData,
  hasSettings,
  dataSize,
  dataSizes,
  readOverrideFile,
  readGlobalOverride,
  showPermissions,
  permissionsToArgs,
  applyOverrideArgs,
  writeOverrideFile,
  iconDataUrl,
  addRemote,
  isInstalled,
  installApp,
  FLATHUB,
  addFlathub,
  ensureUserRemote,
  searchApps,
  installLatest,
};
