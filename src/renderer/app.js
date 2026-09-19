'use strict';

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  blocker: $('blocker'),
  blockerBody: $('blocker-body'),

  tabAll: $('tab-all'),
  viewAll: $('view-all'),
  viewJob: $('view-job'),
  eyeAllBody: $('eye-all-body'),

  filterAll: $('filter-all'),
  allList: $('all-list'),
  allEmpty: $('all-empty'),
  allLoading: $('all-loading'),
  allTally: $('all-tally'),
  allHint: $('all-hint'),
  allSelectAll: $('all-select-all'),
  allSelectNone: $('all-select-none'),
  allToMine: $('all-to-mine'),

  includeCache: $('include-cache'),
  runningWarning: $('running-warning'),
  runningWarningText: $('running-warning-text'),
  closeRunning: $('close-running'),
  recheckRunning: $('recheck-running'),
  mineBackup: $('mine-backup'),

  tabMine: $('tab-mine'),
  viewMine: $('view-mine'),
  eyeMineBody: $('eye-mine-body'),
  minePortableName: $('mine-portable-name'),
  flathubWarning: $('flathub-warning'),
  addFlathub: $('add-flathub'),
  mineSearch: $('mine-search'),
  mineResults: $('mine-results'),
  mineAddBlank: $('mine-add-blank'),
  mineFromInstalled: $('mine-from-installed'),
  mineForget: $('mine-forget'),
  mineImport: $('mine-import'),
  mineExport: $('mine-export'),
  mineList: $('mine-list'),
  mineEmpty: $('mine-empty'),
  mineTally: $('mine-tally'),
  mineHint: $('mine-hint'),
  mineInstall: $('mine-install'),
  mineSourceText: $('mine-source-text'),
  mineSourceChoose: $('mine-source-choose'),
  mineAll: $('mine-all'),
  mineAllLabel: $('mine-all-label'),
  mineBulk: $('mine-bulk'),
  mineBulkCount: $('mine-bulk-count'),
  mineBulkKeep: $('mine-bulk-keep'),
  mineBulkFresh: $('mine-bulk-fresh'),
  mineBulkRemove: $('mine-bulk-remove'),

  jobHead: $('job-head'),
  jobCount: $('job-count'),
  jobProgressWrap: $('job-progress-wrap'),
  jobProgressFill: $('job-progress-fill'),
  jobLine: $('job-line'),
  jobList: $('job-list'),
  jobFootbar: $('job-footbar'),
  jobSummary: $('job-summary'),
  jobSummaryHint: $('job-summary-hint'),
  jobReveal: $('job-reveal'),
  jobDone: $('job-done'),

  updateWidget: $('update-widget'),
  updateWidgetVersion: $('update-widget-version'),
  updateDot: $('update-dot'),
  updateDotRingFill: $('update-dot-ring-fill'),
};

