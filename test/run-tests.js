'use strict';

// Plain node, no framework. Everything here runs without Electron and
// without touching the real ~/.var/app.
//
//   npm test

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fp = require('../src/main/flatpak');
const ar = require('../src/main/archive');
const applist = require('../src/main/applist');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------

test('permissions become override flags, negations included', () => {
  const args = fp.permissionsToArgs([
    '[Context]',
    'shared=network;ipc;',
    'sockets=x11;pulseaudio;!wayland;',
    'devices=dri;',
    'filesystems=home;xdg-download;!host;',
    '',
    '[Session Bus Policy]',
    'org.freedesktop.Notifications=talk',
    'org.example.Own=own',
    '',
    '[Environment]',
    'MOZ_ENABLE_WAYLAND=1',
  ].join('\n'));

  assert.ok(args.includes('--share=network'));
  assert.ok(args.includes('--share=ipc'));
  assert.ok(args.includes('--socket=x11'));
  assert.ok(args.includes('--nosocket=wayland'), 'a ! entry must become the "no" flag');
  assert.ok(args.includes('--device=dri'));
  assert.ok(args.includes('--filesystem=home'));
  assert.ok(args.includes('--nofilesystem=host'));
  assert.ok(args.includes('--talk-name=org.freedesktop.Notifications'));
  assert.ok(args.includes('--own-name=org.example.Own'));
  assert.ok(args.includes('--env=MOZ_ENABLE_WAYLAND=1'));
});

