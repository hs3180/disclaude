/** Adapter only: all browser commands use the installed browser-use harness IPC. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
let options, env, runtime, daemon, running, stopping = false, detachedWorker = false;
const send = (message, callback) => {
  if (!process.connected) { callback?.(); return; }
  process.send(message, callback);
};
function cli(code, timeoutMs = 120000, cwd = options.cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.python, ['-m', 'browser_use.cli'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    running = child;
    let stdout = '', stderr = '', error;
    const timer = setTimeout(() => { error = new Error('Script timeout; outcome unknown'); child.kill('SIGKILL'); }, timeoutMs);
    const collect = stream => chunk => {
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 2 * 1024 * 1024) { error = new Error('Script output limit exceeded; outcome unknown'); child.kill('SIGKILL'); }
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); if (running === child) running = null;
      if (error) reject(error); else resolve({ stdout, stderr, code, signal });
    });
    child.stdin.end(code);
  });
}
process.on('message', async message => {
  try {
    if (message.kind === 'init') {
      options = message.options;
      runtime = options.runtime;
      detachedWorker = message.detached === true;
      env = { ...process.env, BU_NAME: `lease_${process.pid}`, BU_CDP_WS: message.url,
        BU_CDP_URL: '', BU_AUTOSPAWN: '', BH_RUNTIME_DIR: runtime, BH_TMP_DIR: runtime,
        BH_RUNTIME_DIR_SHARED: '0', BH_TMP_DIR_SHARED: '0', BH_REQUIRE_EXISTING_DAEMON: '1',
        BROWSER_USE_DISABLE_TELEMETRY: '1' };
      // Explicitly supervise the existing daemon; CLI calls cannot silently respawn it.
      // Keep the supervised daemon's stderr on the worker diagnostic pipe. The
      // coordinator already bounds that pipe to its final 4 KiB, so a daemon
      // bootstrap failure remains observable without changing the recovery path.
      daemon = spawn(options.python, ['-m', 'browser_harness.daemon'], { env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      // The coordinator bounds the worker diagnostic pipe to its final 4 KiB.
      // Forward both streams: browser_harness has used stdout for startup
      // diagnostics in different releases, while Python tracebacks normally
      // go to stderr.
      const forwardDaemonOutput = stream => {
        stream?.setEncoding('utf8');
        stream?.on('data', chunk => process.stderr.write(`[browser_harness.daemon] ${chunk}`));
      };
      forwardDaemonOutput(daemon.stdout);
      forwardDaemonOutput(daemon.stderr);
      send({ kind: 'daemon-started', pid: daemon.pid, python: options.python, cwd: options.cwd });
      let daemonExitReported = false;
      const reportDaemonFailure = (kind, details) => {
        if (stopping || daemonExitReported) return;
        daemonExitReported = true;
        process.stderr.write(`[browser_harness.daemon] ${kind} ${JSON.stringify(details)}\n`);
        send({ kind: 'daemon-exit', ...details }, () => process.exit(2));
      };
      daemon.on('error', error => reportDaemonFailure('error', { error: error.message }));
      daemon.on('exit', (code, signal) => reportDaemonFailure('exit', { code, signal }));
      for (let attempt = 0; attempt < 60; attempt++) {
        const target = JSON.stringify(message.target);
        const result = await cli(`switch_tab(${target})\nassert current_tab()['targetId'] == ${target}\n`, 5000);
        if (result.code === 0) { send({ kind: 'ready' }); return; }
        if (daemon.exitCode !== null) throw new Error('Harness exited during startup');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Harness IPC readiness timeout');
    } else if (message.kind === 'execute') {
      if (message.command !== 'script' || typeof message.value?.code !== 'string') throw new Error('Expected Python script');
      const result = await cli(message.value.code, 120000, message.value.cwd);
      const current = await cli('print("COORDINATED_TARGET="+current_tab()["targetId"])', 5000, message.value.cwd);
      const target = current.stdout.match(/^COORDINATED_TARGET=([A-Fa-f0-9-]+)$/m)?.[1];
      send({ kind: 'result', id: message.id, result, target });
    } else if (message.kind === 'stop') {
      stopping = true;
      running?.kill('SIGKILL'); daemon?.kill('SIGTERM');
      if (daemon && daemon.exitCode === null) await new Promise(resolve => daemon.once('exit', resolve));
      if (runtime) rmSync(runtime, { recursive: true, force: true });
      process.exit(0);
    }
  } catch (error) {
    send({ kind: message.kind === 'init' ? 'init-error' : 'result', id: message.id, error: error.message });
    if (message.kind === 'init') process.exit(2);
  }
});
process.on('disconnect', () => {
  stopping = true;
  running?.kill('SIGKILL'); daemon?.kill('SIGTERM');
  if (runtime) { try { rmSync(runtime, { recursive: true, force: true }); } catch {} }
  // The broker can no longer reap our group. Only a coordinator-created detached
  // worker may terminate its own group, including Python-spawned descendants.
  if (detachedWorker) {
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
  }
  process.exit(3);
});
