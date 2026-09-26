/** In-process browser coordinator owned by the Disclaude service lifecycle. */
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, rmSync, rmdirSync, statSync, writeFileSync, writeSync, chmodSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { connect } from './cdp.mjs';
import { Coordinator } from './coordinator.mjs';
import { resolveBrowserSocketPath } from '@disclaude/core/browser-runtime';

const isMissing = error => error?.code === 'ENOENT';

function chromiumConfigPath(env) {
  const path = env.DISCLAUDE_CHROMIUM_CONFIG ||
    join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'disclaude', 'chromium-cdp.json');
  if (!isAbsolute(path)) throw new Error('Chromium configuration path must be absolute');
  return path;
}

export function hasChromiumCdpConfiguration(env = process.env) {
  return existsSync(chromiumConfigPath(env)) || Boolean(env.BU_CDP_URL?.trim());
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

function discardStaleSocket(socketPath) {
  const lockPath = `${socketPath}.lock`;
  if (!existsSync(lockPath)) {
    try {
      lstatSync(socketPath);
      throw new Error('Browser IPC socket exists without an ownership lock; refusing to remove it');
    } catch (error) { if (!isMissing(error)) throw error; }
    return;
  }

  let owner;
  try {
    const lockStat = lstatSync(lockPath);
    if (!lockStat.isFile()) throw new Error('Browser IPC ownership lock is not a regular file');
    owner = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return;
    throw new Error(`Browser IPC ownership lock is unreadable; refusing to remove it: ${error.message}`);
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.instance !== 'string') {
    throw new Error('Browser IPC ownership lock has an invalid owner; refusing to remove it');
  }
  if (!processExists(owner?.pid)) {
    // Re-read before touching the socket so a replaced lock is not mistaken for stale ownership.
    const current = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (current?.pid !== owner.pid || current?.instance !== owner.instance) {
      throw new Error('Browser IPC ownership changed during stale cleanup; refusing to continue');
    }
    try {
      if (!lstatSync(socketPath).isSocket()) throw new Error('Browser IPC path is not a socket; refusing stale cleanup');
      rmSync(socketPath);
    } catch (error) { if (!isMissing(error)) throw error; }
    rmSync(lockPath);
    return;
  }
  throw new Error(`Browser IPC is already owned by process ${owner.pid}; refusing to start a second coordinator`);
}

function resolveCdpEndpoint(env) {
  const configPath = chromiumConfigPath(env);
  let document;
  try { document = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      const endpoint = env.BU_CDP_URL?.trim();
      if (!endpoint) throw new Error('No installed Chromium CDP configuration or service-provided CDP endpoint is available');
      let parsed;
      try { parsed = new URL(endpoint); }
      catch { throw new Error('The service-provided BU_CDP_URL is invalid'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('The service-provided BU_CDP_URL must be an HTTP(S) endpoint without credentials, query, or fragment');
      }
      return endpoint.replace(/\/+$/u, '');
    }
    else throw new Error(`Cannot read the installed Chromium CDP configuration: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== 1 ||
      !document.environment || typeof document.environment !== 'object' || Array.isArray(document.environment)) {
    throw new Error('The installed Chromium CDP configuration is invalid');
  }
  const configured = document.environment || {};
  const address = configured.CHROMIUM_CDP_ADDRESS ?? '127.0.0.1';
  const port = configured.CHROMIUM_CDP_PORT ?? '9222';
  if (typeof address !== 'string' || typeof port !== 'string' ||
      !/^[a-zA-Z0-9.:[\]-]+$/.test(address) || !/^\d+$/.test(port) || +port < 1 || +port > 65535) {
    throw new Error('The installed Chromium CDP configuration has an invalid address or port');
  }
  const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/** Start the IPC listener and attach to the CDP endpoint already deployed for this host. */
export async function startBrowserCoordinator({
  env = process.env,
  cwd = process.cwd(),
  onUnavailable = /** @type {(message: string) => void} */ (() => {}),
  onEvent = /** @type {(record: Record<string, unknown>) => void} */ (() => {}),
  connectBrowser = connect,
  createCoordinator = options => new Coordinator(options),
} = {}) {
  const socketPath = resolveBrowserSocketPath(env);
  if (!socketPath || !socketPath.startsWith('/') || Buffer.byteLength(socketPath) > 95) {
    throw new Error('Browser coordinator received an invalid internal IPC path (max 95 bytes)');
  }
  const endpoint = resolveCdpEndpoint(env);
  const parsedEndpoint = new URL(endpoint);
  if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) throw new Error('Browser CDP endpoint must use HTTP or HTTPS');

  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if ((statSync(dirname(socketPath)).mode & 0o077) !== 0) throw new Error('Socket parent directory must be private (0700)');
  discardStaleSocket(socketPath);

  const instance = randomUUID();
  const lockPath = `${socketPath}.lock`;
  const lock = openSync(lockPath, 'wx', 0o600);
  try { writeSync(lock, JSON.stringify({ pid: process.pid, instance })); }
  catch (error) {
    closeSync(lock);
    try { rmSync(lockPath); } catch { /* Preserve the original lock-write failure. */ }
    throw error;
  }
  closeSync(lock);

  const peers = new Set();
  let target;
  let admin;
  let coordinator;
  let server;
  let listening = false;
  let stopping = false;
  let unavailable = false;
  let stopPromise;

  const emit = record => {
    try { onEvent(record); } catch { /* Observability must not break browser control. */ }
  };
  const markUnavailable = message => {
    if (stopping || unavailable) return;
    unavailable = true;
    emit({ type: 'coordinator-unavailable', message });
    try { onUnavailable(message); } catch { /* Preserve the service lifecycle. */ }
    void coordinator?.close().catch(error => emit({ type: 'coordinator-close-error', error: error.message }));
  };
  const event = record => {
    emit(record);
    if (record.type === 'quarantined') markUnavailable(`Browser coordinator quarantined during ${record.phase}: ${record.reason}`);
  };
  const removeOwnedSocket = () => {
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (owner.pid !== process.pid || owner.instance !== instance) return;
      try {
        const socketStat = lstatSync(socketPath);
        if (!socketStat.isSocket()) throw new Error('Browser IPC path changed to a non-socket; preserving it and its ownership lock');
        rmSync(socketPath);
      } catch (error) { if (!isMissing(error)) throw error; }
      const launcherPath = join(dirname(socketPath), 'bin', 'browser-use');
      try {
        const launcherStat = lstatSync(launcherPath);
        if (!launcherStat.isFile() && !launcherStat.isSymbolicLink()) {
          throw new Error('Browser launcher path changed to a non-file; preserving it');
        }
        rmSync(launcherPath);
      } catch (error) { if (!isMissing(error)) throw error; }
      rmSync(lockPath);
      for (const directory of [join(dirname(socketPath), 'bin'), dirname(socketPath)]) {
        try { rmdirSync(directory); }
        catch (error) {
          if (!isMissing(error) && !['ENOTEMPTY', 'EEXIST'].includes(error.code)) {
            emit({ type: 'socket-cleanup-error', error: error.message });
          }
        }
      }
    } catch (error) { if (!isMissing(error)) emit({ type: 'socket-cleanup-error', error: error.message }); }
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      for (const peer of peers) peer.destroy();
      const errors = [];
      try { await coordinator?.close(); } catch (error) { errors.push(error); }
      if (listening) {
        try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        catch (error) { errors.push(error); }
        listening = false;
      }
      try { await admin?.close(); } catch (error) { errors.push(error); }
      removeOwnedSocket();
      if (errors.length) throw new AggregateError(errors, 'Browser coordinator shutdown was incomplete');
    })();
    return stopPromise;
  };

  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Browser CDP endpoint returned HTTP ${response.status}`);
    const info = await response.json();
    if (typeof info.webSocketDebuggerUrl !== 'string') throw new Error('Browser CDP endpoint did not report a WebSocket URL');
    admin = await connectBrowser(info.webSocketDebuggerUrl);
    void admin.closed.then(() => markUnavailable(`Browser CDP connection closed (${info.Browser || 'unknown browser'})`));
    target = (await admin.call('Target.createTarget', { url: 'about:blank', background: true })).targetId;

    coordinator = createCoordinator({
      url: info.webSocketDebuggerUrl,
      target,
      event,
      onTargetChange: value => { target = value; },
      workerModule: new URL('./harness-worker.mjs', import.meta.url),
      detachedWorker: true,
      startupMs: 30000,
      workerOptions: () => ({ python: 'python3', cwd, runtime: mkdtempSync('/tmp/dcbh-') }),
      cleanupWorker: options => { if (options?.runtime) rmSync(options.runtime, { recursive: true, force: true }); },
      ttlMs: 5000,
      hardMs: 180000,
      verifyReclaimed: async () => {
        for (let i = 0; i < 50; i++) {
          const targetInfo = (await admin.call('Target.getTargets')).targetInfos.find(item => item.targetId === target);
          if (!targetInfo) {
            target = (await admin.call('Target.createTarget', { url: 'about:blank', background: true })).targetId;
            coordinator.target = target;
            return;
          }
          if (!targetInfo.attached) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('Harness CDP session still attached after worker group exit');
      },
    });

    server = createServer(peer => {
      peers.add(peer);
      peer.setEncoding('utf8');
      const actor = randomUUID();
      let buffer = '', ticket, ready, lease, gone = false;
      emit({ type: 'peer-connected', actor });
      const reply = (id, result, error) => { if (!peer.destroyed) peer.write(JSON.stringify({ id, ...(error ? { error } : { result }) }) + '\n'); };
      peer.on('error', error => emit({ type: 'peer-error', actor, error: error.message }));
      peer.on('close', () => {
        emit({ type: 'peer-closed', actor, hadTicket: Boolean(ticket), hadLease: Boolean(lease), ready: Boolean(ready) });
        gone = true;
        peers.delete(peer);
        ticket?.cancel();
        if (lease) void coordinator.release(lease).catch(error => markUnavailable(`Browser worker cleanup failed: ${error.message}`));
      });
      async function handle(message) {
        const { id, method } = message;
        try {
          if (!Number.isSafeInteger(id)) throw new Error('Invalid request ID');
          if (method === 'status') reply(id, { state: unavailable || coordinator.closed ? 'unavailable' : coordinator.holder?.state || 'idle', queued: coordinator.queue.length });
          else if (method === 'acquire') {
            if (ready) throw new Error('This connection already requested control');
            ticket = coordinator.acquire(actor, { waitMs: 120000 });
            ready = ticket.promise.then(async value => {
              lease = value;
              if (gone) { await coordinator.release(lease); throw new Error('Caller disconnected'); }
              return { state: 'held' };
            });
            ready.catch(() => {});
            reply(id, { state: 'queued' });
          } else if (method === 'wait') {
            if (!ready) throw new Error('Acquire first');
            reply(id, await ready);
          } else if (method === 'heartbeat') {
            if (!lease) throw new Error('No held lease');
            coordinator.heartbeat(lease);
            reply(id, { ok: true });
          } else if (method === 'execute') {
            if (!lease) throw new Error('No held lease');
            if (typeof message.script !== 'string' || message.script.length > 1024 * 1024) throw new Error('Invalid script');
            const executionCwd = message.cwd === undefined ? cwd : message.cwd;
            if (typeof executionCwd !== 'string' || !executionCwd.startsWith('/') || !statSync(executionCwd).isDirectory()) throw new Error('Execution cwd must be an existing absolute directory');
            reply(id, await coordinator.execute(lease, 'script', { code: message.script, cwd: executionCwd }));
          } else if (method === 'release') {
            if (!lease) { ticket?.cancel(); reply(id, { released: false }); }
            else reply(id, { released: await coordinator.release(lease) });
          } else throw new Error('Unknown method');
        } catch (error) {
          emit({ type: 'request-error', actor, id, method, error: error.message });
          reply(id, undefined, error.message);
        }
      }
      peer.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) { peer.destroy(); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const message = JSON.parse(line);
            if (!message || typeof message !== 'object') throw new Error();
            void handle(message);
          } catch { peer.destroy(); return; }
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    listening = true;
    chmodSync(socketPath, 0o600);
    const launcherDirectory = join(dirname(socketPath), 'bin');
    mkdirSync(launcherDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(launcherDirectory, 'browser-use'),
      `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('./client.mjs', import.meta.url).href)}).then(m => m.main()).catch(e => { console.error(e.message); process.exitCode = 1; });\n`,
      { mode: 0o700 });
    server.on('error', error => {
      markUnavailable(`Browser IPC listener failed: ${error.message}`);
      void stop().catch(stopError => emit({ type: 'coordinator-stop-error', error: stopError.message }));
    });
    return { stop, pid: process.pid, get unavailable() { return unavailable; } };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
