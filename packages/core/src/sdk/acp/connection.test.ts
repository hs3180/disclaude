/**
 * Tests for ACP connection manager.
 *
 * Uses a local HTTP server for realistic integration testing.
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import nock from 'nock';
import { createServer } from 'node:http';
import { AcpConnectionManager } from './connection.js';

// 完全禁用 nock 的网络拦截（本测试文件使用真实 HTTP 服务器）
beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/.*/);
});

afterAll(() => {
  nock.restore();
  nock.activate();
});

/** 启动测试 HTTP 服务器 */
function startTestServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe('AcpConnectionManager', () => {
  let manager: AcpConnectionManager;
  let server: { port: number; close: () => void };

  afterEach(() => {
    manager?.disconnect();
    server?.close();
  });

  describe('connect', () => {
    it('should connect when server is available', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('pong');
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      expect(manager.getState()).toBe('connected');
    });

    it('should throw when server is unavailable', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(500);
        res.end('error');
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await expect(manager.connect()).rejects.toThrow('Failed to connect');
      expect(manager.getState()).toBe('error');
    });

    it('should throw on connection timeout', async () => {
      server = await startTestServer((_req) => {
        // 不响应，让请求超时
      });

      const timeoutManager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 100,
        retries: 0,
      });

      await expect(timeoutManager.connect()).rejects.toThrow('timeout');
      expect(timeoutManager.getState()).toBe('error');
      timeoutManager.disconnect();
    });

    it('should be idempotent', async () => {
      let pingCount = 0;
      server = await startTestServer((_req, res) => {
        pingCount++;
        res.writeHead(200);
        res.end('pong');
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      await manager.connect();
      expect(manager.getState()).toBe('connected');
      expect(pingCount).toBe(1);
    });
  });

  describe('disconnect', () => {
    it('should disconnect and clear state', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('pong');
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      manager.disconnect();
      expect(manager.getState()).toBe('disconnected');
    });
  });

  describe('listAgents', () => {
    it('should list agents from server', async () => {
      server = await startTestServer((req, res) => {
        if (req.url === '/ping') {
          res.writeHead(200);
          res.end('pong');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agents: [
            { name: 'echo', description: 'Echo agent', input_content_types: ['text/plain'], output_content_types: ['text/plain'] },
          ],
        }));
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      const agents = await manager.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('echo');
    });

    it('should use cached agents', async () => {
      let agentRequestCount = 0;
      server = await startTestServer((req, res) => {
        if (req.url === '/ping') {
          res.writeHead(200);
          res.end('pong');
          return;
        }
        agentRequestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agents: [{ name: 'echo', description: 'Echo', input_content_types: [], output_content_types: [] }],
        }));
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      await manager.listAgents();
      expect(agentRequestCount).toBe(1);

      await manager.listAgents();
      expect(agentRequestCount).toBe(1);
    });

    it('should throw when not connected', async () => {
      manager = new AcpConnectionManager({
        baseUrl: 'http://127.0.0.1:1',
        healthCheckInterval: 0,
        connectTimeout: 100,
        retries: 0,
      });

      await expect(manager.listAgents()).rejects.toThrow('not connected');
    });
  });

  describe('getAgent', () => {
    it('should get agent manifest', async () => {
      server = await startTestServer((req, res) => {
        if (req.url === '/ping') {
          res.writeHead(200);
          res.end('pong');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'echo', description: 'Echo agent', input_content_types: ['text/plain'], output_content_types: ['text/plain'] }));
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      const agent = await manager.getAgent('echo');
      expect(agent.name).toBe('echo');
    });

    it('should cache agent manifest', async () => {
      let agentRequestCount = 0;
      server = await startTestServer((req, res) => {
        if (req.url === '/ping') {
          res.writeHead(200);
          res.end('pong');
          return;
        }
        agentRequestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'echo', description: 'Echo', input_content_types: [], output_content_types: [] }));
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      await manager.getAgent('echo');
      await manager.getAgent('echo');
      expect(agentRequestCount).toBe(1);
    });
  });

  describe('clearAgentCache', () => {
    it('should clear cached agents', async () => {
      server = await startTestServer((req, res) => {
        if (req.url === '/ping') {
          res.writeHead(200);
          res.end('pong');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agents: [{ name: 'echo', description: 'Echo', input_content_types: [], output_content_types: [] }],
        }));
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      await manager.listAgents();
      manager.clearAgentCache();

      const agents = await manager.listAgents();
      expect(agents).toHaveLength(1);
    });
  });

  describe('getTransport', () => {
    it('should throw when not connected', () => {
      manager = new AcpConnectionManager({
        baseUrl: 'http://127.0.0.1:1',
        healthCheckInterval: 0,
        connectTimeout: 100,
        retries: 0,
      });

      expect(() => manager.getTransport()).toThrow('not connected');
    });

    it('should return transport when connected', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('pong');
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      await manager.connect();
      expect(manager.getTransport()).toBeDefined();
    });
  });

  describe('onStateChange', () => {
    it('should notify on state changes', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('pong');
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      const states: string[] = [];
      const unsubscribe = manager.onStateChange((state) => {
        states.push(state);
      });

      await manager.connect();
      manager.disconnect();

      expect(states).toContain('connecting');
      expect(states).toContain('connected');
      expect(states).toContain('disconnected');

      unsubscribe();
    });

    it('should stop receiving updates after unsubscribe', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('pong');
      });

      manager = new AcpConnectionManager({
        baseUrl: `http://127.0.0.1:${server.port}`,
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      const states: string[] = [];
      const unsubscribe = manager.onStateChange((state) => {
        states.push(state);
      });

      await manager.connect();
      unsubscribe();
      manager.disconnect();

      expect(states.length).toBeLessThanOrEqual(2);
    });
  });

  describe('getBaseUrl', () => {
    it('should return the configured base URL', () => {
      manager = new AcpConnectionManager({
        baseUrl: 'http://example.com:9000',
        healthCheckInterval: 0,
        connectTimeout: 5000,
        retries: 0,
      });

      expect(manager.getBaseUrl()).toBe('http://example.com:9000');
    });
  });
});
