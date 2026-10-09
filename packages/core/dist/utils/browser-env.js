import { createHash } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { devNull, homedir } from 'node:os';
/** Private service manifest, not a user-configurable IPC endpoint. */
export function resolveBrowserRuntimePath(env = process.env) {
    const config = env.DISCLAUDE_CONFIG_PATH
        ? resolve(env.DISCLAUDE_CONFIG_PATH)
        : join(env.HOME || homedir(), '.disclaude', 'disclaude.config.yaml');
    const uid = process.getuid?.() ?? env.USER ?? 'user';
    const id = createHash('sha256').update(`${uid}\0${config}`).digest('hex').slice(0, 16);
    const root = env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : '/tmp';
    return join(root, `dcb-${id}`, 'runtime.json');
}
/** Apply after provider/task env merges. Cooperative routing, not a sandbox. */
export function browserAgentEnv(env = process.env) {
    const runtime = process.env.DISCLAUDE_BROWSER_RUNTIME || resolveBrowserRuntimePath(env);
    const previous = env.DISCLAUDE_BROWSER_RUNTIME;
    const previousBin = previous && isAbsolute(previous) ? join(dirname(previous), 'bin') : undefined;
    const bin = join(dirname(runtime), 'bin');
    const result = { ...env };
    if (env.DISCLAUDE_CONFIG_PATH) {
        result.DISCLAUDE_CONFIG_PATH = resolve(env.DISCLAUDE_CONFIG_PATH);
    }
    for (const key of Object.keys(result)) {
        if (key.startsWith('BU_CDP_') || key.startsWith('CHROMIUM_CDP_') ||
            key.startsWith('DISCLAUDE_CHROMIUM_') || key.startsWith('DISCLAUDE_BROWSER_') ||
            key.startsWith('BH_') || ['BU_AUTOSPAWN', 'BU_NAME'].includes(key)) {
            delete result[key];
        }
    }
    result.DISCLAUDE_BROWSER_RUNTIME = runtime;
    // Reject accidentally selecting an absolute upstream CLI outside the wrapper.
    // The wrapper replaces these guards with its browser-scoped upstream session.
    result.BH_RUNTIME_DIR = devNull;
    result.BH_TMP_DIR = devNull;
    result.BH_REQUIRE_EXISTING_DAEMON = '1';
    result.PATH = [bin, ...(env.PATH ?? '').split(delimiter)
            .filter(p => p && p !== bin && p !== previousBin)].join(delimiter);
    return result;
}
