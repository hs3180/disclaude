import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
/** Fail startup before any agent can run if coordinated mode has no usable broker. */
export async function startBrowserRuntime(env = process.env, onUnavailable = () => { }, entry = new URL('./service.mjs', import.meta.url)) {
    if (env.DISCLAUDE_BROWSER_MODE !== 'coordinated') {
        return undefined;
    }
    const socket = env.DISCLAUDE_BROWSER_SOCKET;
    if (!socket || !isAbsolute(socket) || Buffer.byteLength(socket) > 95) {
        throw new Error('Coordinated browser mode requires an absolute DISCLAUDE_BROWSER_SOCKET (at most 95 bytes)');
    }
    if (Boolean(env.BU_CDP_URL) === Boolean(env.DISCLAUDE_CHROMIUM_BINARY)) {
        throw new Error('Configure either an existing automation browser URL or a dedicated Chromium binary/profile');
    }
    const instance = randomUUID();
    // A separate group contains only this broker and its non-detached browser tree.
    // Harness workers have their own groups and reclaim themselves on IPC disconnect.
    const child = fork(entry, [], { env: { ...env, DISCLAUDE_BROWSER_SUPERVISED: '1',
            DISCLAUDE_BROWSER_INSTANCE: instance }, silent: true, detached: true });
    child.once('exit', () => {
        // Run on exit, not close: a descendant can keep inherited stdio open.
        if (child.pid) {
            try {
                process.kill(-child.pid, 'SIGKILL');
            }
            catch { /* Group already gone. */ }
        }
        try {
            const owner = JSON.parse(readFileSync(`${socket}.lock`, 'utf8'));
            if (owner.pid !== child.pid || owner.instance !== instance) {
                return;
            }
            try {
                if (!lstatSync(socket).isSocket()) {
                    return;
                }
                rmSync(socket);
            }
            catch (error) {
                if (error.code !== 'ENOENT') {
                    return;
                }
            }
            rmSync(`${socket}.lock`);
        }
        catch { /* Never remove missing, legacy, unreadable or foreign ownership. */ }
    });
    let stopping = false;
    let startup = true;
    let stderr = '';
    const exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout?.resume();
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', () => { });
    child.on('close', (code, signal) => {
        if (!stopping && !startup) {
            onUnavailable(`Browser coordinator exited; browser requests will fail until the service is restarted. ${JSON.stringify({ code, signal, stderr: stderr.trim() })}`);
        }
    });
    const runtime = {
        get pid() { return child.pid; },
        async stop() {
            stopping = true;
            if (!child.pid) {
                return;
            }
            if (child.exitCode !== null || child.signalCode !== null) {
                await exited;
                return;
            }
            child.kill('SIGTERM');
            const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
            try {
                await exited;
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
    try {
        await new Promise((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', fail); child.off('close', closed); };
            const fail = (error) => { cleanup(); reject(error); };
            const closed = () => fail(new Error(`Browser coordinator failed before readiness: ${stderr || 'process exited'}`));
            const message = (value) => {
                const ready = value;
                if (ready?.ready === true && ready.socket === socket) {
                    cleanup();
                    resolve();
                }
            };
            const timer = setTimeout(() => fail(new Error(`Browser coordinator readiness timed out: ${stderr || 'no coordinator diagnostics'}`)), 45_000);
            child.on('message', message);
            child.once('error', fail);
            child.once('close', closed);
        });
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error('Browser coordinator exited during startup');
        }
        // This launcher is host-owned and cannot recursively launch the upstream daemon.
        const bin = join(dirname(socket), 'bin');
        mkdirSync(bin, { recursive: true, mode: 0o700 });
        writeFileSync(join(bin, 'browser-use'), `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('./client.mjs', import.meta.url).href)}).then(m => m.main()).catch(e => { console.error(e.message); process.exitCode = 1; });\n`, { mode: 0o700 });
        // Published only after broker readiness; every harness applies this after env merges.
        env.DISCLAUDE_BROWSER_BIN = bin;
        startup = false;
        return runtime;
    }
    catch (error) {
        await runtime.stop();
        throw error;
    }
}
