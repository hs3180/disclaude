import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
export async function connectBrowser(socketPath) {
  const socket = createConnection(socketPath);
  socket.setEncoding('utf8');
  let counter = 0, buffer = '', lastRequest;
  const pending = new Map();
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 3 * 1024 * 1024) { socket.destroy(new Error('IPC response too large')); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      let message;
      try { message = JSON.parse(buffer.slice(0, index)); } catch { socket.destroy(new Error('Invalid IPC response')); return; }
      buffer = buffer.slice(index + 1);
      const item = pending.get(message.id);
      if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error)) : item.resolve(message.result); }
    }
  });
  const rejectAll = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  socket.on('error', error => rejectAll(new Error(`Browser IPC error; in-flight outcome may be unknown (pending=${pending.size}, lastRequest=${lastRequest ? `${lastRequest.id}:${lastRequest.method}` : 'none'}): ${error.message}`)));
  socket.on('close', () => rejectAll(new Error(`Browser IPC closed; in-flight outcome may be unknown (pending=${pending.size}, lastRequest=${lastRequest ? `${lastRequest.id}:${lastRequest.method}` : 'none'})`)));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return {
    request(method, args = {}) {
      if (socket.destroyed) return Promise.reject(new Error('Browser IPC closed'));
      return new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser request timeout; outcome unknown')); socket.destroy(); }, 190000);
        lastRequest = { id, method };
        pending.set(id, { resolve, reject, timer }); socket.write(JSON.stringify({ id, method, ...args }) + '\n');
      });
    },
    close() { socket.destroy(); },
  };
}
export async function main() {
  if (process.argv.includes('--help')) {
    console.log('Pipe a Python browser-use script on stdin. The configured IPC service queues, executes, and releases one operation segment.');
    return;
  }
  if (process.argv.length > 2) throw new Error('Coordinated browser-use accepts stdin scripts only; daemon lifecycle is owned by the service');
  if (!process.env.DISCLAUDE_BROWSER_SOCKET) throw new Error('DISCLAUDE_BROWSER_SOCKET is required');
  let code = ''; for await (const chunk of process.stdin) { code += chunk; if (code.length > 1024 * 1024) throw new Error('Script too large'); }
  if (!code.trim()) throw new Error('Pipe a Python browser-use script on stdin');
  const client = await connectBrowser(process.env.DISCLAUDE_BROWSER_SOCKET);
  await withBrowserLease(client, async () => {
    const result = await client.request('execute', { script: code, cwd: process.cwd() });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    process.exitCode = result.code === 0 ? 0 : 1;
  }, () => process.stderr.write('Browser control queued\n'));
}
/** Maintain heartbeats only while owning/executing the segment, not while releasing it. */
export async function withBrowserLease(client, execute, onQueued = () => {}) {
  let heartbeat;
  let releasing = false;
  try {
    const initial = await client.request('acquire');
    if (initial.state === 'queued') onQueued();
    await client.request('wait');
    heartbeat = setInterval(() => {
      client.request('heartbeat').catch(() => { if (!releasing) client.close(); });
    }, 1000);
    await execute();
    // Reclamation can outlast a heartbeat interval. A late heartbeat rejection
    // no longer describes execution ownership and must not abort the release ack.
    releasing = true;
    clearInterval(heartbeat);
    await client.request('release');
  } finally { releasing = true; clearInterval(heartbeat); client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
