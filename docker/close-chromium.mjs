// Ask our loopback-only browser to flush its profile before container shutdown.
const port = process.argv[2];
try {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error('CDP unavailable');
  const info = await response.json();
  const endpoint = new URL(info.webSocketDebuggerUrl);
  endpoint.hostname = '127.0.0.1';
  endpoint.port = port;
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Browser close timeout')); }, 2000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })), { once: true });
    socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP close failed')); }, { once: true });
  });
} catch {
  console.error('Chromium graceful close unavailable; supervisor will terminate remaining processes.');
  process.exitCode = 1;
}
