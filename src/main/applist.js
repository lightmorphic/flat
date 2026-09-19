'use strict';

// The standing list of apps someone wants on any machine they sit down at.
//
// This is the "fresh install" half of Flat. A backup restores what a
// previous machine had; this list installs what he always wants, whether or
// not a backup is to hand.
//
// Where the list comes from, in order, the first one that exists winning:
//
//   1. the saved list in the app's own settings directory
//   2. `flat-apps.json` sitting beside the AppImage, or in the
//      directory it was launched from
//   3. nothing — an empty list with the buttons to fill it
//
// Step 2 is the one that matters on a fresh install: download the AppImage
// and the little list file into the same folder, open it, press the button.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'my-apps.json';
const PORTABLE_NAME = 'flat-apps.json';
// The name the list file had before the app was renamed from Flatmorphic to
// Flat on 18 September 2026. Still looked for, so a list already sitting on
// a server or a USB stick keeps working.
const OLD_PORTABLE_NAMES = ['flatmorphic-apps.json'];
const FORMAT_VERSION = 1;

// A Flatpak application id: reverse DNS, at least two dots' worth of parts.
// Checked because these strings are handed to `flatpak install` as
// arguments, and because a typo is easier to see here than in a failure
// three screens later.
const APP_ID = /^[A-Za-z][A-Za-z0-9-_]*(\.[A-Za-z0-9-_]+){2,}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidId(id) {
  return typeof id === 'string' && id.length <= 255 && APP_ID.test(id);
}

function isValidRemote(name) {
  return typeof name === 'string' && name.length <= 64 && REMOTE_NAME.test(name);
}

function cleanIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x || '').trim()).filter(isValidId))];
}

// Anything the file says is treated as untrusted: it is a text file a person
// edits by hand, and a bad row must drop out rather than reach the CLI.
function cleanEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!isValidId(id) || seen.has(id)) continue;
    const remote = String(item.remote || 'flathub').trim();
    seen.add(id);
    out.push({
      id,
      name: String(item.name || id).trim().slice(0, 120) || id,
      remote: isValidRemote(remote) ? remote : 'flathub',
      // "Keep settings" means: back this app's settings up, and bring them
      // back on the new machine. Only a real `true` counts, so a hand-edited
      // "yes" does not quietly overwrite anything.
      keep: item.keep === true,
      // Whether that was a person's choice. Until it is, an app with settings
      // on this machine keeps them by default; once someone has switched it,
      // their switch stands.
      keepChosen: item.keepChosen === true,
      // Back up the whole folder, cache and all, rather than leaving out
      // what the app rebuilds by itself. Off unless someone ticked it.
      full: item.full === true,
    });
  }
  return out;
}

// `never` is the list of apps taken off on purpose. It travels with the file
// because "I never want this one" is a decision about the list, not about one
// machine, and a bulk add on a new machine would otherwise put them all back.
function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const apps = cleanEntries(parsed.apps);
    const never = cleanIds(parsed.never);
    if (!apps.length && !never.length) return null;
    return { apps, never };
  } catch {
    return null;
  }
}

// `appDir` is where the AppImage lives, `launchDir` where it was run from.
// Both are searched because a file manager launches from one and a terminal
// from the other, and nobody should have to know which.
function findPortable(searchDirs) {
  for (const dir of searchDirs) {
    if (!dir) continue;
    for (const name of [PORTABLE_NAME, ...OLD_PORTABLE_NAMES]) {
      const file = path.join(dir, name);
      const read = readFile(file);
      if (read) return { ...read, file };
    }
  }
  return null;
}

function load({ settingsDir, searchDirs = [] }) {
  const saved = path.join(settingsDir, FILE_NAME);
  const own = readFile(saved);
  if (own) return { ...own, source: 'saved', file: saved };

  const portable = findPortable(searchDirs);
  if (portable) {
    return { apps: portable.apps, never: portable.never, source: 'portable', file: portable.file };
  }

  return { apps: [], never: [], source: 'empty', file: saved };
}

function contents(apps, never) {
  const clean = cleanEntries(apps);
  const onList = new Set(clean.map((a) => a.id));
  return {
    format_version: FORMAT_VERSION,
    updated: new Date().toISOString(),
    apps: clean,
    // An app cannot be both wanted and never wanted. Being on the list wins,
    // because putting it there is the more recent, more deliberate act.
    never: cleanIds(never).filter((id) => !onList.has(id)),
  };
}

function save({ settingsDir }, apps, never) {
  const file = path.join(settingsDir, FILE_NAME);
  const body = contents(apps, never);
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return { ok: true, apps: body.apps, never: body.never, file };
}

function writeTo(file, apps, never) {
  fs.writeFileSync(file, `${JSON.stringify(contents(apps, never), null, 2)}\n`, 'utf8');
  return { ok: true, file };
}

function readFrom(file) {
  const read = readFile(file);
  if (!read) return { ok: false, error: 'That file does not hold a Flat app list.' };
  return { ok: true, apps: read.apps, never: read.never };
}

module.exports = {
  FILE_NAME,
  PORTABLE_NAME,
  FORMAT_VERSION,
  isValidId,
  isValidRemote,
  cleanEntries,
  load,
  save,
  writeTo,
  readFrom,
};