const state = {
  mode: 'all',
  // Every Flatpak app on this machine, and which of them are ticked on the
  // All apps tab.
  apps: [],
  allTicked: new Set(),
  running: [],
  // Set once Back up settings has been pressed and something was open: the
  // warning shows from then until it is dealt with, and not before.
  backupBlocked: false,
  jobRows: new Map(),
  lastBackupFile: null,
  mine: [],
  mineNever: new Set(),
  // Entries rather than ids: a blank row being typed into has no id yet and
  // can still be ticked.
  mineTicked: new Set(),
  // The backup the Keep settings apps will draw on, or null.
  settingsBackup: null,
  mineSource: 'empty',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const decimals = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// Saying something happened, in the line under the tally where the screen
// already explains itself. Not a coloured pill floating over the buttons:
// that one covered a control for as long as it was up, and it took the
// answer away again before it could be read twice.
const SAID_MS = 5000;
const saidTimers = new WeakMap();

function say(el, message) {
  if (!el) return;
  clearTimeout(saidTimers.get(el));
  if (!el.dataset.resting) el.dataset.resting = el.textContent;
  el.textContent = message;
  el.classList.add('is-said');
  saidTimers.set(el, setTimeout(() => {
    el.classList.remove('is-said');
    el.textContent = el.dataset.resting || '';
    delete el.dataset.resting;
  }, SAID_MS));
}

function setHint(el, text) {
  if (el.classList.contains('is-said')) el.dataset.resting = text;
  else el.textContent = text;
}

// The Morphic Button gesture. The first click arms and shows a tick; a
// second click inside three seconds acts; silence stands it back down. No
// dialog and no success message — the button is the whole conversation.
function arming(button, label, act) {
  let armed = false;
  let timer = null;
  const rest = () => {
    armed = false;
    clearTimeout(timer);
    button.classList.remove('is-armed', 'is-error');
    button.textContent = label;
  };
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    if (!armed) {
      armed = true;
      button.classList.add('is-armed');
      button.textContent = '✓';
      button.title = 'Click again to go ahead';
      timer = setTimeout(rest, 3000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    button.classList.remove('is-armed');
    button.textContent = label;
    const result = await act();
    if (result === false) {
      button.classList.add('is-error');
      setTimeout(rest, 2500);
    }
  });
  return { rest };
}

// Tooltips that name the thing and go away on their own. `title` sits there
// as long as the pointer does, which is the one thing the house rule says
// not to do, so it is removed on the way out of the two seconds.
function brief(el, text) {
  const read = () => (typeof text === 'function' ? text() : text);
  if (typeof text !== 'function') el.setAttribute('aria-label', text);
  el.addEventListener('mouseenter', () => {
    el.title = read();
    setTimeout(() => { el.title = ''; }, 1800);
  });
  el.addEventListener('mouseleave', () => { el.title = ''; });
}

// ---------------------------------------------------------------------------
// The i
// ---------------------------------------------------------------------------

// The body sits outside the <details> so it can be a flex child of the panel
// rather than trapped in the heading row. The details still owns the state.
function wireEye(detailsEl, bodyEl) {
  detailsEl.addEventListener('toggle', () => { bodyEl.hidden = !detailsEl.open; });
}
wireEye(document.querySelector('#view-all .eye'), els.eyeAllBody);
wireEye(document.querySelector('#view-mine .eye'), els.eyeMineBody);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const TABS = {
  all: { tab: els.tabAll, view: els.viewAll },
  mine: { tab: els.tabMine, view: els.viewMine },
};

function showView(name) {
  for (const [key, pair] of Object.entries(TABS)) {
    pair.view.hidden = key !== name;
  }
  els.viewJob.hidden = name !== 'job';
  if (!TABS[name]) return;
  // `mode` is where a finished job sends the user back to.
  state.mode = name;
  for (const [key, pair] of Object.entries(TABS)) {
    pair.tab.classList.toggle('is-on', key === name);
    pair.tab.setAttribute('aria-selected', String(key === name));
  }
}

for (const [key, pair] of Object.entries(TABS)) {
  pair.tab.addEventListener('click', () => showView(key));
}

// The tray menu names a destination. A job on screen is not interrupted for
// it: it finishes and lands the user back where they asked to be.
window.flat.onGoToTab((tab) => {
  if (!TABS[tab]) return;
  state.mode = tab;
  if (els.viewJob.hidden) showView(tab);
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

// A small, quiet tick beside a name, standing for one plain fact ("installed
// here", "on My apps"). It replaces the coloured pills this used to carry:
// the fact is worth knowing, not worth shouting. The words are in its
// tooltip and its accessible name, so it never relies on the shape alone.
function quietTick(label) {
  const mark = document.createElement('span');
  mark.className = 'quiet-tick';
  if (!label) {
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
  mark.title = label;
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', label);
  mark.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" '
    + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return mark;
}

function makeRow({ id, name, icon, sizeText, tick, title, checked, onToggle }) {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.id = id;
  li.dataset.search = `${name} ${id}`.toLowerCase();

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.setAttribute('aria-label', `Include ${name}`);
  box.addEventListener('change', () => onToggle(box.checked));
  li.appendChild(box);

  if (icon) {
    const img = document.createElement('img');
    img.className = 'row-icon';
    img.src = icon;
    img.alt = '';
    li.appendChild(img);
  } else {
    const blank = document.createElement('span');
    blank.className = 'row-icon row-icon--blank';
    blank.textContent = (name[0] || '?').toUpperCase();
    blank.setAttribute('aria-hidden', 'true');
    li.appendChild(blank);
  }

  li.appendChild(quietTick(tick));

  const text = document.createElement('div');
  text.className = 'row-text';
  const nameEl = document.createElement('div');
  nameEl.className = 'row-name';
  nameEl.textContent = name;
  const idEl = document.createElement('div');
  idEl.className = 'row-id';
  idEl.textContent = id;
  text.append(nameEl, idEl);
  li.appendChild(text);


  const size = document.createElement('div');
  size.className = 'row-size';
  size.textContent = sizeText;
  li.appendChild(size);

  // The whole row is the hit target, not just the 18px box.
  li.addEventListener('click', (event) => {
    if (event.target === box) return;
    box.checked = !box.checked;
    onToggle(box.checked);
  });

  if (title) li.title = title;
  return li;
}

function applyFilter(listEl, query) {
  const needle = query.trim().toLowerCase();
  for (const li of listEl.children) {
    li.hidden = needle ? !li.dataset.search.includes(needle) : false;
  }
}

// ---------------------------------------------------------------------------
// All apps: everything installed on this machine
// ---------------------------------------------------------------------------

// An app installed on this machine that has saved nothing outside its
// cache. Only knowable for apps that are here: for an app on the list but
// not on this machine, nobody can say, so it keeps its switch.
function noSettingsHere(id) {
  const app = state.apps.find((a) => a.id === (id || '').trim());
  return Boolean(app) && !app.hasSettings;
}

// Keep settings as it actually works out: an app with nothing to keep is
// Fresh whatever its switch last said.
function keeps(entry) {
  return Boolean(entry.keep) && !noSettingsHere(entry.id);
}

function onMineIds() {
  return new Set(state.mine.map((e) => (e.id || '').trim()).filter(Boolean));
}

function renderAllList() {
  els.allList.textContent = '';
  const onMine = onMineIds();
  for (const app of state.apps) {
    const row = makeRow({
      id: app.id,
      name: app.name,
      icon: app.icon,
      sizeText: app.hasSettings ? formatBytes(app.dataBytes) : 'No settings',
      tick: onMine.has(app.id) ? 'On My apps' : null,
      title: app.hasSettings ? 'Size of the settings and data it keeps' : 'Has saved nothing yet, so it would only ever install fresh',
      checked: state.allTicked.has(app.id),
      onToggle: (on) => {
        if (on) state.allTicked.add(app.id);
        else state.allTicked.delete(app.id);
        updateAllTally();
      },
    });
    els.allList.appendChild(row);
  }
  els.allEmpty.hidden = state.apps.length > 0;
  applyFilter(els.allList, els.filterAll.value);
}

function updateAllTally() {
  const ticked = state.apps.filter((a) => state.allTicked.has(a.id));
  const already = ticked.filter((a) => onMineIds().has(a.id)).length;
  els.allTally.textContent = ticked.length
    ? `${plural(ticked.length, 'app', 'apps')} ticked`
    : `${plural(state.apps.length, 'app', 'apps')} on this machine`;
  // What the button is about to do, on the page rather than behind the i.
  let hint = 'Tick the apps you want on My apps.';
  if (ticked.length && already === ticked.length) {
    hint = ticked.length === 1 ? 'That one is on My apps already.' : 'All of those are on My apps already.';
  } else if (already) {
    hint = `${already} of them ${already === 1 ? 'is' : 'are'} on My apps already. The rest arrive there as Fresh installs.`;
  } else if (ticked.length) {
    hint = 'They arrive on My apps as Fresh installs. Choose which keep their settings there.';
  }
  setHint(els.allHint, hint);
  els.allToMine.disabled = ticked.length === 0;
}

async function scanApps() {
  els.allLoading.hidden = false;
  els.allLoading.textContent = 'Looking at what is installed…';
  els.allList.textContent = '';

  // Sizes here are without caches: they are what the app keeps, and the
  // cache switch only matters to the backup, on My apps.
  const result = await window.flat.scanApps({ includeCache: false });
  els.allLoading.hidden = true;

  if (!result.ok) {
    els.allEmpty.hidden = false;
    els.allEmpty.textContent = result.error || 'Flatpak could not list what is installed.';
    return;
  }

  state.apps = result.apps;
  state.running = result.running || [];
  state.allTicked = new Set([...state.allTicked].filter((id) => result.apps.some((a) => a.id === id)));
  renderAllList();
  updateAllTally();
  if (state.mine.length) renderMine();
  updateMineTally();
}

window.flat.onScanProgress(({ done, total }) => {
  if (!els.allLoading.hidden) {
    els.allLoading.textContent = `Measuring what each app is holding… ${done} of ${total}`;
  }
});

els.filterAll.addEventListener('input', () => applyFilter(els.allList, els.filterAll.value));

// All means all: every app on the machine, data or not. With a filter typed
// in, it means every app the filter is showing, because ticking rows you
// cannot see is a surprise waiting to happen.
els.allSelectAll.addEventListener('click', () => {
  const visible = [...els.allList.children].filter((li) => !li.hidden).map((li) => li.dataset.id);
  for (const id of visible) state.allTicked.add(id);
  renderAllList(); updateAllTally();
});
els.allSelectNone.addEventListener('click', () => {
  state.allTicked = new Set();
  renderAllList(); updateAllTally();
});

els.allToMine.addEventListener('click', async () => {
  const chosen = state.apps.filter((a) => state.allTicked.has(a.id));
  if (!chosen.length) return;
  // Ticking an app and pressing Add is naming it on purpose, so it comes
  // across even if it was once removed from the list.
  const { added } = await addBatchToMine(
    chosen.map((a) => ({ id: a.id, name: a.name, remote: a.origin || 'flathub', installed: true })),
    'All apps',
    { explicit: true },
  );
  state.allTicked = new Set();
  renderAllList();
  updateAllTally();
  say(els.allHint, added
    ? `${plural(added, 'app', 'apps')} added to My apps as Fresh installs.`
    : 'Those are all on My apps already.');
});

// ---------------------------------------------------------------------------
// Backing up the Keep settings apps, from My apps
// ---------------------------------------------------------------------------

// The Keep settings apps that can actually be backed up here: on this
// machine, and holding something to back up.
function keepAppsHere() {
  const keep = new Set(uniqueWanted().filter(keeps).map((e) => e.id));
  return state.apps.filter((a) => keep.has(a.id) && a.hasSettings);
}

function openKeepApps() {
  const ids = new Set(keepAppsHere().map((a) => a.id));
  return state.running.filter((id) => ids.has(id));
}

function nameOf(id) {
  return (state.apps.find((a) => a.id === id) || {}).name || id;
}

// Shown only once a backup has been asked for and something was open, and
// then until it is dealt with. Before that it would be nagging about apps
// nobody is trying to back up yet.
function updateRunningWarning() {
  const clash = state.backupBlocked ? openKeepApps() : [];
  if (!clash.length) {
    if (state.backupBlocked && !els.runningWarning.hidden) {
      say(els.mineHint, 'Everything is closed now. Press Back up settings again.');
    }
    state.backupBlocked = false;
    els.runningWarning.hidden = true;
    return;
  }
  const names = clash.map(nameOf);
  els.runningWarningText.textContent = names.length === 1
    ? `Please close ${names[0]} before backing up.`
    : `Please close ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} before backing up.`;
  els.runningWarning.hidden = false;
}

// Looks again at what is running: when asked, when the window comes back
// into focus after you have been off closing something, and every few
// seconds while the warning is up.
async function recheckRunning({ quiet = false } = {}) {
  const before = openKeepApps();
  state.running = await window.flat.runningApps();
  const still = openKeepApps();
  updateRunningWarning();
  if (quiet) return;
  const closed = before.filter((id) => !still.includes(id)).map(nameOf);
  if (still.length) {
    say(els.mineHint, `Still open: ${still.map(nameOf).join(', ')}. Some apps keep running in the background after their window closes.`);
  } else if (closed.length) {
    say(els.mineHint, `${closed.join(', ')} ${closed.length === 1 ? 'is' : 'are'} closed now. Press Back up settings again.`);
  }
}

els.recheckRunning.addEventListener('click', () => recheckRunning());

window.addEventListener('focus', () => {
  if (!els.runningWarning.hidden) recheckRunning({ quiet: true });
});

setInterval(() => {
  if (!els.runningWarning.hidden) recheckRunning({ quiet: true });
}, 4000);

arming(els.closeRunning, 'Close them for me', async () => {
  const result = await window.flat.closeApps(openKeepApps());
  state.running = await window.flat.runningApps();
  updateRunningWarning();
  return result.ok;
});

els.mineBackup.addEventListener('click', async () => {
  const keeping = uniqueWanted().filter(keeps);
  if (!keeping.length) {
    say(els.mineHint, 'Nothing is marked Keep settings, so there is nothing to back up. Fresh apps need no backup.');
    return;
  }
  const here = keepAppsHere();
  if (!here.length) {
    say(els.mineHint, 'None of your Keep settings apps has any settings on this machine to back up.');
    return;
  }

  // Not a step further while any of them is open.
  state.running = await window.flat.runningApps();
  state.backupBlocked = true;
  updateRunningWarning();
  if (!els.runningWarning.hidden) return;

  const target = await window.flat.chooseBackupFile();
  if (target.canceled) return;

  startJob('Backing up', here.map((a) => ({ id: a.id, name: a.name })));
  const result = await window.flat.runBackup({
    apps: here.map((a) => ({
      id: a.id, name: a.name, branch: a.branch, arch: a.arch,
      origin: a.origin, scope: a.scope, dataBytes: a.dataBytes,
    })),
    includeCache: els.includeCache.checked,
    outFile: target.file,
  });

  if (!result.ok) {
    finishJob({ head: 'Backup failed', summary: result.error, bad: true });
    return;
  }

  state.lastBackupFile = result.file;
  for (const entry of result.log || []) noteOnJobRow(entry.message, entry.level);

  // Keep settings apps that could not be packed are named, not dropped
  // silently: on the new machine they would come back fresh.
  const left = keeping.length - here.length;
  finishJob({
    head: 'Backup finished',
    summary: `${plural(result.apps, 'app', 'apps')} saved · ${formatBytes(result.bytes)}`,
    hint: left
      ? `${plural(left, 'Keep settings app is', 'Keep settings apps are')} not on this machine or keep nothing yet, so ${left === 1 ? 'it was' : 'they were'} left out. ${result.file}`
      : result.file,
    reveal: true,
  });

  // The file just made is the obvious one for the settings to come from.
  const described = await window.flat.settingsBackupDescribe(result.file);
  if (described && described.ok) {
    state.settingsBackup = described;
    showSettingsBackup();
  }
});

// ---------------------------------------------------------------------------
// The job view
// ---------------------------------------------------------------------------

function startJob(head, apps) {
  els.jobHead.textContent = head;
  els.jobCount.textContent = '';
  els.jobList.textContent = '';
  els.jobFootbar.hidden = true;
  els.jobReveal.hidden = true;
  els.jobProgressWrap.hidden = false;
  els.jobProgressFill.style.width = '0%';
  els.jobLine.textContent = 'Starting…';
  state.jobRows = new Map();

  for (const app of apps) {
    const li = document.createElement('li');
    li.className = 'jobrow';
    li.dataset.state = 'waiting';

    const mark = document.createElement('span');
    mark.className = 'jobrow-mark';
    mark.textContent = '·';

    const text = document.createElement('div');
    text.className = 'jobrow-text';
    const name = document.createElement('div');
    name.className = 'jobrow-name';
    name.textContent = app.name;
    text.appendChild(name);

    li.append(mark, text);
    els.jobList.appendChild(li);
    state.jobRows.set(app.id, { li, mark, text });
  }

  showView('job');
}

function markJobRow(id, kind, message) {
  const row = state.jobRows.get(id);
  if (!row) return;
  row.li.dataset.state = kind;
  row.mark.textContent = kind === 'ok' ? '✓' : kind === 'failed' ? '!' : '·';
  if (message) {
    const note = document.createElement('div');
    note.className = kind === 'failed' ? 'jobrow-note jobrow-note--bad' : 'jobrow-note';
    note.textContent = message;
    row.text.appendChild(note);
  }
}

function addJobNote(id, text, bad) {
  const row = state.jobRows.get(id);
  if (!row) return;
  const note = document.createElement('div');
  note.className = bad ? 'jobrow-note jobrow-note--bad' : 'jobrow-note';
  note.textContent = text;
  row.text.appendChild(note);
}

// A row that has already been given a note must not collect a second one
// saying the same thing when the final results arrive.
function noteOnce(id, kind, message) {
  const row = state.jobRows.get(id);
  if (!row || row.noted) return;
  row.noted = true;
  markJobRow(id, kind, message);
}

// A note with no id belongs to whichever row is on screen last — used for
// the backup log, which is a flat list of warnings rather than per app.
function noteOnJobRow(message, level, id) {
  if (id) {
    const row = state.jobRows.get(id);
    if (row) {
      const note = document.createElement('div');
      note.className = 'jobrow-note';
      note.textContent = message;
      row.text.appendChild(note);
      return;
    }
  }
  const li = document.createElement('li');
  li.className = 'jobrow';
  li.dataset.state = level === 'error' ? 'failed' : 'waiting';
  const mark = document.createElement('span');
  mark.className = 'jobrow-mark';
  mark.textContent = level === 'error' ? '!' : 'i';
  const text = document.createElement('div');
  text.className = 'jobrow-text';
  const note = document.createElement('div');
  note.className = level === 'error' ? 'jobrow-note jobrow-note--bad' : 'jobrow-note';
  note.textContent = message;
  text.appendChild(note);
  li.append(mark, text);
  els.jobList.appendChild(li);
}

window.flat.onJobProgress(({ index, total, appId, step, message }) => {
  if (total) {
    const settled = step === 'done' || step === 'failed' || step === 'skipped';
    const fraction = Math.min(1, (index + (settled ? 1 : 0.5)) / total);
    els.jobProgressFill.style.width = `${Math.round(fraction * 100)}%`;
    els.jobCount.textContent = `${Math.min(index + 1, total)} of ${total}`;
  }
  els.jobLine.textContent = message || '';
  if (!appId) return;
  const row = state.jobRows.get(appId);
  if (!row) return;
  if (step === 'done') markJobRow(appId, 'ok');
  else if (step === 'failed') noteOnce(appId, 'failed', message);
  else if (step === 'skipped') noteOnce(appId, 'skipped', 'Already here, so it was left alone');
  // The settings pass runs on apps already installed and ticked green. It
  // shows as working while it runs and goes back to its tick after; the
  // outcome is added as a note once the run has finished.
  else if (step === 'settings') row.li.dataset.state = 'working';
  else if (step === 'settings-done' || step === 'settings-failed') row.li.dataset.state = 'ok';
  else row.li.dataset.state = 'working';
});

function finishJob({ head, summary, hint, reveal, bad }) {
  els.jobHead.textContent = head;
  els.jobProgressFill.style.width = '100%';
  els.jobProgressWrap.hidden = true;
  els.jobSummary.textContent = summary || '';
  els.jobSummaryHint.textContent = hint || '';
  els.jobReveal.hidden = !reveal;
  els.jobFootbar.hidden = false;
  if (bad) els.jobCount.textContent = '';
}

els.jobReveal.addEventListener('click', () => {
  if (state.lastBackupFile) window.flat.revealFile(state.lastBackupFile);
});

els.jobDone.addEventListener('click', async () => {
  // Back to where the button was pressed from, with what has changed since
  // looked at again.
  showView(state.mode);
  await loadMine();
  await scanApps();
});


// ---------------------------------------------------------------------------
// My apps: the standing list, and installing it onto a bare machine
// ---------------------------------------------------------------------------

// Same shape the main process validates against. Checked here too so a typo
// shows itself in the field being typed into rather than as a failure three
// screens later.
const APP_ID = /^[A-Za-z][A-Za-z0-9-_]*(\.[A-Za-z0-9-_]+){2,}$/;

// The same app twice is a list that says one thing and installs another, so
// the second copy is marked rather than quietly ignored.
function duplicateIds() {
  const seen = new Set();
  const twice = new Set();
  for (const entry of state.mine) {
    const id = (entry.id || '').trim();
    if (!id) continue;
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return twice;
}

function renderMine() {
  els.mineList.textContent = '';
  const dupes = duplicateIds();

  for (const entry of state.mine) {
    const li = document.createElement('li');
    li.className = 'editrow';
    li.dataset.id = entry.id;
    li.classList.toggle('is-ticked', state.mineTicked.has(entry));

    const tickWrap = document.createElement('label');
    tickWrap.className = 'tick';
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = state.mineTicked.has(entry);
    tick.setAttribute('aria-label', `Tick ${entry.name || entry.id || 'this row'}`);
    tick.addEventListener('change', () => {
      if (tick.checked) state.mineTicked.add(entry);
      else state.mineTicked.delete(entry);
      li.classList.toggle('is-ticked', tick.checked);
      updateTicks();
    });
    tickWrap.appendChild(tick);

    const keepCell = document.createElement('div');
    keepCell.className = 'keepcell';
    // Nothing saved here means nothing to keep, so there is no switch to
    // flick on in the belief that it was forgotten — just the plain fact.
    const empty = noSettingsHere(entry.id);
    if (empty) {
      const none = document.createElement('span');
      none.className = 'no-settings';
      none.textContent = 'No settings';
      none.title = 'This app has saved nothing on this machine, so it installs fresh';
      keepCell.appendChild(none);
    }
    const keepLabel = document.createElement('label');
    keepLabel.className = 'switch';
    const keepBox = document.createElement('input');
    keepBox.type = 'checkbox';
    keepBox.setAttribute('role', 'switch');
    keepBox.checked = Boolean(entry.keep);
    keepBox.setAttribute('aria-label', `Keep the settings of ${entry.name || entry.id || 'this app'}`);
    const keepTrack = document.createElement('span');
    keepTrack.className = 'track';
    keepLabel.append(keepBox, keepTrack);
    if (!empty) keepCell.appendChild(keepLabel);
    // A switch applies immediately; nothing waits for a Save button.
    keepBox.addEventListener('change', () => {
      entry.keep = keepBox.checked;
      showSettingsBackup();
      saveMineNow(true);
    });

    const name = document.createElement('input');
    name.className = 'cell cell--name';
    name.value = entry.name || '';
    name.placeholder = 'What you call it';
    name.setAttribute('aria-label', 'App name');

    const id = document.createElement('input');
    id.className = 'cell cell--id';
    id.value = entry.id || '';
    id.placeholder = 'org.example.App';
    id.spellcheck = false;
    id.setAttribute('aria-label', 'App ID');

    const remote = document.createElement('input');
    remote.className = 'cell cell--remote';
    remote.value = entry.remote || 'flathub';
    remote.placeholder = 'flathub';
    remote.spellcheck = false;
    remote.setAttribute('aria-label', 'Remote');

    const tag = quietTick(entry.installed ? 'Installed on this machine' : null);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'drop';
    drop.textContent = '\u00d7';
    brief(drop, `Remove ${entry.name || entry.id}`);

    const markId = () => {
      const value = id.value.trim();
      const bad = Boolean(value) && (!APP_ID.test(value) || duplicateIds().has(value));
      id.classList.toggle('is-bad', bad);
    };
    markId();

    // Auto-save: no Save button anywhere on this screen.
    const edit = () => {
      entry.name = name.value;
      entry.id = id.value.trim();
      entry.remote = remote.value.trim() || 'flathub';
      markId();
      updateMineTally();
      saveMineSoon();
    };
    if (dupes.has((entry.id || '').trim())) id.classList.add('is-bad');
    name.addEventListener('input', edit);
    id.addEventListener('input', edit);
    remote.addEventListener('input', edit);

    // Two-click removal, per the Morphic Button standard: the first click
    // shows a tick and asks, and stands back down on its own.
    let armed = false;
    let timer = null;
    drop.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        drop.classList.add('is-armed');
        drop.textContent = '\u2713';
        timer = setTimeout(() => {
          armed = false;
          drop.classList.remove('is-armed');
          drop.textContent = '\u00d7';
        }, 3000);
        return;
      }
      clearTimeout(timer);
      const gone = (entry.id || '').trim();
      if (gone) state.mineNever.add(gone);
      state.mine = state.mine.filter((e) => e !== entry);
      state.mineTicked.delete(entry);
      renderMine();
      updateMineTally();
      saveMineNow();
    });

    li.append(tickWrap, tag, name, id, remote, keepCell, drop);
    els.mineList.appendChild(li);
  }

  els.mineEmpty.hidden = state.mine.length > 0;
  els.mineAll.closest('.colhead').hidden = state.mine.length === 0;
  updateTicks();
}

// ---- ticking, and doing something with what is ticked ------------------------

function updateTicks() {
  // A row that has gone keeps no tick.
  for (const entry of [...state.mineTicked]) {
    if (!state.mine.includes(entry)) state.mineTicked.delete(entry);
  }
  const ticked = state.mineTicked.size;
  const total = state.mine.length;
  els.mineAll.checked = total > 0 && ticked === total;
  els.mineAll.indeterminate = ticked > 0 && ticked < total;
  els.mineAllLabel.textContent = ticked ? `${ticked}` : 'All';
  els.mineBulk.hidden = ticked === 0;
  els.mineBulkCount.textContent = `${plural(ticked, 'app', 'apps')} ticked`;
}

els.mineAll.addEventListener('change', () => {
  state.mineTicked = els.mineAll.checked ? new Set(state.mine) : new Set();
  renderMine();
});

function markTicked(keep) {
  let passed = 0;
  let count = 0;
  for (const entry of state.mineTicked) {
    if (keep && noSettingsHere(entry.id)) { passed += 1; continue; }
    entry.keep = keep;
    count += 1;
  }
  state.mineTicked = new Set();
  renderMine();
  showSettingsBackup();
  saveMineNow(true);
  say(els.mineHint, keep
    ? `${plural(count, 'app', 'apps')} will keep their settings.${passed ? ` ${passed} with no settings stay fresh.` : ''}`
    : `${plural(count, 'app', 'apps')} will install fresh.`);
}

els.mineBulkKeep.addEventListener('click', () => markTicked(true));
els.mineBulkFresh.addEventListener('click', () => markTicked(false));

// Removing several at once is the same decision as removing one, so it
// takes the same two clicks, and each removed app is remembered the same way.
arming(els.mineBulkRemove, 'Remove', async () => {
  const count = state.mineTicked.size;
  for (const entry of state.mineTicked) {
    const gone = (entry.id || '').trim();
    if (gone) state.mineNever.add(gone);
  }
  state.mine = state.mine.filter((e) => !state.mineTicked.has(e));
  state.mineTicked = new Set();
  renderMine();
  updateMineTally();
  await saveMineNow(true);
  say(els.mineHint, `${plural(count, 'app', 'apps')} removed from the list.`);
  return true;
});

function updateMineTally() {
  const valid = uniqueWanted();
  const missing = valid.filter((e) => !e.installed);
  const broken = state.mine.length - valid.length;

  const keeping = valid.filter(keeps).length;
  els.mineTally.textContent = state.mine.length
    ? `${plural(state.mine.length, 'app', 'apps')} on the list · ${keeping} keep settings · ${missing.length} not here yet`
    : 'Nothing on the list';

  // What the button is about to do stays on the page, never behind the i.
  if (broken) {
    setHint(els.mineHint, `${plural(broken, 'row is', 'rows are')} a repeat or not a valid app ID, and will be skipped.`);
  } else if (missing.length) {
    const keepingMissing = missing.filter(keeps).length;
    setHint(els.mineHint, keepingMissing && !state.settingsBackup
      ? `${keepingMissing} of these keep settings, but no backup is chosen, so they would install fresh.`
      : 'Anything already on this machine is left alone, settings and all.');
  } else if (state.mine.length) {
    setHint(els.mineHint, 'Everything on the list is already here.');
  } else {
    setHint(els.mineHint, 'Search above, or start from what this machine already has.');
  }

  els.mineInstall.textContent = missing.length ? `Install ${missing.length}` : 'Install';
  els.mineInstall.disabled = missing.length === 0;
}

// Saving is debounced because these are auto-save fields and every keystroke
// would otherwise be a write and a toast.
let saveTimer = null;
function saveMineSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveMineNow, 800);
}

