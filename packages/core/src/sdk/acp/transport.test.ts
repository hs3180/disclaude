/**
 * Tests for ACP HTTP/SSE transport layer.
 *
 * Uses a local HTTP server for realistic integration testing.
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import nock from 'nock';
import { createServer } from 'node:http';
import { AcpHttpTransport, AcpTransportError, type IAcpTransport } from './transport.js';
import { createUserMessage } from './types.js';

// 完全禁用 nock 的网络拦截（本测试文件使用真实 HTTP 服务器）
beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect(/.*/);
});

afterAll(() => {
  nock.restore();
  nock.activate();
});

/** 启动测试 HTTP 服务器，返回 { port, close } */
function startTestServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}

describe('AcpHttpTransport', () => {
  let transport: IAcpTransport;
  let server: { port: number; close: () => void };

  afterEach(() => {
    transport.dispose();
    server?.close();
  });

  describe('ping', () => {
    it('should return true when server responds', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('pong');
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      const result = await transport.ping();
      expect(result).toBe(true);
    });

    it('should return false when server returns error', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(500);
        res.end('Internal Server Error');
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      const result = await transport.ping();
      expect(result).toBe(false);
    });
  });

  describe('listAgents', () => {
    it('should return list of agents', async () => {
      server = await startTestServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agents: [
            { name: 'echo', description: 'Echo', input_content_types: ['text/plain'], output_content_types: ['text/plain'] },
            { name: 'translator', description: 'Translator', input_content_types: ['text/plain'], output_content_types: ['text/plain'] },
          ],
        }));
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      const result = await transport.listAgents();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('echo');
      expect(result[1].name).toBe('translator');
    });

    it('should pass limit and offset parameters', async () => {
      let receivedPath = '';
      server = await startTestServer((req, res) => {
        receivedPath = req.url ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: [] }));
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      await transport.listAgents(10, 20);
      expect(receivedPath).toContain('limit=10');
      expect(receivedPath).toContain('offset=20');
    });
  });

  describe('getAgent', () => {
    it('should return agent manifest', async () => {
      const manifest = {
        name: 'echo',
        description: 'Echo agent',
        input_content_types: ['text/plain'],
        output_content_types: ['text/plain'],
        metadata: { capabilities: [{ name: 'echo', description: 'Echoes input' }] },
      };

      server = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(manifest));
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      const result = await transport.getAgent('echo');
      expect(result.name).toBe('echo');
      expect(result.metadata?.capabilities).toHaveLength(1);
    });

    it('should URL-encode agent name', async () => {
      let receivedPath = '';
      server = await startTestServer((req, res) => {
        receivedPath = req.url ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'my agent', description: 'Test', input_content_types: [], output_content_types: [] }));
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      await transport.getAgent('my agent');
      expect(receivedPath).toContain('my%20agent');
    });

    it('should throw on 404', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(404);
        res.end('Not Found');
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      await expect(transport.getAgent('nonexistent')).rejects.toThrow(AcpTransportError);
    });
  });

  describe('createRun', () => {
    it('should create a sync run', async () => {
      const runResponse = {
        run_id: 'run-123',
        agent_name: 'echo',
        status: 'completed',
        mode: 'sync',
        output: [{ role: 'agent', parts: [{ content_type: 'text/plain', content: 'Hello!' }] }],
        created_at: '2026-04-06T00:00:00Z',
        finished_at: '2026-04-06T00:00:01Z',
      };

      let receivedBody = '';
      server = await startTestServer((req, res) => {
        req.on('data', (chunk) => { receivedBody += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(runResponse));
        });
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      const result = await transport.createRun({
        agent_name: 'echo',
        input: [createUserMessage('Hi')],
        mode: 'sync',
      });

      expect(result.run_id).toBe('run-123');
      expect(result.status).toBe('completed');
      const parsed = JSON.parse(receivedBody);
      expect(parsed.agent_name).toBe('echo');
      expect(parsed.mode).toBe('sync');
    });

    it('should default to sync mode', async () => {
      let receivedBody = '';
      server = await startTestServer((req, res) => {
        req.on('data', (chunk) => { receivedBody += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ run_id: 'run-1', agent_name: 'echo', status: 'created', mode: 'sync', created_at: '2026-04-06T00:00:00Z' }));
        });
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      await transport.createRun({
        agent_name: 'echo',
        input: [createUserMessage('test')],
      });

      const parsed = JSON.parse(receivedBody);
      expect(parsed.mode).toBe('sync');
    });

    it('should handle async mode (202)', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ run_id: 'run-async', agent_name: 'echo', status: 'created', mode: 'async', created_at: '2026-04-06T00:00:00Z' }));
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      const result = await transport.createRun({
        agent_name: 'echo',
        input: [createUserMessage('test')],
        mode: 'async',
      });

      expect(result.run_id).toBe('run-async');
    });
  });

  describe('getRun', () => {
    it('should return run status', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ run_id: 'run-123', agent_name: 'echo', status: 'in-progress', mode: 'async', created_at: '2026-04-06T00:00:00Z' }));
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      const result = await transport.getRun('run-123');
      expect(result.status).toBe('in-progress');
    });
  });

  describe('cancelRun', () => {
    it('should cancel a run', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      await expect(transport.cancelRun('run-123')).resolves.toBeUndefined();
    });
  });

  describe('getSession', () => {
    it('should return session info', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'session-456', agent_name: 'echo' }));
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      const result = await transport.getSession('session-456');
      expect(result.id).toBe('session-456');
    });
  });

  describe('error handling', () => {
    it('should throw AcpTransportError on server error', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      await expect(transport.listAgents()).rejects.toThrow(AcpTransportError);
    });

    it('should throw AcpTransportError on client error', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });

      await expect(transport.listAgents()).rejects.toThrow(AcpTransportError);
    });
  });

  describe('dispose', () => {
    it('should prevent requests after disposal', async () => {
      server = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('pong');
      });

      transport = new AcpHttpTransport({
        baseUrl: `http://127.0.0.1:${server.port}`,
        retries: 0,
        timeout: 5000,
      });
      transport.dispose();

      // ping catches errors and returns false, but request should fail
      const result = await transport.ping();
      expect(result).toBe(false);
    });
  });
});

describe('AcpTransportError', () => {
  it('should store status code', () => {
    const error = new AcpTransportError('test', 404);
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('test');
    expect(error.name).toBe('AcpTransportError');
  });

  it('should store cause', () => {
    const cause = new Error('network failure');
    const error = new AcpTransportError('test', 0, cause);
    expect(error.cause).toBe(cause);
  });
});
