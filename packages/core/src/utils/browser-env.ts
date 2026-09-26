import { createHash } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { devNull, homedir } from 'node:os';

/** Resolve the service-owned IPC path; it is derived, never user-configured. */
export function resolveBrowserSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configPath = env.DISCLAUDE_CONFIG_PATH
    ? resolve(env.DISCLAUDE_CONFIG_PATH)
    : join(env.HOME || homedir(), '.disclaude', 'disclaude.config.yaml');
  const owner = typeof process.getuid === 'function' ? String(process.getuid()) : env.USER || 'user';
  const identity = createHash('sha256').update(`${owner}\0${configPath}`).digest('hex').slice(0, 16);
  const runtimeRoot = env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : '/tmp';
  let socketPath = join(runtimeRoot, `dcb-${identity}`, 'browser.sock');
  if (Buffer.byteLength(socketPath) > 95) { socketPath = join('/tmp', `dcb-${identity}`, 'browser.sock'); }
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 95) {
    throw new Error('Could not derive a valid private browser IPC path');
  }
  return socketPath;
}

/** Keep transport discovery private to the coordinator in coordinated mode.
 * This is cooperative routing, not a same-user security boundary.
 * Call after all provider/task environment merges, immediately before spawning.
 * The socket environment value below is injected internally, not read as config.
 */
export function browserAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The service pins its endpoint before starting agents. Prefer that runtime
  // value over HOME/XDG/config values a provider-specific env merge may change.
  const socket = process.env.DISCLAUDE_BROWSER_SOCKET || resolveBrowserSocketPath(env);
  const result = { ...env };
  const previousSocket = env.DISCLAUDE_BROWSER_SOCKET;
  const previousLauncherDir = previousSocket && isAbsolute(previousSocket)
    ? join(dirname(previousSocket), 'bin')
    : undefined;
  if (env.DISCLAUDE_CONFIG_PATH) {
    // Agent commands run from the workspace; preserve the service's config
    // identity if the original --config value was relative.
    result.DISCLAUDE_CONFIG_PATH = resolve(env.DISCLAUDE_CONFIG_PATH);
  }
  result.DISCLAUDE_BROWSER_SOCKET = socket;
  const launcherDir = join(dirname(socket), 'bin');
  result.PATH = [launcherDir, ...(env.PATH ?? '').split(delimiter)
    .filter(p => p && p !== launcherDir && p !== previousLauncherDir)].join(delimiter);
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
