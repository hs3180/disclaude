import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import nock from 'nock';
import { closeChromiumGracefully } from '../scripts/browser-service-state.mjs';

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('graceful browser shutdown ownership', () => {
  it.each(['foreign-listener', 'foreign-websocket', 'changed-owner'])('refuses %s without sending a browser command', async scenario => {
    let requests = 0, upgrades = 0, stateReads = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${scenario === 'foreign-websocket' ? port + 1 : port}/devtools/browser/probe` }));
    });
    server.on('upgrade', (_request, socket) => { upgrades++; socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    nock.enableNetConnect(host => host.startsWith('127.0.0.1:'));
    try {
      const state = () => ({ pid: scenario === 'foreign-listener' || (scenario === 'changed-owner' && stateReads++ > 0)
        ? 2147483647 : process.pid });
      expect(await closeChromiumGracefully({ address: '127.0.0.1', port }, state)).toBe(false);
      expect(requests).toBe(scenario === 'foreign-listener' ? 0 : 1);
      expect(upgrades).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      nock.enableNetConnect('localhost');
    }
  });
});
