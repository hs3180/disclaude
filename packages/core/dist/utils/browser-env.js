import { delimiter } from 'node:path';
import { devNull } from 'node:os';
/** Keep transport discovery private to the coordinator in coordinated mode.
 * This is cooperative routing, not a same-user security boundary.
 * Call after all provider/task environment merges, immediately before spawning.
 */
export function browserAgentEnv(env = process.env) {
    if (!env.DISCLAUDE_BROWSER_SOCKET) {
        if (env.DISCLAUDE_BROWSER_MODE === 'coordinated' || env.DISCLAUDE_BROWSER_BIN) {
            throw new Error('Coordinated browser environment is missing its IPC socket; refusing direct browser fallback');
        }
        return env;
    }
    const result = { ...env };
    if (env.DISCLAUDE_BROWSER_BIN) {
        result.PATH = [env.DISCLAUDE_BROWSER_BIN, ...(env.PATH ?? '').split(delimiter).filter(p => p && p !== env.DISCLAUDE_BROWSER_BIN)].join(delimiter);
    }
    for (const key of Object.keys(result)) {
        if (key.startsWith('BU_CDP_') ||
            key.startsWith('CHROMIUM_CDP_') ||
            key.startsWith('DISCLAUDE_CHROMIUM_') ||
            [
                'BU_AUTOSPAWN',
                'BU_NAME',
                'BH_RUNTIME_DIR',
                'BH_TMP_DIR',
                'BH_RUNTIME_DIR_SHARED',
                'BH_TMP_DIR_SHARED',
                'BH_REQUIRE_EXISTING_DAEMON',
                'DISCLAUDE_BROWSER_TARGET',
                'DISCLAUDE_BROWSER_PYTHON',
                'DISCLAUDE_BROWSER_EVENTS',
                'DISCLAUDE_BROWSER_WORKSPACE',
                'DISCLAUDE_BROWSER_MODE',
                'DISCLAUDE_BROWSER_SUPERVISED',
            ].includes(key)) {
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