test('a permission dump with nothing in it produces no flags', () => {
  assert.deepStrictEqual(fp.permissionsToArgs(''), []);
  assert.deepStrictEqual(fp.permissionsToArgs('[Context]\n'), []);
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

test('a pack seals, reads back its manifest, and round-trips a data directory', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-test-'));
  try {
    // A stand-in for ~/.var/app holding one app.
    const varApp = path.join(work, 'var-app');
    const appId = 'com.example.Thing';
    fs.mkdirSync(path.join(varApp, appId, 'config'), { recursive: true });
    fs.mkdirSync(path.join(varApp, appId, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(varApp, appId, 'config', 'prefs.js'), 'user_pref("kept", true);\n');
    fs.writeFileSync(path.join(varApp, appId, 'cache', 'junk.bin'), Buffer.alloc(4096, 7));

    const stage = path.join(work, 'stage');
    fs.mkdirSync(path.join(stage, 'apps'), { recursive: true });

    const compressor = await ar.detectCompressor();
    const blobName = `apps/${appId}.${compressor.ext}`;
    const packed = await ar.packAppData({
      id: appId,
      parentDir: varApp,
      outFile: path.join(stage, blobName),
      includeCache: false,
    });
    assert.ok(packed.ok, `packing failed: ${packed.error}`);

    const sha256 = await ar.sha256File(path.join(stage, blobName));
    assert.match(sha256, /^[0-9a-f]{64}$/);

    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
      format_version: ar.FORMAT_VERSION,
      created: new Date().toISOString(),
      source_host: 'test',
      remotes: [{ name: 'flathub', url: 'https://dl.flathub.org/repo/', options: 'system' }],
      apps: [{ id: appId, name: 'Thing', blob: blobName, sha256, branch: 'stable', origin: 'flathub' }],
    }, null, 2));

    const packFile = path.join(work, 'test.fmpack');
    const sealed = await ar.sealPack({ stageDir: stage, outFile: packFile });
    assert.ok(sealed.ok, `sealing failed: ${sealed.error}`);

    // Reading it back.
    const read = await ar.readManifest(packFile);
    assert.ok(read.ok, read.error);
    assert.strictEqual(read.manifest.apps[0].id, appId);

    // Pulling one app out on its own, which is the whole reason the outer
    // tar is not itself compressed.
    const out = path.join(work, 'out');
    fs.mkdirSync(out);
    const member = await ar.extractMember({ packFile, member: blobName, destDir: out });
    assert.ok(member.ok, member.error);
    assert.strictEqual(await ar.sha256File(member.file), sha256, 'the blob must survive the outer tar unchanged');

    const dest = path.join(work, 'restored');
    fs.mkdirSync(dest);
    const unpacked = await ar.unpackAppData({ blobFile: member.file, parentDir: dest });
    assert.ok(unpacked.ok, unpacked.error);

    assert.strictEqual(
      fs.readFileSync(path.join(dest, appId, 'config', 'prefs.js'), 'utf8'),
      'user_pref("kept", true);\n',
    );
    assert.ok(!fs.existsSync(path.join(dest, appId, 'cache')), 'the cache must be excluded');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a file that is not a pack is refused rather than half-read', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-test-'));
  try {
    const notAPack = path.join(work, 'holiday.jpg');
    fs.writeFileSync(notAPack, Buffer.alloc(2048, 0x42));
    const read = await ar.readManifest(notAPack);
    assert.strictEqual(read.ok, false);
    assert.match(read.error, /Flat backup/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

test('the standing list refuses anything that is not an app ID', () => {
  const cleaned = applist.cleanEntries([
    { id: 'org.mozilla.firefox', name: 'Firefox' },
    { id: 'firefox' },                              // not reverse DNS
    { id: 'org.mozilla' },                          // too few parts
    { id: 'org.mozilla.firefox; rm -rf ~', name: 'nope' },
    { id: '--delete-data', name: 'nope' },
    { id: 'org.mozilla.firefox', name: 'duplicate' },
    null,
    'a string',
  ]);
  assert.strictEqual(cleaned.length, 1);
  assert.strictEqual(cleaned[0].id, 'org.mozilla.firefox');
  assert.strictEqual(cleaned[0].name, 'Firefox');
  assert.strictEqual(cleaned[0].remote, 'flathub', 'the remote defaults rather than going missing');
});

test('a silly remote name falls back rather than reaching the CLI', () => {
  const cleaned = applist.cleanEntries([
    { id: 'org.mozilla.firefox', remote: '--user /etc' },
    { id: 'md.obsidian.Obsidian', remote: 'my-remote' },
  ]);
  assert.strictEqual(cleaned[0].remote, 'flathub');
  assert.strictEqual(cleaned[1].remote, 'my-remote');
});

test('a list saves, comes back, and travels as a file beside the AppImage', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-list-'));
  try {
    const settingsDir = path.join(work, 'settings');
    const beside = path.join(work, 'beside');
    fs.mkdirSync(beside, { recursive: true });

    // Nothing anywhere yet.
    assert.strictEqual(applist.load({ settingsDir, searchDirs: [beside] }).source, 'empty');

    // A list dropped next to the AppImage is found on a machine that has
    // never run Flat before — the whole fresh-install trick.
    applist.writeTo(path.join(beside, applist.PORTABLE_NAME), [
      { id: 'org.mozilla.firefox', name: 'Firefox' },
      { id: 'md.obsidian.Obsidian', name: 'Obsidian', remote: 'flathub' },
    ]);
    const portable = applist.load({ settingsDir, searchDirs: [beside] });
    assert.strictEqual(portable.source, 'portable');
    assert.strictEqual(portable.apps.length, 2);

    // Once saved, the app's own copy wins over the file beside it.
    applist.save({ settingsDir }, [{ id: 'com.bitwarden.desktop', name: 'Bitwarden' }]);
    const saved = applist.load({ settingsDir, searchDirs: [beside] });
    assert.strictEqual(saved.source, 'saved');
    assert.deepStrictEqual(saved.apps.map((a) => a.id), ['com.bitwarden.desktop']);

    // And a file that is not a list says so instead of loading nothing.
    const junk = path.join(work, 'junk.json');
    fs.writeFileSync(junk, '{"hello": true}');
    assert.strictEqual(applist.readFrom(junk).ok, false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('an app taken off on purpose is remembered, and travels with the list', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-never-'));
  try {
    const settingsDir = path.join(work, 'settings');

    applist.save({ settingsDir },
      [{ id: 'org.mozilla.firefox', name: 'Firefox' }],
      ['fr.handbrake.ghb', 'org.gnome.Calculator']);

    const back = applist.load({ settingsDir, searchDirs: [] });
    assert.deepStrictEqual(back.apps.map((a) => a.id), ['org.mozilla.firefox']);
    assert.deepStrictEqual(back.never.sort(), ['fr.handbrake.ghb', 'org.gnome.Calculator']);

    // Exported and read back somewhere else, the removals come too.
    const file = path.join(work, applist.PORTABLE_NAME);
    applist.writeTo(file, back.apps, back.never);
    const read = applist.readFrom(file);
    assert.strictEqual(read.ok, true);
    assert.deepStrictEqual(read.never.sort(), ['fr.handbrake.ghb', 'org.gnome.Calculator']);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('an app cannot be both wanted and never wanted', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-never-'));
  try {
    const settingsDir = path.join(work, 'settings');
    // Putting it back on the list is the later, more deliberate act, so the
    // stale removal is dropped rather than quietly cancelling the add.
    const saved = applist.save({ settingsDir },
      [{ id: 'fr.handbrake.ghb', name: 'HandBrake' }],
      ['fr.handbrake.ghb']);
    assert.deepStrictEqual(saved.apps.map((a) => a.id), ['fr.handbrake.ghb']);
    assert.deepStrictEqual(saved.never, []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a list file holding only removals still loads', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-never-'));
  try {
    const file = path.join(work, applist.PORTABLE_NAME);
    applist.writeTo(file, [], ['fr.handbrake.ghb']);
    const read = applist.readFrom(file);
    assert.strictEqual(read.ok, true);
    assert.deepStrictEqual(read.apps, []);
    assert.deepStrictEqual(read.never, ['fr.handbrake.ghb']);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Keep settings is only ever a real yes, and survives saving', () => {
  const cleaned = applist.cleanEntries([
    { id: 'org.mozilla.firefox', keep: true },
    { id: 'com.brave.Browser', keep: 'yes' },
    { id: 'org.gnome.Loupe' },
  ]);
  assert.deepStrictEqual(cleaned.map((a) => a.keep), [true, false, false]);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-keep-'));
  try {
    const settingsDir = path.join(work, 'settings');
    applist.save({ settingsDir }, cleaned, []);
    const back = applist.load({ settingsDir, searchDirs: [] });
    assert.deepStrictEqual(back.apps.map((a) => [a.id, a.keep]), [
      ['org.mozilla.firefox', true], ['com.brave.Browser', false], ['org.gnome.Loupe', false],
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a switch someone flicked is remembered as their choice', () => {
  const cleaned = applist.cleanEntries([
    { id: 'org.mozilla.firefox', keep: false, keepChosen: true },
    { id: 'com.brave.Browser', keep: false },
    { id: 'org.gnome.Loupe', keep: true, keepChosen: 'yes' },
  ]);
  assert.deepStrictEqual(cleaned.map((a) => [a.keep, a.keepChosen]), [[false, true], [false, false], [true, false]]);
});

test('a browser backup leaves out what the browser rebuilds, and keeps what is yours', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-trim-'));
  const put = (rel, bytes = 1000) => {
    const file = path.join(work, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  };
  try {
    // Laid out like Charlie's real Brave folder on 19 September 2026.
    const brave = 'config/BraveSoftware/Brave-Browser';
    put(`${brave}/Local State`, 100);
    put(`${brave}/Default/Preferences`, 100);
    put(`${brave}/Default/Bookmarks`, 500);
    put(`${brave}/Default/Login Data`, 500);
    put(`${brave}/Default/History`, 500);
    put(`${brave}/Default/Extensions/nngceckbapebfimnlniiiahkandclblb/2.1/main.js`, 40000);
    put(`${brave}/Default/Local Extension Settings/nngceckbapebfimnlniiiahkandclblb/000003.log`, 2000);
    put(`${brave}/Default/IndexedDB/https_example.com_0.indexeddb.leveldb/1.log`, 3000);
    put(`${brave}/Default/Service Worker/Database/MANIFEST`, 50);
    put(`${brave}/Default/Service Worker/CacheStorage/abc/index`, 20000);
    put(`${brave}/Default/Service Worker/ScriptCache/index`, 5000);
    put(`${brave}/Default/adblock_cache/list`, 1100);
    put(`${brave}/Default/GPUCache/data_1`, 90);
    put(`${brave}/extensions_crx_cache/one.crx`, 8900);
    put(`${brave}/component_crx_cache/two.crx`, 3200);
    put(`${brave}/Safe Browsing/list`, 1900);
    put(`${brave}/aoojcmojmmcbpfgoecoadbdpnagfchel/1.0/list.dat`, 1800);
    put('cache/BraveSoftware/Brave-Browser/Default/Cache/data', 7000);

    const out = fp.throwawayPaths(work);
    const has = (rel) => out.includes(rel);
    // Left out.
    for (const rel of [`${brave}/Default/Service Worker/CacheStorage`, `${brave}/Default/Service Worker/ScriptCache`,
      `${brave}/Default/adblock_cache`, `${brave}/Default/GPUCache`, `${brave}/extensions_crx_cache`,
      `${brave}/component_crx_cache`, `${brave}/Safe Browsing`, `${brave}/aoojcmojmmcbpfgoecoadbdpnagfchel`]) {
      assert.ok(has(rel), `should leave out ${rel}`);
    }
    // Kept: everything personal, and the extensions even though their
    // folders have the same kind of name as components.
    for (const rel of [`${brave}/Default/Extensions`, `${brave}/Default/Extensions/nngceckbapebfimnlniiiahkandclblb`,
      `${brave}/Default/Local Extension Settings`, `${brave}/Default/IndexedDB`, `${brave}/Default/Service Worker/Database`]) {
      assert.ok(!out.some((o) => rel === o || rel.startsWith(`${o}/`)), `must keep ${rel}`);
    }

    const sizes = await fp.settingsSizes('ignored', work);
    assert.ok(sizes.trimmable);
    assert.ok(sizes.trimmed < sizes.full / 2, `trimmed ${sizes.trimmed} should be well under full ${sizes.full}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a trimmed backup really leaves those folders out, spaces and all', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-pack-'));
  try {
    const id = 'com.example.Browser';
    const base = path.join(work, 'var-app', id);
    const put = (rel) => {
      const file = path.join(base, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
    };
    const b = 'config/Browser';
    for (const rel of [`${b}/Local State`, `${b}/Default/Preferences`, `${b}/Default/Bookmarks`,
      `${b}/Default/Service Worker/Database/MANIFEST`, `${b}/Default/Service Worker/CacheStorage/a`,
      `${b}/Safe Browsing/list`, 'cache/big']) put(rel);

    const leaveOut = fp.throwawayPaths(base);
    const out = path.join(work, 'blob.tar');
    const packed = await ar.packAppData({ id, parentDir: path.join(work, 'var-app'), outFile: out, leaveOut });
    assert.ok(packed.ok, packed.error);
    const listed = await fp.run('tar', ['-tf', out]);
    const names = listed.stdout.split('\n');
    const inside = (rel) => names.some((n) => n.replace(/\/$/, '') === `${id}/${rel}`);
    assert.ok(inside(`${b}/Default/Bookmarks`), 'bookmarks kept');
    assert.ok(inside(`${b}/Default/Service Worker/Database/MANIFEST`), 'service worker registrations kept');
    assert.ok(!inside(`${b}/Default/Service Worker/CacheStorage/a`), 'site offline copies left out');
    assert.ok(!inside(`${b}/Safe Browsing/list`), 'safe browsing list left out');
    assert.ok(!inside('cache/big'), 'cache left out');

    const fullOut = path.join(work, 'full.tar');
    await ar.packAppData({ id, parentDir: path.join(work, 'var-app'), outFile: fullOut, full: true });
    const fullNames = (await fp.run('tar', ['-tf', fullOut])).stdout;
    assert.ok(fullNames.includes(`${id}/cache/big`), 'full keeps the cache');
    assert.ok(fullNames.includes('Safe Browsing/list'), 'full keeps everything');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Firefox profiles lose their caches and keep the profile', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-trim-'));
  const put = (rel) => {
    const file = path.join(work, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  };
  try {
    const prof = '.mozilla/firefox/abcd1234.default-release';
    for (const rel of ['prefs.js', 'places.sqlite', 'logins.json', 'key4.db', 'cache2/entries/a',
      'startupCache/x', 'storage/default/https+++example.com/cache/morgue/1', 'storage/default/https+++example.com/idb/1.sqlite']) {
      put(`${prof}/${rel}`);
    }
    const out = fp.throwawayPaths(work);
    assert.ok(out.includes(`${prof}/cache2`));
    assert.ok(out.includes(`${prof}/startupCache`));
    assert.ok(out.includes(`${prof}/storage/default/https+++example.com/cache`));
    assert.ok(!out.some((o) => `${prof}/storage/default/https+++example.com/idb`.startsWith(o)));
    assert.ok(!out.some((o) => `${prof}/places.sqlite`.startsWith(o)));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('an app that is not a browser has nothing left out', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-trim-'));
  try {
    fs.mkdirSync(path.join(work, 'config', 'someapp'), { recursive: true });
    fs.writeFileSync(path.join(work, 'config', 'someapp', 'settings.ini'), 'a=1');
    assert.deepStrictEqual(fp.throwawayPaths(work), []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a list saved under the old Flatmorphic name is still found', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-oldname-'));
  try {
    const beside = path.join(work, 'beside');
    fs.mkdirSync(beside);
    applist.writeTo(path.join(beside, 'flatmorphic-apps.json'), [{ id: 'org.mozilla.firefox', name: 'Firefox' }], []);
    const found = applist.load({ settingsDir: path.join(work, 'settings'), searchDirs: [beside] });
    assert.strictEqual(found.source, 'portable');
    assert.deepStrictEqual(found.apps.map((a) => a.id), ['org.mozilla.firefox']);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('a backup file cannot slip anything past the checks into flatpak or tar', () => {
  const good = {
    id: 'org.mozilla.firefox', origin: 'flathub', branch: 'stable',
    blob: 'apps/org.mozilla.firefox.tar.zst', sha256: 'a'.repeat(64),
  };
  const cleaned = ar.cleanManifest({
    format_version: 1,
    remotes: [
      { name: 'flathub', url: 'https://dl.flathub.org/repo/' },
      { name: '--user', url: 'https://example.com/' },
      { name: 'odd', url: '--gpg-import=/etc/shadow' },
    ],
    apps: [
      good,
      { ...good, id: '--delete-data' },
      { ...good, id: 'org.evil.App', blob: 'apps/../../.bashrc' },
      { ...good, id: 'org.other.App', blob: 'apps/org.mozilla.firefox.tar.zst' },
      { ...good, id: 'org.a.B', blob: 'apps/org.a.B.tar.zst', origin: '--system' },
      { ...good, id: 'org.a.C', blob: 'apps/org.a.C.tar.zst', branch: 'stable/../x' },
      { ...good, id: 'org.a.D', blob: 'apps/org.a.D.tar.zst', sha256: 'not-a-hash' },
    ],
  });
  assert.deepStrictEqual(cleaned.apps.map((a) => a.id), ['org.mozilla.firefox']);
  assert.deepStrictEqual(cleaned.remotes.map((r) => r.name), ['flathub']);
  assert.strictEqual(cleaned.dropped.length, 6);
});

// ---------------------------------------------------------------------------

(async function main() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`  ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
    }
  }
  process.stdout.write(`\n${tests.length - failed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}());
