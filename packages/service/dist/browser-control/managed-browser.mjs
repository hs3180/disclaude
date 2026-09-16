import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
/** Start only the explicitly configured independent browser/profile. */
export async function launchBrowser({ binary, profile, headless = false, signal }) {
    if (!binary || !isAbsolute(binary) || !profile || !isAbsolute(profile))
        throw new Error('Managed Chromium requires absolute binary and dedicated profile paths');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const activeFile = resolve(profile, 'DevToolsActivePort');
    let previous;
    try {
        previous = (await stat(activeFile)).mtimeMs;
    }
    catch { }
    const child = spawn(binary, ['--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : []), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, 4000); });
    let startupError;
    child.on('error', error => startupError = error);
    const stop = async ({ graceful = false } = {}) => {
        if (graceful) {
            for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        if (child.exitCode !== null || child.signalCode !== null || !child.pid)
            return;
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
    };
    try {
        for (let i = 0; i < 150; i++) {
            if (signal?.aborted)
                throw new Error('Managed Chromium startup cancelled');
            if (startupError)
                throw startupError;
            if (child.exitCode !== null || child.signalCode !== null)
                throw new Error(`Managed Chromium exited before readiness (code=${child.exitCode}, signal=${child.signalCode}): ${stderr || 'check profile ownership and binary'}`);
            try {
                if ((await stat(activeFile)).mtimeMs !== previous) {
                    const [port, browserPath] = (await readFile(activeFile, 'utf8')).trim().split('\n');
                    if (/^\d+$/.test(port) && +port > 0 && +port < 65536 && browserPath.startsWith('/devtools/browser/')) {
                        const endpoint = `http://127.0.0.1:${port}`;
                        const response = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) });
                        const info = await response.json();
                        if (response.ok && new URL(info.webSocketDebuggerUrl).pathname === browserPath)
                            return { endpoint, child, stop };
                    }
                }
            }
            catch { /* Startup may still be writing its endpoint. */ }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Managed Chromium endpoint discovery timed out: ${stderr || 'no browser diagnostics'}`);
    }
    catch (error) {
        await stop();
        throw error;
    }
}
