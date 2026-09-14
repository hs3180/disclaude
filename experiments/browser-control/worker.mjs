import { connect } from './cdp.mjs';
let transport;
let session;
let stopping = false;
function send(message) { if (process.connected) process.send(message); }
process.on('message', async message => {
  try {
    if (message.kind === 'init') {
      transport = await connect(message.url);
      transport.closed.then(() => { if (!stopping) process.exit(2); });
      session = (await transport.call('Target.attachToTarget', { targetId: message.target, flatten: true })).sessionId;
      send({ kind: 'ready' });
    } else if (message.kind === 'execute') {
      // A finite local fixture protocol; no arbitrary browser commands from callers.
      const expressions = {
        read: "document.querySelector('#value').textContent",
        write: `document.querySelector('#value').textContent=${JSON.stringify(message.value)}`,
        stall: 'new Promise(()=>{})', // fault injection only; never replayed
      };
      let result;
      if (message.command === 'screenshot') result = await transport.call('Page.captureScreenshot', { format: 'png' }, session);
      else {
        if (!Object.hasOwn(expressions, message.command)) throw new Error('Unsupported lab command');
        const response = await transport.call('Runtime.evaluate', { expression: expressions[message.command], returnByValue: true, awaitPromise: true }, session);
        if (response.exceptionDetails) throw new Error('Fixture evaluation failed');
        result = response.result.value;
      }
      send({ kind: 'result', id: message.id, result });
    } else if (message.kind === 'disconnect') {
      await transport.close();
    } else if (message.kind === 'stop') {
      stopping = true;
      if (transport) await transport.close();
      process.exit(0);
    }
  } catch (error) {
    if (message.kind === 'init') { send({ kind: 'init-error', error: error.message }); process.exit(2); }
    else send({ kind: 'result', id: message.id, error: error.message });
  }
});
process.on('disconnect', () => process.exit(3));