async function saveMineNow(quiet) {
  clearTimeout(saveTimer);
  const result = await window.flat.listWrite({
    apps: state.mine.map(({ id, name, remote, keep }) => ({ id, name, remote, keep: Boolean(keep) })),
    never: [...state.mineNever],
  });
  if (result && result.ok) {
    state.mineSource = 'saved';
    state.mineNever = new Set(result.never || []);
    els.mineForget.hidden = state.mineNever.size === 0;
    if (!quiet) say(els.mineHint, 'Saved');
  }
}

// One entry per id, valid ids only — the same set the install uses, so the
// count on the button is the count that happens.
function uniqueWanted() {
  const seen = new Set();
  const out = [];
  for (const entry of state.mine) {
    const id = (entry.id || '').trim();
    if (!APP_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

// `explicit` is a person naming this one app. That always wins, and it
// cancels an earlier removal. A bulk add is not explicit, so it respects
// what has been taken off before.
function addToMine(entry, { explicit = false } = {}) {
  const id = (entry.id || '').trim();
  if (!id || state.mine.some((e) => e.id === id)) return false;
  if (!explicit && state.mineNever.has(id)) return false;
  state.mineNever.delete(id);
  state.mine.push({
    id,
    name: entry.name || id,
    remote: entry.remote || 'flathub',
    installed: Boolean(entry.installed),
    keep: Boolean(entry.keep),
  });
  return true;
}

// Adds a batch from somewhere else in the app and says what happened, in
// words rather than a silent count that does not add up.
// `keep`: the batch comes from somewhere about settings — the Back up or
// Restore tab — so every app in it is marked Keep settings, including ones
// that were already on the list as Fresh. Ticking an app on those tabs and
// sending it here is saying "this one's settings matter".
async function addBatchToMine(entries, where, { explicit = false } = {}) {
  let added = 0;
  let held = 0;
  const marked = 0;
  for (const entry of entries) {
    const id = (entry.id || '').trim();
    if (state.mine.some((e) => e.id === id)) continue;
    if (addToMine({ ...entry, keep: false }, { explicit })) added += 1;
    else if (state.mineNever.has(id)) held += 1;
  }
  renderMine();
  updateMineTally();
  // `quiet`: the sentence below is the notification, so the save does not
  // need one of its own on top of it.
  if (added || marked) await saveMineNow(true);

  let done = added
    ? `${plural(added, 'app', 'apps')} added to My apps`
    : 'Nothing new to add';
  if (marked) done += `, ${marked} more marked Keep settings`;
  const heldNote = held
    ? ` ${plural(held, 'app you had removed was', 'apps you had removed were')} left out.`
    : '';
  say(els.mineHint, `${done} from ${where}.${heldNote}`);
  return { added, held, marked, done, heldNote };
}

async function loadMine() {
  const loaded = await window.flat.listRead();
  state.mine = loaded.apps;
  state.mineNever = new Set(loaded.never || []);
  state.mineSource = loaded.source;
  els.mineForget.hidden = state.mineNever.size === 0;
  els.flathubWarning.hidden = loaded.hasFlathub;
  els.minePortableName.textContent = loaded.portableName;
  renderMine();
  updateMineTally();
  await findSettingsBackup();
}

// --- searching for something to add -----------------------------------------

let searchTimer = null;
els.mineSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const term = els.mineSearch.value.trim();
  if (term.length < 2) {
    els.mineResults.hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    const found = await window.flat.listSearch(term);
    renderResults(found);
  }, 350);
});

