import { spawn } from 'node:child_process';
/** Adapt an installed harness consumer to a private action. The original value
 * is sent only through stdin, never argv, environment, logs or result content.
 * The consumer chooses its authentication/exchange policy. Its output is not
 * returned; it must finish its work before exit. This is not an OS sandbox.
 */
export function createPrivateProcessAction(options) {
    const definition = { ...options, args: [...(options.args ?? [])], env: { ...(options.env ?? process.env) } };
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!definition.command || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('Invalid private process definition');
    }
    return {
        id: definition.id, title: definition.title, description: definition.description,
        consume: (value, context) => new Promise(resolve => {
            let timedOut = false;
            let settled = false;
            const child = spawn(definition.command, definition.args, {
                cwd: definition.cwd, env: { ...definition.env,
                    DISCLAUDE_PRIVATE_CONTEXT: JSON.stringify(context),
                }, shell: false,
                stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32',
            });
            const killOwned = () => {
                if (!child.pid) {
                    return;
                }
                try {
                    if (process.platform === 'win32') {
                        child.kill('SIGKILL');
                    }
                    else {
                        process.kill(-child.pid, 'SIGKILL');
                    }
                }
                catch { /* Already gone; no input/error reflection. */ }
            };
            const timer = setTimeout(() => { timedOut = true; killOwned(); }, timeoutMs);
            timer.unref();
            const finish = (succeeded) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                killOwned();
                resolve(succeeded && !timedOut ? 'succeeded' : 'failed');
            };
            child.once('error', () => finish(false));
            child.once('close', code => finish(code === 0));
            child.stdin?.on('error', () => { });
            child.stdin?.end(value);
        }),
    };
}
