/** Private CDP transport for the managed browser service. */
import WebSocket from 'ws';
export async function connect(url) {
  const ws = new WebSocket(url);
  let sequence = 0;
  const pending = new Map();
  const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect error')); }, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP disconnected; outcome may be unknown')); }
    pending.clear();
  });
  return {
    ws, closed,
    call(method, params = {}, sessionId) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP unavailable'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP response timeout; outcome may be unknown')); }, 5000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    async close() { ws.close(); await closed; },
  };
}