function renderResults(found) {
  els.mineResults.textContent = '';
  if (!found.length) {
    els.mineResults.hidden = true;
    return;
  }
  for (const hit of found) {
    const li = document.createElement('li');
    li.className = 'result';
    const already = state.mine.some((e) => e.id === hit.id);
    li.dataset.on = String(already);

    const text = document.createElement('div');
    text.className = 'result-text';
    const name = document.createElement('div');
    name.className = 'result-name';
    name.textContent = hit.name;
    const sub = document.createElement('div');
    sub.className = 'result-sub';
    sub.textContent = hit.description ? `${hit.id} — ${hit.description}` : hit.id;
    text.append(name, sub);

    const add = document.createElement('span');
    add.className = 'result-add';
    add.textContent = already ? 'on the list' : 'Add';

    li.append(text, add);
    li.addEventListener('click', () => {
      if (li.dataset.on === 'true') return;
      addToMine(hit, { explicit: true });
      li.dataset.on = 'true';
      add.textContent = 'on the list';
      renderMine();
      updateMineTally();
      saveMineNow();
    });
    els.mineResults.appendChild(li);
  }
  els.mineResults.hidden = false;
}

// --- filling and moving the list --------------------------------------------

els.mineAddBlank.addEventListener('click', () => {
  // A blank row is a person about to name something, so whatever they type
  // into it counts as explicit and clears any earlier removal of that id.
  state.mine.push({ id: '', name: '', remote: 'flathub', installed: false });
  renderMine();
  updateMineTally();
  const rows = els.mineList.querySelectorAll('.editrow');
  const last = rows[rows.length - 1];
  if (last) last.querySelector('.cell--name').focus();
});

