'use strict';

// The .fmpack file.
//
// Layout inside it:
//
//   manifest.json            what is in here, and how to put it back
//   overrides/global         the machine's global override file, if any
//   overrides/app/<app-id>   that app's own override file, if any
//   apps/<app-id>.tar.zst    that app's ~/.var/app directory
//
// The outer tar is deliberately NOT compressed and the per-app blobs inside
// it are. Two things need that. A restore onto a different machine usually
// wants some of the apps and not all of them, and a member of a plain tar
// can be pulled out on its own where a member of a solid compressed stream
// cannot. And the manifest carries a SHA-256 per app, which needs a per-app
// thing to hash. Nothing is lost by it: all the bulk still goes through
// zstd, just one directory at a time.

const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, runLong } = require('./flatpak');
const { isValidId, isValidRemote } = require('./applist');

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// A backup is a file that may have come from anywhere, so nothing in its
// manifest reaches `flatpak` or `tar` until it has been checked. An app
// entry that fails is dropped rather than repaired: an ID that starts with
// a dash, a remote that is not a plain name, a branch with a slash in it,
// or a data path that points anywhere but that app's own blob.
function cleanManifest(manifest) {
  const remotes = (Array.isArray(manifest.remotes) ? manifest.remotes : []).filter((r) => r
    && isValidRemote(r.name)
    && typeof r.url === 'string'
    && /^https?:\/\/[^\s]+$/.test(r.url));

  const dropped = [];
  const apps = (Array.isArray(manifest.apps) ? manifest.apps : []).filter((a) => {
    const ok = a
      && isValidId(a.id)
      && isValidRemote(a.origin)
      && BRANCH.test(String(a.branch || ''))
      && (a.blob === `apps/${a.id}.tar.zst` || a.blob === `apps/${a.id}.tar.gz`)
      && (a.sha256 === undefined || SHA256.test(a.sha256));
    if (!ok) dropped.push(a && typeof a.id === 'string' ? a.id.slice(0, 80) : '(unnamed)');
    return ok;
  });

  return { ...manifest, remotes, apps, dropped };
}

const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// Which compressor this machine actually has
// ---------------------------------------------------------------------------

let compressorPromise = null;

