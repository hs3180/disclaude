/** Read-only selected-browser metadata; never opens or modifies a profile. */
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function smallText(path) {
  if (statSync(path).size > 65536) throw new Error('Metadata exceeds the status read limit');
  return readFileSync(path, 'utf8');
}
export function describeChromiumSelection(environment = {}) {
  const path = environment.CHROMIUM_CDP_BINARY;
  const executable = { path: path || null, available: false, source: { kind: 'existing-executable' } };
  if (path) {
    try { accessSync(path, constants.X_OK); executable.realPath = realpathSync(path); executable.available = true; } catch {}
    // Only attribute a recorded snapshot when the selected executable matches its layout.
    let directory = dirname(executable.realPath || path);
    for (let depth = 0; depth < 7; depth++, directory = dirname(directory)) {
      const recordPath = join(directory, 'verification.json');
      if (!existsSync(recordPath)) continue;
      try {
        const record = JSON.parse(smallText(recordPath));
        const relative = record.platform === 'Linux_x64' ? 'payload/chrome-linux/chrome'
          : ['Mac', 'Mac_Arm'].includes(record.platform) ? 'payload/chrome-mac/Chromium.app/Contents/MacOS/Chromium' : null;
        if (record.version === 1 && relative && resolve(directory, relative) === executable.realPath &&
          /^https:\/\/commondatastorage\.googleapis\.com\/chromium-browser-snapshots\//.test(record.url || '')) {
          executable.source = { kind: 'chromium-snapshot', url: record.url, revision: record.revision,
            recordedBrowserVersion: record.browserVersion, signature: record.signature?.status,
            verifiedAt: record.verifiedAt, recordPath, payloadRevalidatedByStatus: false };
        }
      } catch (error) { executable.source.metadataError = error.message; }
      break;
    }
  }
  const profile = { path: environment.CHROMIUM_CDP_PROFILE_DIR || null, lastVersion: null, lockPresent: false };
  if (profile.path) {
    try { profile.lastVersion = smallText(join(profile.path, 'Last Version')).trim(); } catch {}
    try { lstatSync(join(profile.path, 'SingletonLock')); profile.lockPresent = true; } catch {}
  }
  const address = environment.CHROMIUM_CDP_ADDRESS || '127.0.0.1';
  const port = environment.CHROMIUM_CDP_PORT || '9222';
  return { executable, profile, endpoint: `http://${address}:${port}`,
    mode: environment.CHROMIUM_CDP_HEADED === '0' ? 'headless' : 'headed' };
}