els.mineFromInstalled.addEventListener('click', async () => {
  const installed = await window.flat.listFromInstalled();
  await addBatchToMine(installed.map((e) => ({ ...e, installed: true })), 'this machine');
});

// A Reset, and it hides itself when there is nothing to reset: a button that
// does nothing when pressed is one you stop trusting.
arming(els.mineForget, 'Forget removals', async () => {
  state.mineNever = new Set();
  await saveMineNow();
  say(els.mineHint, 'Removals forgotten. A batch add will bring those apps back.');
  return true;
});

els.mineExport.addEventListener('click', async () => {
  const result = await window.flat.listExport({
    apps: state.mine.map(({ id, name, remote, keep }) => ({ id, name, remote, keep: Boolean(keep) })),
    never: [...state.mineNever],
  });
  if (result.canceled) return;
  if (result.error) {
    setHint(els.mineHint, result.error);
    return;
  }
  say(els.mineHint, `List saved to ${result.file}`);
});

els.mineImport.addEventListener('click', async () => {
  const result = await window.flat.listImport();
  if (result.canceled) return;
  if (!result.ok) {
    setHint(els.mineHint, result.error);
    return;
  }
  for (const id of result.never || []) state.mineNever.add(id);
  for (const entry of result.apps) addToMine(entry, { explicit: true });
  await saveMineNow();
  await loadMine();
});

