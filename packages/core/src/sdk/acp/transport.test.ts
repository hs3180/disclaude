/**
 * ACP Transport 层测试
 *
 * 包含 MockTransport、JSON-RPC 辅助函数、NDJSON 解析的单元测试。
 * 不使用 vi.mock()，MockTransport 通过实现 IAcpTransport 接口进行依赖注入。
 */

import { describe, it, expect } from 'vitest';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
} from './types.js';
import {
  AcpError,
  AcpStdioTransport,
  createRequest,
  createNotification,
  isResponse,
  isNotification,
  parseNdjsonBuffer,
  type IAcpTransport,
  type AcpMessageHandler,
  type AcpErrorHandler,
  type AcpCloseHandler,
} from './transport.js';

// ============================================================================
// MockTransport
// ============================================================================

/** 用于测试的 Mock Transport */
class MockTransport implements IAcpTransport {
  private _connected = false;
  private messageHandlers: AcpMessageHandler[] = [];
  private errorHandlers: AcpErrorHandler[] = [];
  private closeHandlers: AcpCloseHandler[] = [];
  public sentMessages: (JsonRpcRequest | JsonRpcNotification)[] = [];

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    this._connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this._connected = false;
    return Promise.resolve();
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this._connected) {
      throw new AcpError('Transport is not connected');
    }
    this.sentMessages.push(message);
  }

  onMessage(handler: AcpMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: AcpErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: AcpCloseHandler): void {
    this.closeHandlers.push(handler);
  }

  /** 测试辅助：模拟收到 Agent 消息 */
  simulateMessage(message: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  /** 测试辅助：模拟发生错误 */
  simulateError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  /** 测试辅助：模拟连接关闭 */
  simulateClose(): void {
    this._connected = false;
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

// ============================================================================
// AcpError 测试
// ============================================================================

describe('AcpError', () => {
  it('constructs with message and code', () => {
    const err = new AcpError('test error', -32600);
    expect(err.message).toBe('test error');
    expect(err.code).toBe(-32600);
    expect(err.name).toBe('AcpError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AcpError);
  });

  it('defaults code to -1', () => {
    const err = new AcpError('default code');
    expect(err.code).toBe(-1);
  });
});

// ============================================================================
// JSON-RPC 辅助函数测试
// ============================================================================

describe('createRequest', () => {
  it('builds correct structure', () => {
    const params = { protocolVersion: 1 };
    const req = createRequest('initialize', params, 0);

    expect(req).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: 1 },
    });
  });

  it('preserves numeric id', () => {
    const req = createRequest('test', null, 42);
    expect(req.id).toBe(42);
  });
});

describe('createNotification', () => {
  it('has no id field', () => {
    const notif = createNotification('session/update', { update: {} });

    expect(notif).toEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: {} },
    });
    expect('id' in notif).toBe(false);
  });
});

describe('isResponse', () => {
  it('identifies success responses', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 0,
      result: null,
    };
    expect(isResponse(msg)).toBe(true);
  });

  it('identifies error responses', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request' },
    };
    expect(isResponse(msg)).toBe(true);
  });

  it('returns false for notifications', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {},
    };
    expect(isResponse(msg)).toBe(false);
  });
});

describe('isNotification', () => {
  it('identifies notifications', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {},
    };
    expect(isNotification(msg)).toBe(true);
  });

  it('returns false for success responses', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 0,
      result: null,
    };
    expect(isNotification(msg)).toBe(false);
  });

  it('returns false for error responses', () => {
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request' },
    };
    expect(isNotification(msg)).toBe(false);
  });
});

// ============================================================================
// parseNdjsonBuffer 测试
// ============================================================================

