/** Opt-in local integration service. Reuses browser-use's daemon and helper IPC. */
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, closeSync, rmSync, statSync, chmodSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { connect } from './cdp.mjs';
import { launchBrowser } from './managed-browser.mjs';
import { Coordinator } from './coordinator.mjs';

const socketPath = process.env.DISCLAUDE_BROWSER_SOCKET;
let endpoint = process.env.BU_CDP_URL;
const python = process.env.DISCLAUDE_BROWSER_PYTHON || 'python3';
const cwd = resolve(process.env.DISCLAUDE_BROWSER_WORKSPACE || process.cwd());
if (!socketPath || !socketPath.startsWith('/') || Buffer.byteLength(socketPath) > 95) throw new Error('Set an absolute DISCLAUDE_BROWSER_SOCKET path (max 95 bytes)');
if (endpoint && process.env.DISCLAUDE_CHROMIUM_BINARY) throw new Error('Choose an existing endpoint or managed Chromium, not both');
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
if ((statSync(dirname(socketPath)).mode & 0o077) !== 0) throw new Error('Socket parent directory must be private (0700)');
if (!statSync(cwd).isDirectory()) throw new Error('Browser workspace must be a directory');
const lock = openSync(socketPath + '.lock', 'wx', 0o600); closeSync(lock);
const peers = new Set(); let managed, target, admin, coordinator, server, listening = false, stopping;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = record => {
  const line = JSON.stringify(record) + '\n';
  if (process.env.DISCLAUDE_BROWSER_EVENTS) appendFileSync(process.env.DISCLAUDE_BROWSER_EVENTS, line, { mode: 0o600 });
};
async function shutdown() {
  if (stopping) return stopping;
  stopping = (async () => {
    for (const peer of peers) peer.destroy();
    if (listening) server.close();
    await coordinator?.close();
    // Preserve the shared page. Its target ID is reported at readiness for explicit cleanup.
    // Flush persistent profile state before the process termination fallback.
    if (managed && admin) {
      await admin.call('Browser.close').catch(() => {});
      await managed.stop({ graceful: true });
    } else await managed?.stop();
    await admin?.close();
    if (listening) rmSync(socketPath, { force: true });
    rmSync(socketPath + '.lock', { force: true });
  })();
  return stopping;
}
try {
  if (!endpoint) {
    managed = await launchBrowser({ binary: process.env.DISCLAUDE_CHROMIUM_BINARY, profile: process.env.DISCLAUDE_CHROMIUM_PROFILE, headless: process.env.DISCLAUDE_CHROMIUM_HEADLESS === '1' });
    endpoint = managed.endpoint;
    managed.child.once('exit', () => { if (!stopping) void shutdown().then(() => process.exit(1)); });
  }
  const info = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  admin = await connect(info.webSocketDebuggerUrl);
  if (process.env.DISCLAUDE_BROWSER_TARGET) {
    target = process.env.DISCLAUDE_BROWSER_TARGET;
    await admin.call('Target.getTargetInfo', { targetId: target });
  } else target = (await admin.call('Target.createTarget', { url: 'about:blank', background: true })).targetId;
  coordinator = new Coordinator({ url: info.webSocketDebuggerUrl, target, event, onTargetChange: value => { target = value; },
    workerModule: new URL('./harness-worker.mjs', import.meta.url), detachedWorker: true, startupMs: 30000,
    workerOptions: () => ({ python, cwd, runtime: mkdtempSync('/tmp/dcbh-') }),
    cleanupWorker: options => { if (options?.runtime) rmSync(options.runtime, { recursive: true, force: true }); },
    ttlMs: 5000, hardMs: 180000,
    verifyReclaimed: async () => {
      for (let i = 0; i < 50; i++) {
        const targetInfo = (await admin.call('Target.getTargets')).targetInfos.find(item => item.targetId === target);
        if (!targetInfo) {
          target = (await admin.call('Target.createTarget', { url: 'about:blank', background: true })).targetId;
          coordinator.target = target; return;
        }
        if (!targetInfo.attached) return;
        await delay(20);
      }
      throw new Error('Harness CDP session still attached after worker group exit');
    },
  });
  server = createServer(peer => {
    peers.add(peer); peer.setEncoding('utf8');
    const actor = randomUUID(); let buffer = '', ticket, ready, lease, gone = false;
    const reply = (id, result, error) => { if (!peer.destroyed) peer.write(JSON.stringify({ id, ...(error ? { error } : { result }) }) + '\n'); };
    peer.on('error', () => {});
    peer.on('close', () => {
      gone = true; peers.delete(peer); ticket?.cancel();
      if (lease) void coordinator.release(lease);
    });
    async function handle(message) {
      const { id, method } = message;
      try {
        if (!Number.isSafeInteger(id)) throw new Error('Invalid request ID');
        if (method === 'status') reply(id, { state: coordinator.holder?.state || (coordinator.closed ? 'unavailable' : 'idle'), queued: coordinator.queue.length });
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
          if (!ready) throw new Error('Acquire first'); reply(id, await ready);
        } else if (method === 'heartbeat') {
          if (!lease) throw new Error('No held lease'); coordinator.heartbeat(lease); reply(id, { ok: true });
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
      } catch (error) { reply(id, undefined, error.message); }
    }
    peer.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { peer.destroy(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { const message = JSON.parse(line); if (!message || typeof message !== 'object') throw new Error(); void handle(message); }
        catch { peer.destroy(); return; }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  listening = true; chmodSync(socketPath, 0o600);
  console.log(JSON.stringify({ ready: true, socket: socketPath, target, browser: info.Browser, managed: !!managed }));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
} catch (error) { await shutdown(); console.error(error.message); process.exitCode = 1; }