arming(els.addFlathub, 'Add Flathub', async () => {
  const result = await window.flat.addFlathub();
  if (!result.ok) return false;
  await loadMine();
  return true;
});

// --- installing --------------------------------------------------------------

els.mineInstall.addEventListener('click', async () => {
  // The whole list goes down, not just the missing part. The ones already
  // here are named as they are passed over, so the run accounts for every
  // app on the list rather than quietly showing a shorter one.
  const wanted = uniqueWanted();
  if (!wanted.some((e) => !e.installed)) return;

  startJob('Installing', wanted.map((e) => ({ id: e.id, name: e.name || e.id })));
  const result = await window.flat.installApps({
    apps: wanted.map(({ id, name, remote, keep }) => ({ id, name, remote, keep: Boolean(keep) })),
    packFile: state.settingsBackup ? state.settingsBackup.file : null,
  });

  if (!result.ok) {
    finishJob({ head: 'Install failed', summary: result.error, bad: true });
    return;
  }

  for (const entry of result.results) {
    if (entry.skipped) noteOnce(entry.id, 'skipped', 'Already here, so it was left alone');
    else if (!entry.ok) noteOnce(entry.id, 'failed', entry.error);
  }
  for (const [id, note] of Object.entries(result.settingsNotes || {})) {
    addJobNote(id, note.text, note.bad);
  }

  const parts = [`${plural(result.succeeded, 'app', 'apps')} installed`];
  if (result.settingsRestored) parts.push(`${result.settingsRestored} with settings back`);
  if (result.skipped) parts.push(`${result.skipped} already here`);
  if (result.failed) parts.push(`${result.failed} failed`);

  const problems = result.failed || result.settingsMissed;
  finishJob({
    head: problems ? 'Finished, with problems' : 'Finished',
    summary: parts.join(' \u00b7 '),
    hint: result.failed
      ? 'A failure is usually a wrong ID, or a remote that does not carry that app.'
      : result.settingsMissed
        ? `${plural(result.settingsMissed, 'app', 'apps')} marked Keep settings went on fresh — each row says why.`
        : 'Sign in again anywhere an app kept its login in the system keyring.',
    bad: Boolean(problems),
  });
});

