'use strict';

// The order in this file is the whole point of the app.
//
//   remote → install → close the app → wipe the generated directory →
//   extract → chown → overrides
//
// Every one of those steps is there because skipping it produces the same
// symptom: the app opens on the new machine as a brand new install with
// none of the settings, and nothing anywhere says why.
//
//   Restoring before installing      Flatpak creates the directory on first
//                                    install and the restored copy is gone.
//   Launching it once first          Same thing, from the other direction.
//   Copying without preserving       Ownership and permissions are lost and
//                                    the app quietly falls back to a new
//                                    profile rather than reporting an error.
//   A different UID on the new box   The profile is unreadable, so again a
//                                    silent fresh start. chown is mandatory,
//                                    not tidiness.

const fs = require('fs');
const path = require('path');
const fp = require('./flatpak');
const ar = require('./archive');

async function chownToCurrentUser(dir) {
  const result = await fp.run('chown', ['-R', `${process.getuid()}:${process.getgid()}`, dir], {
    timeout: 600000,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function remoteFor(manifest, origin) {
  return (manifest.remotes || []).find((r) => r.name === origin) || null;
}

// manifest:   the pack's manifest
// selection:  array of app ids to restore
// onProgress: ({ index, total, appId, step, message })
async function runRestore({ packFile, manifest, selection, verify = true }, onProgress) {
  const emit = (payload) => { if (onProgress) onProgress(payload); };
  const chosen = (manifest.apps || []).filter((a) => selection.includes(a.id));
  const total = chosen.length;
  const results = [];
  const stage = ar.makeTempStage('restore');

  const running = new Set(await fp.runningApps());

  // The global override file is a machine-wide setting, so it is offered
  // once rather than per app, and only when the pack carried one.
  if (manifest.has_global_override) {
    const text = await ar.readMemberText(packFile, 'overrides/global');
    if (text) {
      try {
        fs.mkdirSync(fp.USER_OVERRIDES, { recursive: true });
        fs.writeFileSync(path.join(fp.USER_OVERRIDES, 'global'), text, 'utf8');
      } catch { /* a global override is a nicety, not the job */ }
    }
  }

  try {
    fs.mkdirSync(fp.VAR_APP, { recursive: true });

    for (let index = 0; index < chosen.length; index += 1) {
      const app = chosen[index];
      const notes = [];
      const fail = (message) => {
        results.push({ id: app.id, name: app.name, ok: false, error: message, notes });
        emit({ index, total, appId: app.id, step: 'failed', message });
      };

      // 1. The remote it came from, and at user scope specifically — a
      // remote that exists only system-wide cannot be named by the --user
      // install that comes next.
      emit({ index, total, appId: app.id, step: 'remote', message: `Checking the ${app.origin} remote` });
      const recorded = remoteFor(manifest, app.origin);
      const ready = await fp.ensureUserRemote(app.origin, recorded && recorded.url);
      if (!ready.ok) {
        fail(`Could not set up the ${app.origin} remote: ${ready.error}`);
        continue;
      }
      if (ready.added) {
        notes.push(ready.remote === app.origin
          ? `Added the ${app.origin} remote`
          : `Added ${app.origin} at user scope as ${ready.remote}, so nothing already called ${app.origin} on this machine changes meaning.`);
      }

      // 2. Install, before any data goes anywhere near the disk.
      emit({ index, total, appId: app.id, step: 'install', message: `Installing ${app.name}` });
      const already = await fp.isInstalled(app.id);
      if (!already) {
        const install = await fp.installApp({
          id: app.id,
          remote: app.origin,
          branch: app.branch,
          remoteUrl: recorded && recorded.url,
        });
        if (!install.ok) {
          fail(`Install failed: ${install.error}`);
          continue;
        }
        if (install.fellBack) {
          notes.push(`The ${app.branch} branch was not available here, so the default branch was installed instead.`);
        }
      } else {
        notes.push('Already installed here, so the existing copy was kept.');
      }

      // 3. Nothing may be holding the directory open.
      if (running.has(app.id)) {
        emit({ index, total, appId: app.id, step: 'closing', message: `Closing ${app.name}` });
        await fp.killApp(app.id);
        running.delete(app.id);
        // flatpak kill returns as soon as the signal is sent; give the
        // process a moment to actually let go of its profile lock.
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      // 4. Pull the blob out and check it is the one that was packed.
      emit({ index, total, appId: app.id, step: 'extracting', message: `Unpacking ${app.name}` });
      const member = await ar.extractMember({ packFile, member: app.blob, destDir: stage });
      if (!member.ok) {
        fail(`Could not read this app's data out of the pack: ${member.error}`);
        continue;
      }
      if (verify && app.sha256) {
        const digest = await ar.sha256File(member.file);
        if (digest !== app.sha256) {
          fail('The data in the pack does not match its checksum, so it was not restored.');
          try { fs.rmSync(member.file, { force: true }); } catch { /* temp file */ }
          continue;
        }
      }

      // 5. Only now does the freshly generated directory go.
      const target = fp.dataDir(app.id);
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (error) {
        fail(`Could not clear the new empty data directory: ${error.message}`);
        continue;
      }

      const unpacked = await ar.unpackAppData({ blobFile: member.file, parentDir: fp.VAR_APP });
      try { fs.rmSync(member.file, { force: true }); } catch { /* temp file */ }
      if (!unpacked.ok) {
        fail(`Unpacking failed: ${unpacked.error}`);
        continue;
      }

      // 6. The UID on this machine is almost certainly not the UID on the old one.
      emit({ index, total, appId: app.id, step: 'ownership', message: `Fixing ownership for ${app.name}` });
      const owned = await chownToCurrentUser(target);
      if (!owned.ok) {
        fail(`Ownership could not be set, so the app would have started with an empty profile: ${owned.error}`);
        continue;
      }

      // 7. Permissions.
      emit({ index, total, appId: app.id, step: 'permissions', message: `Restoring permissions for ${app.name}` });
      if (app.has_overrides) {
        const text = await ar.readMemberText(packFile, `overrides/app/${app.id}`);
        if (text) {
          try {
            fp.writeOverrideFile(app.id, text);
          } catch (error) {
            notes.push(`Permissions were not restored: ${error.message}`);
          }
        } else {
          notes.push('The pack said this app had permission overrides but they were missing from it.');
        }
      } else if (Array.isArray(app.permissions) && app.permissions.length) {
        // No overrides file existed on the old machine, so the app was
        // running on its own defaults. Those defaults can differ between
        // builds, so only write anything when they actually differ here.
        const hereRaw = await fp.showPermissions(app.id);
        const here = fp.permissionsToArgs(hereRaw).slice().sort().join('\n');
        const there = app.permissions.slice().sort().join('\n');
        if (here !== there) {
          const applied = await fp.applyOverrideArgs(app.id, app.permissions);
          if (applied.ok) {
            notes.push('This build asks for different permissions, so the old ones were reapplied.');
          } else {
            notes.push(`Permissions differ from the old machine and could not be reapplied: ${applied.error}`);
          }
        }
      }

      results.push({ id: app.id, name: app.name, ok: true, notes });
      emit({ index, total, appId: app.id, step: 'done', message: `${app.name} restored` });
    }

    return {
      ok: true,
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  } catch (error) {
    return { ok: false, error: error.message, results };
  } finally {
    ar.removeStage(stage);
  }
}

module.exports = { runRestore };
