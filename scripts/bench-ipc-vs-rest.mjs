/**
 * Benchmark: Unix-socket IPC vs REST HTTP for MCP ↔ PrimaryNode internal comms.
 *
 * Issue #4168: "用 REST API 取代 IPC" proposes replacing the Unix-socket IPC
 * channel with REST. The issue explicitly asks for a perf comparison first:
 * > "Unix socket 的延迟/开销显著低于 HTTP（无握手、无端口、无 HTTP 序列化）
 * >  ... 建议先做一组基准对比。"
 *
 * This script measures sequential round-trip latency of the lightest request
 * (`ping`) over both transports, using the REAL disclaude IPC classes
 * (`UnixSocketIpcServer` / `UnixSocketIpcClient`) vs a minimal `node:http`
 * server + `fetch()` (representative of the REST path). Both sides keep their
 * connection open (HTTP uses keep-alive), so this is an apples-to-apples
 * comparison of per-request transport overhead — not connection-setup cost.
 *
 * Run:  npm run build && node scripts/bench-ipc-vs-rest.mjs [--iters N] [--warmup M]
 *
 * NOTE: numbers are environment-specific (same machine, in-process servers).
 * They inform the A/B/C decision in #4168 but are not production SLAs.
 */
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { UnixSocketIpcServer, UnixSocketIpcClient } from '@disclaude/core';

const iters = Number(process.argv.indexOf('--iters') >= 0 ? process.argv[process.argv.indexOf('--iters') + 1] : 1000);
const warmup = Number(process.argv.indexOf('--warmup') >= 0 ? process.argv[process.argv.indexOf('--warmup') + 1] : 50);

const SOCKET_PATH = join(tmpdir(), `bench-ipc-${process.pid}.sock`);

/** IPC handler: respond to `ping` with `{ pong: true }`, echoing the request id. */
const ipcHandler = async (req) => ({ id: req.id, success: true, payload: { pong: true } });

async function benchIpc() {
  const server = new UnixSocketIpcServer(ipcHandler, { socketPath: SOCKET_PATH });
  await server.start();
  const client = new UnixSocketIpcClient({ socketPath: SOCKET_PATH });

  // warmup
  for (let i = 0; i < warmup; i++) await client.ping();

  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    const ok = await client.ping();
    if (!ok) throw new Error('IPC ping returned false during benchmark');
  }
  const t1 = performance.now();

  await client.disconnect?.();
  await server.stop();
  return t1 - t0;
}

async function benchHttp() {
  const httpServer = createServer((req, res) => {
    if (req.url === '/api/ping') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  const url = `http://127.0.0.1:${port}/api/ping`;

  // warmup (also primes the keep-alive connection)
  for (let i = 0; i < warmup; i++) {
    const r = await fetch(url);
    await r.json();
  }

  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    const r = await fetch(url);
    const body = await r.json();
    if (!body.ok) throw new Error('HTTP ping returned !ok during benchmark');
  }
  const t1 = performance.now();

  await new Promise((resolve) => httpServer.close(resolve));
  return t1 - t0;
}

function fmt(ms) {
  const usPerOp = (ms * 1000) / iters;
  const opsPerSec = iters / (ms / 1000);
  return `${ms.toFixed(1)} ms total | ${usPerOp.toFixed(1)} µs/op | ${opsPerSec.toFixed(0).padStart(6)} ops/s`;
}

const ipcMs = await benchIpc();
const httpMs = await benchHttp();

const ratio = httpMs / ipcMs;
console.log(`\n# IPC vs REST round-trip latency  (iters=${iters}, warmup=${warmup})`);
console.log(`  Unix-socket IPC : ${fmt(ipcMs)}`);
console.log(`  REST HTTP       : ${fmt(httpMs)}`);
console.log(`  HTTP / IPC ratio: ${ratio.toFixed(2)}x  (HTTP is ${ratio >= 1 ? ratio.toFixed(2) + 'x slower' : (1 / ratio).toFixed(2) + 'x faster'} than IPC)\n`);
process.exit(0);
