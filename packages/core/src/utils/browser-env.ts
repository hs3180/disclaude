import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { devNull } from 'node:os';
/** Keep transport discovery private to the coordinator in coordinated mode.
 * This is cooperative routing, not a same-user security boundary.
 * Call after all provider/task environment merges, immediately before spawning.
 */
export function browserAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const socket = env.DISCLAUDE_BROWSER_SOCKET;
  if (!socket) { return env; }
  if (!isAbsolute(socket)) {
    throw new Error('Coordinated browser environment requires an absolute IPC socket; refusing direct browser fallback');
  }
  const result = { ...env };
  const launcherDir = join(dirname(socket), 'bin');
  result.PATH = [launcherDir, ...(env.PATH ?? '').split(delimiter).filter(p => p && p !== launcherDir)].join(delimiter);
  for (const key of Object.keys(result)) {
    if (
      key.startsWith('BU_CDP_') ||
      key.startsWith('CHROMIUM_CDP_') ||
      key.startsWith('DISCLAUDE_CHROMIUM_') ||
      (key.startsWith('DISCLAUDE_BROWSER_') && key !== 'DISCLAUDE_BROWSER_SOCKET') ||
      [
        'BU_AUTOSPAWN',
        'BU_NAME',
        'BH_RUNTIME_DIR',
        'BH_TMP_DIR',
        'BH_RUNTIME_DIR_SHARED',
        'BH_TMP_DIR_SHARED',
        'BH_REQUIRE_EXISTING_DAEMON',
      ].includes(key)
    ) {
      delete result[key];
    }
  }
  // An accidentally selected upstream CLI must not discover the user's default
  // daemon. The null device is never a directory, even after our broker exits;
  // browser-harness fails before importing its runtime or auto-starting anything.
  // The coordinator's worker supplies its own private runtime separately.
  result.BH_RUNTIME_DIR = devNull;
  result.BH_TMP_DIR = devNull;
  result.BH_REQUIRE_EXISTING_DAEMON = '1';
  return result;
}