describe('parseNdjsonBuffer', () => {
  it('parses a complete line', () => {
    const result = parseNdjsonBuffer('', '{"jsonrpc":"2.0","id":0,"result":null}\n');
    expect(result.lines).toEqual(['{"jsonrpc":"2.0","id":0,"result":null}']);
    expect(result.remaining).toBe('');
  });

  it('parses multiple lines in a single chunk', () => {
    const data = '{"id":1}\n{"id":2}\n';
    const result = parseNdjsonBuffer('', data);
    expect(result.lines).toEqual(['{"id":1}', '{"id":2}']);
    expect(result.remaining).toBe('');
  });

  it('holds partial line in buffer', () => {
    const result = parseNdjsonBuffer('', '{"partial":');
    expect(result.lines).toEqual([]);
    expect(result.remaining).toBe('{"partial":');

    const result2 = parseNdjsonBuffer(result.remaining, 'true}\n');
    expect(result2.lines).toEqual(['{"partial":true}']);
    expect(result2.remaining).toBe('');
  });

  it('handles partial then complete across chunks', () => {
    const r1 = parseNdjsonBuffer('', '{"a":1}\n{"b":');
    expect(r1.lines).toEqual(['{"a":1}']);
    expect(r1.remaining).toBe('{"b":');

    const r2 = parseNdjsonBuffer(r1.remaining, '2}\n{"c":3}\n');
    expect(r2.lines).toEqual(['{"b":2}', '{"c":3}']);
    expect(r2.remaining).toBe('');
  });

  it('skips empty lines', () => {
    const data = '{"id":1}\n\n\n{"id":2}\n';
    const result = parseNdjsonBuffer('', data);
    expect(result.lines).toEqual(['{"id":1}', '{"id":2}']);
  });

  it('handles empty input', () => {
    const result = parseNdjsonBuffer('', '');
    expect(result.lines).toEqual([]);
    expect(result.remaining).toBe('');
  });
});

// ============================================================================
// MockTransport 测试
// ============================================================================

