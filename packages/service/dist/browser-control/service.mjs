/** Prepare a transparent CLI launcher. No coordinator server or Python runtime. */
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveBrowserRuntimePath } from "../../../core/dist/utils/browser-env.js";
import { openCommandLock, tryCommandLock } from './command-lock.mjs';
function chromiumConfigPath(env) {
    const path = env.DISCLAUDE_CHROMIUM_CONFIG ||
        join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'disclaude', 'chromium-cdp.json');
    if (!isAbsolute(path))
        throw new Error('Chromium configuration path must be absolute');
    return path;
}
export function hasChromiumCdpConfiguration(env = process.env) {
    return existsSync(chromiumConfigPath(env)) || Boolean(env.BU_CDP_URL?.trim());
}
export function processExists(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error?.code !== 'ESRCH';
    }
}
export function resolveCdpEndpoint(env) {
    let document;
    try {
        document = JSON.parse(readFileSync(chromiumConfigPath(env), 'utf8'));
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw new Error(`Cannot read installed Chromium CDP configuration: ${error.message}`);
        let parsed;
        try {
            parsed = new URL(env.BU_CDP_URL?.trim());
        }
        catch {
            throw new Error('No valid installed Chromium CDP configuration or BU_CDP_URL');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
            throw new Error('BU_CDP_URL must be an HTTP(S) endpoint without credentials, query, or fragment');
        }
        return parsed.href.replace(/\/+$/u, '');
    }
    if (!document || document.version !== 1 || !document.environment || typeof document.environment !== 'object' || Array.isArray(document.environment)) {
        throw new Error('The installed Chromium CDP configuration is invalid');
    }
    const { CHROMIUM_CDP_ADDRESS: address = '127.0.0.1', CHROMIUM_CDP_PORT: port = '9222' } = document.environment;
    if (typeof address !== 'string' || typeof port !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(address) ||
        !/^\d+$/.test(port) || +port < 1 || +port > 65535)
        throw new Error('Invalid installed Chromium CDP address or port');
    return `http://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${port}`;
}
function privateDirectory(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) {
        throw new Error(`Browser runtime directory must be private and owned: ${path}`);
    }
}
export function resolveBrowserUse(env, launcherDirectory) {
    for (const directory of (env.PATH || '').split(delimiter)) {
        if (!isAbsolute(directory) || directory === launcherDirectory)
            continue;
        const executable = join(directory, 'browser-use');
        try {
            accessSync(executable, constants.X_OK);
            if (readFileSync(executable).subarray(0, 1024).includes('disclaude-browser-launcher'))
                continue;
            return executable; // Keep venv symlinks; the CLI's shebang selects Python.
        }
        catch { /* Continue PATH resolution. */ }
    }
    throw new Error('browser-use CLI is not installed on the Disclaude service PATH; install the upstream CLI and restart Disclaude');
}
export function readBrowserRuntime(path) {
    let runtime;
    try {
        runtime = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        throw new Error(`Browser runtime is unavailable: ${error.message}`);
    }
    if (runtime?.version !== 1 || !processExists(runtime.pid) || typeof runtime.instance !== 'string' ||
        !isAbsolute(runtime.executable || '') || !isAbsolute(runtime.directory || '') || !runtime.browserEnv) {
        throw new Error('Browser runtime is unavailable; start or restart Disclaude');
    }
    return runtime;
}
export function browserStatus(path) {
    const runtime = readBrowserRuntime(path);
    const fd = openCommandLock(join(runtime.directory, 'command.lock'));
    try {
        const busy = !tryCommandLock(fd);
        return { state: busy ? 'busy' : existsSync(join(runtime.directory, 'interrupted.json')) ? 'interrupted' : 'idle',
            pid: runtime.pid, executable: runtime.executable };
    }
    finally {
        closeSync(fd);
    }
}
export async function prepareBrowserCommands({ env = process.env, fetchImpl = globalThis.fetch, onEvent = /** @type {(record: Record<string, unknown>) => void} */ (() => { }), } = {}) {
    const path = resolveBrowserRuntimePath(env);
    const bin = join(dirname(path), 'bin');
    const executable = resolveBrowserUse(env, bin);
    const endpoint = resolveCdpEndpoint(env);
    const response = await fetchImpl(`${endpoint}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok)
        throw new Error(`Browser CDP discovery failed: HTTP ${response.status}`);
    const version = await response.json();
    const websocket = new URL(version.webSocketDebuggerUrl);
    const browserId = /^\/devtools\/browser\/([^/]+)$/.exec(websocket.pathname)?.[1];
    if (!['ws:', 'wss:'].includes(websocket.protocol) || !browserId)
        throw new Error('Invalid Chromium CDP browser identity');
    // One browser ID shares a lock across projects, configurations and URL aliases.
    // A short local root also accommodates upstream's Unix socket path limit.
    const identity = createHash('sha256').update(browserId).digest('hex').slice(0, 24);
    const root = `/tmp/disclaude-browser-${process.getuid?.()}`;
    const directory = join(root, identity);
    privateDirectory(root);
    privateDirectory(directory);
    privateDirectory(dirname(path));
    privateDirectory(bin);
    if (existsSync(path)) {
        const previous = JSON.parse(readFileSync(path, 'utf8'));
        if (processExists(previous.pid))
            throw new Error(`Browser commands already belong to service ${previous.pid}`);
    }
    const fd = openCommandLock(join(directory, 'command.lock'));
    try {
        tryCommandLock(fd);
    }
    finally {
        closeSync(fd);
    }
    const runtime = { version: 1, pid: process.pid, instance: randomUUID(), executable, directory,
        path: env.PATH, browserEnv: { BU_CDP_WS: websocket.href, BU_CDP_URL: endpoint,
            BU_NAME: `disclaude-${identity}`, BU_AUTOSPAWN: '0', BH_RUNTIME_DIR: directory, BH_TMP_DIR: directory,
            BH_HOME: directory,
            ANONYMIZED_TELEMETRY: 'false' } };
    const launcher = join(bin, 'browser-use');
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const content = `#!/bin/sh\n# disclaude-browser-launcher\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./client.mjs', import.meta.url)))} "$@"\n`;
    writeFileSync(launcher, content, { mode: 0o700 });
    const temporary = `${path}.${runtime.instance}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(runtime), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, path);
    }
    finally {
        rmSync(temporary, { force: true });
    }
    onEvent({ type: 'browser-cli-selected', executable });
    return { pid: process.pid,
        get unavailable() { try {
            return browserStatus(path).state === 'interrupted';
        }
        catch {
            return true;
        } },
        async stop() {
            // Keep the shared lock inode and upstream daemon/Chromium. Active wrappers
            // observe manifest withdrawal and cancel their own CLI command.
            if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).instance === runtime.instance) {
                rmSync(path);
                rmSync(launcher, { force: true });
            }
        },
    };
}
