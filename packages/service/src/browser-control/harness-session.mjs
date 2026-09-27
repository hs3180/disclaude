import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createBrowserPythonEnvironment } from './python-runtime.mjs';

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const DIAGNOSTIC_LIMIT = 4 * 1024;
const PROCESS_GROUPS_SUPPORTED = process.platform !== 'win32';
const GUARDED_MODULE_RUNNER = `
import os, runpy, signal, sys, threading, time
parent_pid = int(os.environ['DISCLAUDE_BROWSER_PARENT_PID'])
def stop_if_parent_exits():
    while os.getppid() == parent_pid:
        time.sleep(0.05)
    if os.name == 'nt':
        os.kill(os.getpid(), signal.SIGTERM)
    else:
        os.killpg(os.getpgrp(), signal.SIGKILL)
threading.Thread(target=stop_if_parent_exits, daemon=True).start()
module_name = sys.argv.pop(1)
runpy.run_module(module_name, run_name='__main__', alter_sys=True)
`;

function pythonModuleArgs(module) {
  return ['-c', GUARDED_MODULE_RUNNER, module];
}

function trackClose(child) {
  let resolveClose;
  const record = {
    child,
    closed: false,
    closePromise: new Promise(resolve => { resolveClose = resolve; }),
  };
  child.once('close', (code, signal) => {
    record.closed = true;
    record.code = code;
    record.signal = signal;
    resolveClose(record);
  });
  return record;
}