// ---- the backup the Keep settings apps draw on --------------------------------

function showSettingsBackup() {
  const b = state.settingsBackup;
  els.mineSourceText.textContent = '';
  if (!b) {
    els.mineSourceText.textContent = 'No backup found. Keep settings apps would install fresh.';
    els.mineSourceChoose.textContent = 'Choose a backup…';
    updateMineTally();
    return;
  }
  const keepers = state.mine.filter(keeps);
  const covered = keepers.filter((e) => b.ids.includes(e.id)).length;
  const strong = document.createElement('strong');
  strong.textContent = b.name;
  const when = b.created ? new Date(b.created).toLocaleDateString() : '';
  els.mineSourceText.append(
    'Settings come from ', strong,
    `${b.host ? `, made on ${b.host}` : ''}${when ? ` on ${when}` : ''}.`,
    keepers.length ? ` It holds ${covered} of your ${keepers.length} Keep settings apps.` : '',
  );
  els.mineSourceChoose.textContent = 'Choose another…';
  updateMineTally();
}

async function findSettingsBackup() {
  state.settingsBackup = await window.flat.settingsBackupFind();
  showSettingsBackup();
}

els.mineSourceChoose.addEventListener('click', async () => {
  const chosen = await window.flat.settingsBackupChoose();
  if (chosen.canceled) return;
  if (!chosen.ok) {
    say(els.mineHint, chosen.error);
    return;
  }
  state.settingsBackup = chosen;
  showSettingsBackup();
});

