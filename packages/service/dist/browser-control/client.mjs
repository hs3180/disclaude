import { spawn } from 'node:child_process';
import { closeSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowserRuntimePath } from "../../../core/dist/utils/browser-env.js";
import { openCommandLock, tryCommandLock, waitCommandLock } from './command-lock.mjs';
import { processExists, readBrowserRuntime, refreshBrowserRuntimeConnection } from './service.mjs';
import { observeBrowser } from './observer.mjs';
import { browserDiagnostic } from './diagnostics.mjs';
import { randomUUID } from 'node:crypto';
/** One invocation, including its entire stdin script, is one exclusive unit. */
export async function main(args = process.argv.slice(2), env = process.env) {
    const path = env.DISCLAUDE_BROWSER_RUNTIME || resolveBrowserRuntimePath(env);
    const runtime = readBrowserRuntime(path);
    const fd = openCommandLock(join(runtime.directory, 'command.lock'));
    const marker = join(runtime.directory, 'interrupted.json');
    const waiting = new AbortController();
    let child, interrupted, killTimer, observer, diagnosticCount = 0;
    let secondary; // Command lock of a refreshed identity, held until this invocation ends.
    let diagnosticDirectory = runtime.directory; // Follows the manifest across a refresh.
    const invocationId = randomUUID();
    const reportDiagnostic = diagnostic => {
        diagnosticCount++;
        const record = { ...diagnostic, invocationId, recordedAt: new Date().toISOString() };
        console.error(`\n${JSON.stringify(record)}`);
        try {
            writeFileSync(join(diagnosticDirectory, 'last-diagnostic.json'), JSON.stringify(record), { mode: 0o600 });
        }
        catch { /* A diagnostic write must not change the upstream result. */ }
    };
    function interrupt(signal = 'SIGTERM') {
        if (interrupted)
            return;
        interrupted = signal;
        waiting.abort();
        const kill = how => {
            if (child?.pid && child.exitCode === null && child.signalCode === null) {
                try {
                    process.kill(-child.pid, how);
                }
                catch (error) {
                    if (error.code !== 'ESRCH')
                        throw error;
                }
            }
        };
        kill(signal);
        killTimer = setTimeout(() => kill('SIGKILL'), 2000);
        killTimer.unref();
    }
    const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
    const verifyOwner = () => {
        if (readBrowserRuntime(path).instance !== runtime.instance)
            throw new Error('Browser service restarted during this invocation');
    };
    const ownerCheck = setInterval(() => {
        try {
            verifyOwner();
        }
        catch {
            interrupt();
        }
    }, 500);
    ownerCheck.unref();
    try {
        if (!tryCommandLock(fd)) {
            console.error('Waiting for another browser-use invocation to finish');
            await waitCommandLock(fd, waiting.signal);
        }
        verifyOwner();
        if (interrupted)
            throw new Error('Browser command cancelled before execution');
        const reload = args.length === 1 && args[0] === '--reload';
        if (existsSync(marker) && !reload) {
            throw new Error('Previous browser-use invocation did not finish cleanly; its outcome may be unknown. Inspect the result, then run browser-use --reload to stop the shared daemon before continuing. Do not automatically replay the failed operation.');
        }
        // --reload is upstream's best-effort shutdown. Do not clear our guard if
        // the previously recorded daemon is still alive (never signal a file PID).
        let daemonPid;
        if (reload) {
            if (existsSync(marker))
                daemonPid = JSON.parse(readFileSync(marker, 'utf8')).daemonPid;
            const daemonRecord = join(runtime.directory, 'bu.pid');
            if (existsSync(daemonRecord)) {
                const record = JSON.parse(readFileSync(daemonRecord, 'utf8'));
                daemonPid = record?.pid ?? record;
                if (!Number.isSafeInteger(daemonPid) || daemonPid <= 0)
                    throw new Error('Unrecognized upstream daemon ownership record; inspect it before recovery');
            }
        }
        // #5427: the manifest pins the websocket identity discovered when the
        // service started. A browser restart keeps the HTTP endpoint but rotates
        // /devtools/browser/<id>, so a stale pin fails every attach with 404 and
        // neither restarts of Chromium nor --reload heal a manifest nobody
        // refreshes. Re-validate the pin against the current /json/version before
        // attach; on mismatch re-run discovery and migrate the manifest, then run
        // THIS invocation on the refreshed identity (also holding its command
        // lock, so a migration never widens the exclusive unit). An unreachable
        // browser keeps the pinned connection and the CLI reports the failure as
        // before; --reload re-discovers separately after stopping the daemon.
        let active = runtime;
        if (!reload) {
            active = await refreshBrowserRuntimeConnection({ env, onEvent: reportDiagnostic, tolerateDiscoveryFailure: true });
            if (active.browserEnv.BU_CDP_WS !== runtime.browserEnv.BU_CDP_WS) {
                const refreshed = openCommandLock(join(active.directory, 'command.lock'));
                try {
                    if (!tryCommandLock(refreshed)) {
                        console.error('Waiting for another browser-use invocation to finish');
                        await waitCommandLock(refreshed, waiting.signal);
                    }
                    secondary = refreshed;
                    diagnosticDirectory = active.directory;
                }
                catch (error) {
                    closeSync(refreshed);
                    throw error;
                }
            }
        }
        const guard = join(active.directory, 'interrupted.json');
        // An outcome guard, not a PID lock. A killed wrapper leaves it behind.
        writeFileSync(guard, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), daemonPid }), { mode: 0o600 });
        const cliEnv = { ...env };
        for (const key of Object.keys(cliEnv)) {
            if (key.startsWith('BU_CDP_') || key.startsWith('BH_') || ['BU_NAME', 'BU_AUTOSPAWN'].includes(key))
                delete cliEnv[key];
        }
        Object.assign(cliEnv, active.browserEnv, { PATH: active.path });
        if (args.length === 0) {
            observer = await observeBrowser({ websocket: active.browserEnv.BU_CDP_WS,
                endpoint: active.browserEnv.BU_CDP_URL, endpointSource: active.endpointSource || 'unknown', onDiagnostic: reportDiagnostic, env });
            if (interrupted)
                throw new Error('Browser command cancelled before execution');
        }
        const result = await new Promise((done, reject) => {
            // The actual CLI inherits FD 3. No worker, shell or Python runner in between.
            child = spawn(runtime.executable, args, { env: cliEnv, stdio: ['inherit', 'inherit', 'inherit', fd], detached: true });
            child.once('error', reject);
            child.once('exit', (code, signal) => done({ code, signal }));
        });
        if (result.code !== 0 && !diagnosticCount && !interrupted)
            reportDiagnostic(browserDiagnostic({
                stage: 'unknown', observation: 'upstream-exit', method: 'unknown', url: undefined,
                endpoint: active.browserEnv.BU_CDP_URL, endpointSource: active.endpointSource || 'unknown', reason: 'upstream-command-failed',
            }));
        if (result.code === 0 && !interrupted) {
            if (reload && daemonPid) {
                for (let attempt = 0; attempt < 20 && processExists(daemonPid); attempt++)
                    await delay(100);
                if (processExists(daemonPid))
                    throw new Error('Upstream daemon termination is unconfirmed; browser commands remain blocked');
            }
            if (reload) {
                // #5427: the daemon restart can bring up a different browser. Migrate
                // the manifest before clearing the outcome guard; a guard failure
                // (busy identity, owner gone) keeps --reload as the next step, while
                // an unreachable browser is reported but does not fail the reload.
                await refreshBrowserRuntimeConnection({ env, onEvent: reportDiagnostic, tolerateDiscoveryFailure: true });
            }
            rmSync(guard, { force: true });
        }
        return interrupted ? { code: null, signal: interrupted } : result;
    }
    finally {
        await observer?.stop().catch(() => { });
        clearInterval(ownerCheck);
        clearTimeout(killTimer);
        process.removeListener('SIGINT', sigint);
        process.removeListener('SIGTERM', sigterm);
        if (secondary !== undefined)
            closeSync(secondary);
        closeSync(fd);
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(({ code, signal }) => {
        if (signal)
            process.kill(process.pid, signal);
        else
            process.exitCode = code ?? 1;
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
