'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const fp = require('./flatpak');
const ar = require('./archive');

function sourceDistro() {
  // /etc/os-release is the only thing every distro agrees on. It is a record
  // for the person reading the manifest later, never something the restore
  // makes a decision from.
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const match = text.match(/^PRETTY_NAME="?(.*?)"?$/m);
    if (match) return match[1];
  } catch { /* fall through */ }
  return `${os.type()} ${os.release()}`;
}

function packName(hostname) {
  const date = new Date().toISOString().slice(0, 10);
  const safeHost = (hostname || 'machine').replace(/[^a-zA-Z0-9._-]/g, '-');
  return `flatpak-backup-${safeHost}-${date}.fmpack`;
}

// apps:       [{ id, name, branch, arch, origin, scope }]
// onProgress: ({ index, total, appId, step, message })
async function runBackup({ apps, includeCache, outFile }, onProgress) {
  const emit = (payload) => { if (onProgress) onProgress(payload); };
  const total = apps.length;
  const compressor = await ar.detectCompressor();
  const stage = ar.makeStage(outFile, 'backup');

  const log = [];
  const record = (level, message) => { log.push({ level, message }); };

  try {
    fs.mkdirSync(path.join(stage, 'apps'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'overrides', 'app'), { recursive: true });

    const manifestApps = [];

    for (let index = 0; index < apps.length; index += 1) {
      const app = apps[index];
      const blobName = `apps/${app.id}.${compressor.ext}`;
      const blobFile = path.join(stage, blobName);

      emit({ index, total, appId: app.id, step: 'packing', message: `Packing ${app.name}` });

      const packed = await ar.packAppData({
        id: app.id,
        parentDir: fp.VAR_APP,
        outFile: blobFile,
        includeCache,
      });

      if (!packed.ok) {
        record('error', `${app.name}: ${packed.error}`);
        emit({ index, total, appId: app.id, step: 'failed', message: packed.error });
        continue;
      }
      if (packed.warning) {
        record('warning', `${app.name}: ${packed.warning}. Close it and back up again if the restored copy misbehaves.`);
      }

      emit({ index, total, appId: app.id, step: 'hashing', message: `Checksumming ${app.name}` });
      const sha256 = await ar.sha256File(blobFile);
      const blobBytes = fs.statSync(blobFile).size;

      // Permissions, twice over. The overrides file is the thing that is put
      // back verbatim; the resolved set is the fallback for a restore where
      // no overrides file existed on this machine.
      const override = fp.readOverrideFile(app.id);
      if (override) {
        fs.writeFileSync(path.join(stage, 'overrides', 'app', app.id), override.text, 'utf8');
      }
      const permissionsRaw = await fp.showPermissions(app.id);

      manifestApps.push({
        id: app.id,
        name: app.name,
        branch: app.branch,
        arch: app.arch,
        origin: app.origin,
        scope: app.scope,
        data_bytes: app.dataBytes || 0,
        blob: blobName,
        blob_bytes: blobBytes,
        sha256,
        cache_included: Boolean(includeCache),
        has_overrides: Boolean(override),
        overrides_scope: override ? override.scope : null,
        permissions: fp.permissionsToArgs(permissionsRaw),
        permissions_raw: permissionsRaw,
      });

      emit({ index, total, appId: app.id, step: 'done', message: `${app.name} packed` });
    }

    const globalOverride = fp.readGlobalOverride();
    if (globalOverride) {
      fs.writeFileSync(path.join(stage, 'overrides', 'global'), globalOverride, 'utf8');
    }

    const flatpakInfo = await fp.probe();
    const manifest = {
      format_version: ar.FORMAT_VERSION,
      created: new Date().toISOString(),
      source_host: os.hostname(),
      source_distro: sourceDistro(),
      flatpak_version: flatpakInfo.version,
      compression: compressor.name,
      has_global_override: Boolean(globalOverride),
      remotes: await fp.listRemotes(),
      apps: manifestApps,
    };
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    emit({ index: total, total, appId: null, step: 'sealing', message: 'Writing the backup file' });
    const sealed = await ar.sealPack({ stageDir: stage, outFile });
    if (!sealed.ok) {
      return { ok: false, error: sealed.error, log };
    }

    const bytes = fs.statSync(outFile).size;
    return { ok: true, file: outFile, bytes, apps: manifestApps.length, log };
  } catch (error) {
    return { ok: false, error: error.message, log };
  } finally {
    ar.removeStage(stage);
  }
}

module.exports = { runBackup, packName, sourceDistro };