describe('MockTransport', () => {
  it('starts disconnected', () => {
    const transport = new MockTransport();
    expect(transport.connected).toBe(false);
  });

  it('connect sets connected to true', async () => {
    const transport = new MockTransport();
    await transport.connect();
    expect(transport.connected).toBe(true);
  });

  it('disconnect sets connected to false', async () => {
    const transport = new MockTransport();
    await transport.connect();
    await transport.disconnect();
    expect(transport.connected).toBe(false);
  });

  it('send while disconnected throws AcpError', () => {
    const transport = new MockTransport();
    const req = createRequest('test', null, 0);
    expect(() => transport.send(req)).toThrow(AcpError);
    expect(() => transport.send(req)).toThrow('Transport is not connected');
  });

  it('send stores messages for inspection', async () => {
    const transport = new MockTransport();
    await transport.connect();

    const req = createRequest('initialize', { protocolVersion: 1 }, 0);
    transport.send(req);

    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual(req);
  });

  it('onMessage handler receives simulated messages', () => {
    const transport = new MockTransport();
    const received: JsonRpcMessage[] = [];
    transport.onMessage((msg) => received.push(msg));

    const msg: JsonRpcResponse = { jsonrpc: '2.0', id: 0, result: null };
    transport.simulateMessage(msg);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  it('supports multiple message handlers', () => {
    const transport = new MockTransport();
    const received1: JsonRpcMessage[] = [];
    const received2: JsonRpcMessage[] = [];
    transport.onMessage((msg) => received1.push(msg));
    transport.onMessage((msg) => received2.push(msg));

    const msg: JsonRpcNotification = { jsonrpc: '2.0', method: 'test' };
    transport.simulateMessage(msg);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it('onError handler receives simulated errors', () => {
    const transport = new MockTransport();
    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));

    const err = new Error('test error');
    transport.simulateError(err);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('test error');
  });

  it('onClose handler fires on simulateClose', async () => {
    const transport = new MockTransport();
    await transport.connect();
    let closed = false;
    transport.onClose(() => { closed = true; });

    expect(transport.connected).toBe(true);
    transport.simulateClose();

    expect(closed).toBe(true);
    expect(transport.connected).toBe(false);
  });

  it('multiple close handlers all fire', () => {
    const transport = new MockTransport();
    let closed1 = false;
    let closed2 = false;
    transport.onClose(() => { closed1 = true; });
    transport.onClose(() => { closed2 = true; });

    transport.simulateClose();

    expect(closed1).toBe(true);
    expect(closed2).toBe(true);
  });
});

// ============================================================================
// AcpStdioTransport 测试
// ============================================================================

describe('AcpStdioTransport', () => {
  it('starts disconnected', () => {
    const transport = new AcpStdioTransport({ command: 'node', args: ['-e', 'process.stdin.resume()'] });
    expect(transport.connected).toBe(false);
  });

  it('connect spawns process and sets connected', async () => {
    const transport = new AcpStdioTransport({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
    });
    await transport.connect();
    expect(transport.connected).toBe(true);
    await transport.disconnect();
  });

  it('connect is no-op if already connected', async () => {
    const transport = new AcpStdioTransport({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
    });
    await transport.connect();
    await transport.connect(); // no-op
    expect(transport.connected).toBe(true);
    await transport.disconnect();
  });

  it('disconnect is no-op if not connected', async () => {
    const transport = new AcpStdioTransport({ command: 'node', args: ['-e', 'process.stdin.resume()'] });
    await transport.disconnect(); // no-op, should not throw
  });

  it('send throws if not connected', () => {
    const transport = new AcpStdioTransport({ command: 'node', args: ['-e', 'process.stdin.resume()'] });
    expect(() => transport.send(createRequest('test', null, 0))).toThrow(AcpError);
  });

  it('sends and receives NDJSON messages', async () => {
    // Echo server: reads stdin line, responds with a JSON-RPC result
    const echoCode = `
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        const resp = { jsonrpc: '2.0', id: msg.id, result: { echo: msg.method } };
        process.stdout.write(JSON.stringify(resp) + '\\n');
      });
    `;
    const transport = new AcpStdioTransport({
      command: 'node',
      args: ['-e', echoCode],
    });

    const received: JsonRpcMessage[] = [];
    transport.onMessage((msg) => received.push(msg));

    await transport.connect();
    transport.send(createRequest('initialize', { protocolVersion: 1 }, 0));
    transport.send(createRequest('session/new', { cwd: '/test' }, 1));

    // Wait for responses
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ jsonrpc: '2.0', id: 0, result: { echo: 'initialize' } });
    expect(received[1]).toEqual({ jsonrpc: '2.0', id: 1, result: { echo: 'session/new' } });

    await transport.disconnect();
  });

  it('fires close handler when process exits', async () => {
    // Process exits immediately after writing one line
    const exitCode = `
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 0, result: null }) + '\\n');
      process.exit(0);
    `;
    const transport = new AcpStdioTransport({
      command: 'node',
      args: ['-e', exitCode],
    });

    let closed = false;
    transport.onClose(() => { closed = true; });

    await transport.connect();
    // Wait for process to exit
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(closed).toBe(true);
    expect(transport.connected).toBe(false);
  });

  it('fires error handler on invalid spawn', async () => {
    const transport = new AcpStdioTransport({
      command: 'nonexistent-command-that-does-not-exist',
    });

    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));

    await transport.connect();
    // Give event loop time to emit the error
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(errors.length).toBeGreaterThan(0);
  });

  it('disconnect kills process and clears state', async () => {
    const transport = new AcpStdioTransport({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
    });

    await transport.connect();
    expect(transport.connected).toBe(true);

    await transport.disconnect();
    expect(transport.connected).toBe(false);
  });

  // Issue #2383: Circular reference defense
  it('throws AcpError with diagnostic info on circular reference in params', async () => {
    const transport = new AcpStdioTransport({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
    });

    await transport.connect();

    // Create a circular reference object that mimics an SDK MCP server
    const circular: Record<string, unknown> = { name: 'channel-mcp' };
    circular.root = circular; // creates the circular reference

    const req = createRequest('session/new', {
      cwd: '/test',
      mcpServers: [circular],
    }, 0);

    expect(() => transport.send(req)).toThrow(AcpError);
    expect(() => transport.send(req)).toThrow('circular reference');
    expect(() => transport.send(req)).toThrow('session/new');
    expect(() => transport.send(req)).toThrow('mcpServers');

    await transport.disconnect();
  });

  it('sends normal messages without error', async () => {
    const transport = new AcpStdioTransport({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
    });

    await transport.connect();

    // Normal serializable message should work fine
    const req = createRequest('session/new', {
      cwd: '/test',
      mcpServers: [{ type: 'stdio', name: 'test', command: 'node', args: ['server.js'] }],
    }, 0);

    expect(() => transport.send(req)).not.toThrow();

    await transport.disconnect();
  });
});
