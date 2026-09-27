import { spawn } from 'node:child_process';
import { closeSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowserRuntimePath } from '@disclaude/core/browser-runtime';
import { openCommandLock, tryCommandLock, waitCommandLock } from './command-lock.mjs';
import { processExists, readBrowserRuntime } from './service.mjs';

/** One invocation, including its entire stdin script, is one exclusive unit. */
export async function main(args = process.argv.slice(2), env = process.env) {
  const path = env.DISCLAUDE_BROWSER_RUNTIME || resolveBrowserRuntimePath(env);
  const runtime = readBrowserRuntime(path);
  const fd = openCommandLock(join(runtime.directory, 'command.lock'));
  const marker = join(runtime.directory, 'interrupted.json');
  const waiting = new AbortController();
  let child, interrupted, killTimer;
  function interrupt(signal = 'SIGTERM') {
    if (interrupted) return;
    interrupted = signal;
    waiting.abort();
    const kill = how => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, how); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    kill(signal);
    killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    killTimer.unref();
  }
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  const verifyOwner = () => {
    if (readBrowserRuntime(path).instance !== runtime.instance) throw new Error('Browser service restarted during this invocation');
  };
  const ownerCheck = setInterval(() => {
    try { verifyOwner(); } catch { interrupt(); }
  }, 500);
  ownerCheck.unref();
  try {
    if (!tryCommandLock(fd)) {
      console.error('Waiting for another browser-use invocation to finish');
      await waitCommandLock(fd, waiting.signal);
    }
    verifyOwner();
    if (interrupted) throw new Error('Browser command cancelled before execution');
    const reload = args.length === 1 && args[0] === '--reload';
    if (existsSync(marker) && !reload) {
      throw new Error('Previous browser-use invocation did not finish cleanly; its outcome may be unknown. Inspect the result, then run browser-use --reload to stop the shared daemon before continuing. Do not automatically replay the failed operation.');
    }
    // --reload is upstream's best-effort shutdown. Do not clear our guard if
    // the previously recorded daemon is still alive (never signal a file PID).
    let daemonPid;
    if (reload) {
      if (existsSync(marker)) daemonPid = JSON.parse(readFileSync(marker, 'utf8')).daemonPid;
      const daemonRecord = join(runtime.directory, 'bu.pid');
      if (existsSync(daemonRecord)) {
        const record = JSON.parse(readFileSync(daemonRecord, 'utf8'));
        daemonPid = record?.pid ?? record;
        if (!Number.isSafeInteger(daemonPid) || daemonPid <= 0) throw new Error('Unrecognized upstream daemon ownership record; inspect it before recovery');
      }
    }
    // An outcome guard, not a PID lock. A killed wrapper leaves it behind.
    writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), daemonPid }), { mode: 0o600 });
    const cliEnv = { ...env };
    for (const key of Object.keys(cliEnv)) {
      if (key.startsWith('BU_CDP_') || key.startsWith('BH_') || ['BU_NAME', 'BU_AUTOSPAWN'].includes(key)) delete cliEnv[key];
    }
    Object.assign(cliEnv, runtime.browserEnv, { PATH: runtime.path });
    const result = await new Promise((done, reject) => {
      // The actual CLI inherits FD 3. No worker, shell or Python runner in between.
      child = spawn(runtime.executable, args, { env: cliEnv, stdio: ['inherit', 'inherit', 'inherit', fd], detached: true });
      child.once('error', reject);
      child.once('exit', (code, signal) => done({ code, signal }));
    });
    if (result.code === 0 && !interrupted) {
      if (reload && daemonPid) {
        for (let attempt = 0; attempt < 20 && processExists(daemonPid); attempt++) await delay(100);
        if (processExists(daemonPid)) throw new Error('Upstream daemon termination is unconfirmed; browser commands remain blocked');
      }
      rmSync(marker, { force: true });
    }
    return interrupted ? { code: null, signal: interrupted } : result;
  } finally {
    clearInterval(ownerCheck); clearTimeout(killTimer);
    process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
    closeSync(fd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(({ code, signal }) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