// Asking tar to do it, rather than asking whether `zstd` is on PATH: GNU tar
// shells out to the binary itself and some builds refuse --zstd even when
// the binary is present.
async function detectCompressor() {
  if (!compressorPromise) {
    compressorPromise = (async () => {
      const probe = await run('bash', ['-c',
        'printf x | tar --zstd -cf - -T /dev/null >/dev/null 2>&1 && echo yes || echo no',
      ], { timeout: 20000 });
      if (probe.stdout.trim() === 'yes') {
        return { flag: '--zstd', ext: 'tar.zst', name: 'zstd' };
      }
      return { flag: '--gzip', ext: 'tar.gz', name: 'gzip' };
    })();
  }
  return compressorPromise;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ---------------------------------------------------------------------------
// Attribute support
// ---------------------------------------------------------------------------

// --xattrs and --acls are what keep a restored profile behaving like the one
// that was backed up, but a tar built without ACL support errors out on the
// flag rather than ignoring it. Work out once which of them this tar takes.
let attrFlagsPromise = null;

async function attrFlags() {
  if (!attrFlagsPromise) {
    attrFlagsPromise = (async () => {
      const flags = [];
      for (const flag of ['--xattrs', '--acls']) {
        const probe = await run('bash', ['-c',
          `tar ${flag} -cf - -T /dev/null >/dev/null 2>&1 && echo yes || echo no`,
        ], { timeout: 20000 });
        if (probe.stdout.trim() === 'yes') flags.push(flag);
      }
      return flags;
    })();
  }
  return attrFlagsPromise;
}

// ---------------------------------------------------------------------------
// Packing one app's data directory
// ---------------------------------------------------------------------------

// `-C <parent> <app-id>` so the archive holds the directory by name and the
// restore side can drop it straight back into ~/.var/app on a machine where
// the home directory has a different path.
async function packAppData({ id, parentDir, outFile, includeCache }) {
  const compressor = await detectCompressor();
  const attrs = await attrFlags();
  const args = [compressor.flag, ...attrs, '-cpf', outFile];
  if (!includeCache) args.push(`--exclude=${id}/cache`);
  args.push('-C', parentDir, id);

  const result = await runLong('tar', args);
  // tar exit code 1 is "file changed as we read it" — worth saying out loud,
  // because on a live profile it is exactly the corruption this app exists
  // to avoid, but it is not a reason to throw the whole archive away.
  if (!result.ok && result.code !== 1) {
    return { ok: false, error: result.error || 'tar failed' };
  }
  return { ok: true, warning: result.code === 1 ? 'Some files changed while being read' : null };
}

async function unpackAppData({ blobFile, parentDir }) {
  const compressor = await detectCompressor();
  const attrs = await attrFlags();
  const args = [compressor.flag, ...attrs, '-xpf', blobFile, '-C', parentDir];
  const result = await runLong('tar', args);
  if (!result.ok && result.code !== 1) {
    return { ok: false, error: result.error || 'tar failed' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The outer container
// ---------------------------------------------------------------------------

// Built from a staging directory so the member names inside the pack are
// exactly the layout above, whatever the staging directory is called.
async function sealPack({ stageDir, outFile }) {
  const members = fs.readdirSync(stageDir);
  const result = await runLong('tar', ['-cf', outFile, '-C', stageDir, ...members]);
  if (!result.ok) return { ok: false, error: result.error || 'tar failed' };
  return { ok: true };
}

async function readManifest(packFile) {
  const result = await run('tar', ['-xOf', packFile, 'manifest.json'], { timeout: 120000 });
  if (!result.ok || !result.stdout.trim()) {
    return { ok: false, error: 'This file does not look like a Flat backup.' };
  }
  try {
    const manifest = JSON.parse(result.stdout);
    if (!manifest || manifest.format_version !== FORMAT_VERSION) {
      return { ok: false, error: `This pack is format version ${manifest && manifest.format_version}, and this build reads version ${FORMAT_VERSION}.` };
    }
    return { ok: true, manifest: cleanManifest(manifest) };
  } catch {
    return { ok: false, error: 'The pack is damaged: its manifest could not be read.' };
  }
}

// Pull a single named member out into a directory. Used one app at a time
// during a restore so a fifty-gigabyte pack never has to land on disk twice.
async function extractMember({ packFile, member, destDir }) {
  const result = await runLong('tar', ['-xf', packFile, '-C', destDir, member]);
  if (!result.ok) return { ok: false, error: result.error || `${member} is not in the pack` };
  return { ok: true, file: path.join(destDir, member) };
}

async function readMemberText(packFile, member) {
  const result = await run('tar', ['-xOf', packFile, member], { timeout: 120000 });
  return result.ok ? result.stdout : null;
}

// ---------------------------------------------------------------------------
// Scratch space
// ---------------------------------------------------------------------------

// Next to the pack rather than in /tmp: /tmp is a tmpfs on most desktops and
// a browser profile will not fit in RAM.
function makeStage(nearFile, label) {
  const base = path.dirname(nearFile);
  const dir = fs.mkdtempSync(path.join(base, `.flat-${label}-`));
  return dir;
}

function makeTempStage(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `flat-${label}-`));
}

function removeStage(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* nothing to do about it, and it is a temp directory */ }
}

module.exports = {
  FORMAT_VERSION,
  cleanManifest,
  detectCompressor,
  attrFlags,
  sha256File,
  packAppData,
  unpackAppData,
  sealPack,
  readManifest,
  extractMember,
  readMemberText,
  makeStage,
  makeTempStage,
  removeStage,
};