// ---------------------------------------------------------------------------
// Update widget, to the update-widget spec: one 16px dot, five colours, and
// a one-per-second pulse whenever it is working.
// ---------------------------------------------------------------------------

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
els.updateDotRingFill.style.strokeDasharray = String(RING_CIRCUMFERENCE);

// The spec's own words, where it gives them.
const UPDATE_DOT_LABELS = {
  current: 'up to date',
  checking: 'checking for an update',
  available: 'update available — click to download',
  downloading: 'downloading',
  downloaded: 'click to restart',
  installing: 'restarting',
  error: "can't connect to GitHub — click to try again",
};

// The dot is working, not waiting for you, in these.
const INERT_STATES = ['checking', 'downloading', 'installing'];
const PULSING_STATES = ['checking', 'installing'];

let updateState = null;
let updateLabel = '';

function setUpdateDot(nextState, overrideLabel) {
  updateState = nextState;
  els.updateDot.dataset.state = nextState;
  els.updateDot.classList.toggle('is-pulsing', PULSING_STATES.includes(nextState));
  els.updateDot.setAttribute('aria-disabled', String(INERT_STATES.includes(nextState)));
  updateLabel = overrideLabel || UPDATE_DOT_LABELS[nextState] || '';
  els.updateDot.setAttribute('aria-label', updateLabel);
}

function setRingProgress(fraction) {
  const offset = RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, fraction)));
  els.updateDotRingFill.style.strokeDashoffset = String(offset);
}

// Every state has a hover tooltip naming it. It reads the label at the
// moment of hovering, so it is never the state from a minute ago, and it
// clears itself inside two seconds like every other tooltip in the app.
brief(els.updateDot, () => updateLabel);

function applyUpdateState(next) {
  if (next.status === 'none') setUpdateDot('current');
  else if (next.status === 'available') setUpdateDot('available');
  else if (next.status === 'downloading') {
    setUpdateDot('downloading');
    setRingProgress(next.percent / 100);
  } else if (next.status === 'downloaded') {
    setRingProgress(1);
    setUpdateDot('downloaded');
  } else if (next.status === 'error') setUpdateDot('error');
}

// A manual check pulses at least three times — three seconds at one a
// second — and keeps pulsing if the check takes longer. The minimum is there
// so a fast answer still reads as "it looked", not as a flicker.
const MIN_CHECK_MS = 3000;
const NO_UPDATE_NOTE_MS = 3000;
let checking = false;
let queuedState = null;

async function runManualCheck() {
  checking = true;
  queuedState = null;
  setUpdateDot('checking');

  const minimum = new Promise((resolve) => setTimeout(resolve, MIN_CHECK_MS));
  const result = await window.flat.updateCheck();
  await minimum;

  checking = false;
  if (queuedState) {
    const answer = queuedState;
    queuedState = null;
    if (answer.status === 'none') {
      noUpdateFound();
    } else {
      applyUpdateState(answer);
    }
  } else if (result && result.error) {
    setUpdateDot('error');
  } else {
    noUpdateFound();
  }
}

// "no update available", briefly, then back to plain "up to date".
function noUpdateFound() {
  setUpdateDot('current', 'no update available');
  setTimeout(() => {
    if (updateState === 'current') setUpdateDot('current');
  }, NO_UPDATE_NOTE_MS);
}

window.flat.onUpdateState((next) => {
  if (checking) queuedState = next;
  else if (updateState !== 'installing') applyUpdateState(next);
});

// The dot is on screen from the first moment, never popping in later. Until
// the startup check answers it is checking, so it pulses — a still dot while
// it looks would say nothing is happening. If the answer came in before the
// page was listening, it is picked up here rather than lost.
async function startUpdateDot() {
  setUpdateDot('checking');
  const known = await window.flat.updateStateGet();
  if (known && updateState === 'checking') applyUpdateState(known);
}

els.updateDot.addEventListener('click', async () => {
  if (checking || INERT_STATES.includes(updateState)) return;
  if (updateState === 'current' || updateState === 'error') {
    await runManualCheck();
  } else if (updateState === 'available') {
    setRingProgress(0);
    setUpdateDot('downloading');
    await window.flat.updateDownload();
  } else if (updateState === 'downloaded') {
    // Pulses from here until the app goes down to restart. No fixed count.
    setUpdateDot('installing');
    const result = await window.flat.updateInstall();
    if (result && result.error) {
      // Could not restart right now (a job is running). Say why in the
      // dot's own label, then drop back to the plain "ready" wording.
      setUpdateDot('downloaded', result.error);
      setTimeout(() => {
        if (updateState === 'downloaded') setUpdateDot('downloaded');
      }, 6000);
    }
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async function start() {
  const info = await window.flat.appInfo();
  els.updateWidgetVersion.textContent = `v${info.version}`;
  startUpdateDot();

  const probe = await window.flat.probe();
  if (!probe.present) {
    els.viewAll.hidden = true;
    els.viewMine.hidden = true;
    els.blocker.hidden = false;
    els.blockerBody.textContent =
      'Flat works by driving the flatpak command, and it is not on this machine. '
      + 'Nothing can be listed, backed up or installed until it is there.';
    els.tabAll.disabled = true;
    els.tabMine.disabled = true;
    return;
  }

  await loadMine();
  await scanApps();
}());