function signalProcessGroup(record, signal) {
  if (!record || record.closed) return;
  try {
    if (PROCESS_GROUPS_SUPPORTED && record.child.pid) process.kill(-record.child.pid, signal);
    else record.child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function waitForClose(record, timeoutMs) {
  if (!record || record.closed) return true;
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([record.closePromise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function exitDescription(details) {
  return `code=${details.code ?? 'none'}, signal=${details.signal ?? 'none'}`;
}

/** Owns the Python harness processes for one browser-control lease. */
export class BrowserHarnessSession {
  constructor({
    python,
    cwd,
    runtime,
    url,
    target,
    startupMs = 30000,
    env = process.env,
    onEvent = () => {},
    onDaemonExit = () => {},
  }) {
    Object.assign(this, { python, cwd, runtime, url, target, startupMs, onEvent, onDaemonExit });
    const name = `lease_${randomUUID().replaceAll('-', '')}`;
    this.env = createBrowserPythonEnvironment({
      ...env,
      DISCLAUDE_BROWSER_PARENT_PID: String(process.pid),
      BU_NAME: name,
      BU_CDP_WS: url,
      BU_CDP_URL: '',
      BU_AUTOSPAWN: '',
      BH_RUNTIME_DIR: runtime,
      BH_TMP_DIR: runtime,
      BH_RUNTIME_DIR_SHARED: '0',
      BH_TMP_DIR_SHARED: '0',
      BH_REQUIRE_EXISTING_DAEMON: '1',
      BROWSER_USE_DISABLE_TELEMETRY: '1',
    });
    this.diagnostics = '';
    this.ready = false;
    this.stopping = false;
    this.daemonExitDetails = undefined;
  }

  get stderr() {
    return this.diagnostics.trim();
  }

  log(type, fields = {}) {
    try { this.onEvent({ type, ...fields }); } catch { /* Diagnostics must not break browser control. */ }
  }

  appendDiagnostic(source, chunk) {
    this.diagnostics = `${this.diagnostics}[${source}] ${String(chunk)}`.slice(-DIAGNOSTIC_LIMIT);
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startDaemon();
    return this.startPromise;
  }

  async startDaemon() {
    this.daemon = spawn(this.python, pythonModuleArgs('browser_harness.daemon'), {
      env: this.env,
      cwd: this.cwd,
      detached: PROCESS_GROUPS_SUPPORTED,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.daemonProcess = trackClose(this.daemon);
    for (const stream of [this.daemon.stdout, this.daemon.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', chunk => this.appendDiagnostic('browser_harness.daemon', chunk));
    }
    this.daemon.once('error', error => {
      this.log('daemon-spawn-error', { error: error.message, stderr: this.stderr || undefined });
    });
    this.daemonProcess.closePromise.then(details => {
      this.daemonExitDetails = { code: details.code, signal: details.signal };
      this.log('daemon-exit', { ...this.daemonExitDetails, stderr: this.stderr || undefined });
      if (!this.stopping) {
        try { this.onDaemonExit(this.daemonExitDetails); } catch { /* Recovery is owned by the coordinator. */ }
      }
    });
    if (!this.daemon.pid) throw new Error('Unable to start browser_harness.daemon');
    this.log('daemon-started', { pid: this.daemon.pid, python: this.python, cwd: this.cwd });

    const deadline = Date.now() + this.startupMs;
    const target = JSON.stringify(this.target);
    const readinessScript = `switch_tab(${target})\nassert current_tab()['targetId'] == ${target}\n`;
    while (!this.stopping && Date.now() < deadline) {
      if (this.daemonExitDetails) {
        throw new Error(`Browser harness daemon exited during startup (${exitDescription(this.daemonExitDetails)})`);
      }
      const remaining = deadline - Date.now();
      let result;
      try {
        result = await this.runCli(readinessScript, Math.min(5000, remaining));
      } catch (error) {
        if (this.daemonExitDetails) {
          throw new Error(`Browser harness daemon exited during startup (${exitDescription(this.daemonExitDetails)})`);
        }
        throw error;
      }
      if (result.code === 0) {
        if (this.daemonExitDetails) {
          throw new Error(`Browser harness daemon exited during startup (${exitDescription(this.daemonExitDetails)})`);
        }
        this.ready = true;
        return { pid: this.daemon.pid, python: this.python, cwd: this.cwd };
      }
      if (this.stopping) throw new Error('Browser harness startup cancelled');
      if (result.stderr) this.appendDiagnostic('browser_use.cli', result.stderr);
      if (this.daemonExitDetails) {
        throw new Error(`Browser harness daemon exited during startup (${exitDescription(this.daemonExitDetails)})`);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
    }
    if (this.stopping) throw new Error('Browser harness startup cancelled');
    throw new Error(`Browser harness IPC readiness timeout after ${this.startupMs}ms`);
  }

  runCli(code, timeoutMs, cwd = this.cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, pythonModuleArgs('browser_use.cli'), {
        env: this.env,
        cwd,
        detached: PROCESS_GROUPS_SUPPORTED,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const record = trackClose(child);
      this.runningProcess = record;
      let stdout = '';
      let stderr = '';
      let error;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const collect = stream => chunk => {
        if (stream === 'stdout') stdout += chunk;
        else stderr += chunk;
        if (stdout.length + stderr.length > OUTPUT_LIMIT && !error) {
          error = new Error('Script output limit exceeded; outcome unknown');
          signalProcessGroup(record, 'SIGKILL');
        }
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.once('error', spawnError => { error = new Error(`Unable to start browser_use.cli: ${spawnError.message}`); });
      const timer = setTimeout(() => {
        error = new Error('Script timeout; outcome unknown');
        signalProcessGroup(record, 'SIGKILL');
      }, timeoutMs);
      record.closePromise.then(() => {
        clearTimeout(timer);
        if (this.runningProcess === record) this.runningProcess = undefined;
        if (error) reject(error);
        else resolve({ stdout, stderr, code: record.code, signal: record.signal });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(code);
    });
  }

  async execute(code, cwd = this.cwd) {
    if (!this.ready || this.stopping || this.daemonExitDetails) {
      throw new Error('Browser harness session is not ready');
    }
    const result = await this.runCli(code, 120000, cwd);
    const current = await this.runCli('print("COORDINATED_TARGET="+current_tab()["targetId"])', 5000, cwd);
    const target = current.stdout.match(/^COORDINATED_TARGET=([A-Fa-f0-9-]+)$/m)?.[1];
    return { result, target };
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.ready = false;
    this.stopPromise = (async () => {
      if (this.runningProcess && !this.runningProcess.closed) {
        signalProcessGroup(this.runningProcess, 'SIGKILL');
        if (!(await waitForClose(this.runningProcess, 1000))) {
          throw new Error('Browser harness CLI did not stop after SIGKILL');
        }
      }
      if (this.daemonProcess && !this.daemonProcess.closed) {
        signalProcessGroup(this.daemonProcess, 'SIGTERM');
        if (!(await waitForClose(this.daemonProcess, 500))) {
          signalProcessGroup(this.daemonProcess, 'SIGKILL');
          if (!(await waitForClose(this.daemonProcess, 2000))) {
            throw new Error('Browser harness daemon did not stop after SIGKILL');
          }
        }
      }
    })();
    return this.stopPromise;
  }
}
