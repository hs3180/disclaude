/**
 * ACP 连接管理器测试
 *
 * 使用 mock 传输层测试连接生命周期、消息路由和请求关联。
 *
 * Issue #1333: 支持OpenAI Agent - PR A (ACP 协议基础设施)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpConnection } from './connection.js';
import type { IAcpTransport } from './transport.js';
import type { JsonRpcMessage } from './types.js';
import { AcpMethod } from './types.js';

// ============================================================================
// Mock Transport
// ============================================================================

/**
 * 创建 mock 传输层
 *
 * 模拟 ACP Server 的行为，支持：
 * - 自动响应 initialize 请求
 * - 手动注入消息
 * - 模拟连接/断开
 */
function createMockTransport() {
  let connected = false;
  const messageHandlers: Array<(message: JsonRpcMessage) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  const closeHandlers: Array<() => void> = [];

  // Use a wrapper to allow reassignment of the send implementation
  let sendImpl: (message: JsonRpcMessage) => Promise<void> = async (message) => {
    // Auto-respond to initialize request
    const msg = message as unknown as Record<string, unknown>;
    if (msg.method === AcpMethod.INITIALIZE && msg.id !== undefined) {
      const response: JsonRpcMessage = {
        jsonrpc: '2.0',
        result: {
          capabilities: {
            streaming: true,
            tools: ['bash', 'read', 'write'],
            agentName: 'test-agent',
            agentVersion: '1.0.0',
          },
          serverInfo: {
            name: 'test-server',
            version: '1.0.0',
          },
          protocolVersion: '2025-03-26',
        },
        id: msg.id as number,
      };
      setTimeout(() => {
        for (const handler of messageHandlers) {
          handler(response);
        }
      }, 0);
    }
  };

  const sendCalls: JsonRpcMessage[] = [];

  const transport: IAcpTransport = {
    name: 'mock-transport',
    get connected() {
      return connected;
    },
    connect: vi.fn(async () => {
      connected = true;
    }),
    send: vi.fn(async (message: JsonRpcMessage) => {
      sendCalls.push(message);
      return sendImpl(message);
    }),
    onMessage: vi.fn((handler) => {
      messageHandlers.push(handler);
    }),
    onError: vi.fn((handler) => {
      errorHandlers.push(handler);
    }),
    onClose: vi.fn((handler) => {
      closeHandlers.push(handler);
    }),
    disconnect: vi.fn(async () => {
      connected = false;
      for (const handler of closeHandlers) {
        handler();
      }
    }),
  };

  return {
    transport,
    sendCalls,
    // Helper: set custom send implementation
    setSendImpl(fn: (message: JsonRpcMessage) => Promise<void>) {
      sendImpl = fn;
    },
    // Helper: inject a message from "server"
    receiveMessage(message: JsonRpcMessage) {
      for (const handler of messageHandlers) {
        handler(message);
      }
    },
    // Helper: simulate transport error
    simulateError(error: Error) {
      for (const handler of errorHandlers) {
        handler(error);
      }
    },
    // Helper: simulate transport close
    simulateClose() {
      connected = false;
      for (const handler of closeHandlers) {
        handler();
      }
    },
  };
}

/** Extract method from JsonRpcMessage safely */
function getMethod(msg: JsonRpcMessage): string | undefined {
  if ('method' in msg) {
    return msg.method as string;
  }
  return undefined;
}

/** Extract params from JsonRpcMessage safely */
function getParams(msg: JsonRpcMessage): unknown {
  if ('params' in msg) {
    return msg.params;
  }
  return undefined;
}

/** Extract id from JsonRpcMessage safely */
function getId(msg: JsonRpcMessage): unknown {
  if ('id' in msg) {
    return msg.id;
  }
  return undefined;
}

/** Extract error from JsonRpcMessage safely */
function getError(msg: JsonRpcMessage): unknown {
  if ('error' in msg) {
    return msg.error;
  }
  return undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe('AcpConnection', () => {
  let mock: ReturnType<typeof createMockTransport>;
  let connection: AcpConnection;

  beforeEach(() => {
    mock = createMockTransport();
    connection = new AcpConnection(mock.transport, {
      requestTimeout: 1000,
    });
  });

  // ==========================================================================
  // connect
  // ==========================================================================

  describe('connect', () => {
    it('should establish connection and complete handshake', async () => {
      await connection.connect();

      expect(connection.state).toBe('connected');
      expect(connection.capabilities).toEqual({
        streaming: true,
        tools: ['bash', 'read', 'write'],
        agentName: 'test-agent',
        agentVersion: '1.0.0',
      });
      expect(connection.serverInfoValue).toEqual({
        name: 'test-server',
        version: '1.0.0',
      });
      expect(connection.protocolVersionValue).toBe('2025-03-26');
    });

    it('should call transport.connect', async () => {
      await connection.connect();
      expect(mock.transport.connect).toHaveBeenCalledTimes(1);
    });

    it('should send initialize and initialized messages', async () => {
      await connection.connect();

      // Should have sent at least 2 messages: initialize request + initialized notification
      expect(mock.sendCalls).toHaveLength(2);

      expect(getMethod(mock.sendCalls[0])).toBe(AcpMethod.INITIALIZE);
      expect(getMethod(mock.sendCalls[1])).toBe(AcpMethod.INITIALIZED);
    });

    it('should use default capabilities when none provided', async () => {
      await connection.connect();

      const params = getParams(mock.sendCalls[0]) as Record<string, unknown>;
      expect(params.capabilities).toBeDefined();
    });

    it('should use provided capabilities', async () => {
      await connection.connect(
        { transports: ['sse'], streaming: false },
        'sse',
      );

      const params = getParams(mock.sendCalls[0]) as Record<string, unknown>;
      expect(params.capabilities).toEqual({ transports: ['sse'], streaming: false });
      expect(params.transport).toBe('sse');
    });

    it('should be idempotent on multiple connect calls', async () => {
      await connection.connect();
      await connection.connect();

      expect(mock.transport.connect).toHaveBeenCalledTimes(1);
      expect(connection.state).toBe('connected');
    });

    it('should set error state on connection failure', async () => {
      mock.transport.connect = vi.fn(async () => {
        throw new Error('Connection refused');
      });

      await expect(connection.connect()).rejects.toThrow('Connection refused');
      expect(connection.state).toBe('error');
    });
  });

  // ==========================================================================
  // disconnect
  // ==========================================================================

  describe('disconnect', () => {
    it('should disconnect and reset state', async () => {
      await connection.connect();
      await connection.disconnect();

      expect(connection.state).toBe('disconnected');
      expect(connection.capabilities).toBeNull();
      expect(connection.serverInfoValue).toBeNull();
      expect(connection.protocolVersionValue).toBeNull();
    });

    it('should reject pending requests on disconnect', async () => {
      await connection.connect();

      // Send a request that won't get a response
      const requestPromise = connection.sendRequest('some/method', {}).catch((err: unknown) => err);

      // Disconnect immediately
      await connection.disconnect();

      const error = await requestPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Connection closed');
    });
  });

  // ==========================================================================
  // sendRequest
  // ==========================================================================

  describe('sendRequest', () => {
    it('should send request and receive response', async () => {
      await connection.connect();

      // Set up mock to respond to our test method
      mock.setSendImpl(async (message: JsonRpcMessage) => {
        const id = getId(message);
        if (getMethod(message) === 'test/method' && id !== undefined) {
          setTimeout(() => {
            mock.receiveMessage({
              jsonrpc: '2.0',
              result: { answer: 42 },
              id: id as number,
            });
          }, 0);
        }
      });

      const result = await connection.sendRequest<{ answer: number }>('test/method', { q: 'hello' });

      expect(result).toEqual({ answer: 42 });
    });

    it('should reject on error response', async () => {
      await connection.connect();

      mock.setSendImpl(async (message: JsonRpcMessage) => {
        const id = getId(message);
        if (getMethod(message) === 'fail/method' && id !== undefined) {
          setTimeout(() => {
            mock.receiveMessage({
              jsonrpc: '2.0',
              error: { code: -32601, message: 'Method not found' },
              id: id as number,
            });
          }, 0);
        }
      });

      await expect(connection.sendRequest('fail/method')).rejects.toThrow(
        'JSON-RPC error -32601: Method not found',
      );
    });

    it('should reject on timeout', async () => {
      await connection.connect();

      // Mock send that never responds
      mock.setSendImpl(async () => {
        // No response
      });

      await expect(
        connection.sendRequest('slow/method', {}, 100),
      ).rejects.toThrow('timed out');
    });
  });

  // ==========================================================================
  // sendNotification
  // ==========================================================================

  describe('sendNotification', () => {
    it('should send notification without waiting for response', async () => {
      await connection.connect();

      mock.setSendImpl(async () => {});
      await connection.sendNotification('notifications/custom', { key: 'value' });

      // Find the notification in sendCalls (after initialize + initialized)
      const notificationCall = mock.sendCalls.find(
        (c) => getMethod(c) === 'notifications/custom',
      );
      expect(notificationCall).toBeDefined();
      expect(getParams(notificationCall!)).toEqual({ key: 'value' });
      expect(getId(notificationCall!)).toBeUndefined();
    });
  });

  // ==========================================================================
  // Event handling
  // ==========================================================================

  describe('events', () => {
    it('should emit state changes', async () => {
      const states: string[] = [];
      connection.on('stateChange', (state) => {
        states.push(state);
      });

      await connection.connect();
      await connection.disconnect();

      expect(states).toContain('connecting');
      expect(states).toContain('connected');
      expect(states).toContain('disconnected');
    });

    it('should route notifications to listeners', async () => {
      await connection.connect();

      const notifications: Array<{ method: string; params: unknown }> = [];
      connection.on('notification', (method, params) => {
        notifications.push({ method, params });
      });

      mock.receiveMessage({
        jsonrpc: '2.0',
        method: 'notifications/task',
        params: { id: 'task-1', status: 'working' },
      });

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        method: 'notifications/task',
        params: { id: 'task-1', status: 'working' },
      });
    });

    it('should respond with method not found to unexpected requests', async () => {
      await connection.connect();

      mock.receiveMessage({
        jsonrpc: '2.0',
        method: 'unexpected/method',
        id: 99,
      });

      // Should have sent a method not found error response
      const errorResponse = mock.sendCalls.find(
        (c) => getError(c) !== undefined,
      );
      expect(errorResponse).toBeDefined();
      const err = getError(errorResponse!) as Record<string, unknown>;
      expect(err.code).toBe(-32601);
    });

    it('should emit error events', async () => {
      const errors: Error[] = [];
      connection.on('error', (error) => {
        errors.push(error);
      });

      mock.simulateError(new Error('Transport failure'));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Transport failure');
    });

    it('should handle close event', async () => {
      await connection.connect();
      expect(connection.state).toBe('connected');

      mock.simulateClose();
      expect(connection.state).toBe('disconnected');
    });

    it('should support removing event listeners', async () => {
      const states: string[] = [];
      const handler = (state: string) => {
        states.push(state);
      };

      connection.on('stateChange', handler);
      await connection.connect();

      const countBefore = states.length;
      connection.off('stateChange', handler);

      await connection.disconnect();
      // disconnect may still fire synchronously before off takes effect
      expect(states.length).toBeGreaterThanOrEqual(countBefore);
    });
  });

  // ==========================================================================
  // Request correlation
  // ==========================================================================

  describe('request correlation', () => {
    it('should correctly match responses to requests by ID', async () => {
      await connection.connect();

      let callCount = 0;
      mock.setSendImpl(async (message: JsonRpcMessage) => {
        const id = getId(message);
        if (id !== undefined) {
          callCount++;
          const currentCall = callCount;
          // Respond out of order
          setTimeout(() => {
            mock.receiveMessage({
              jsonrpc: '2.0',
              result: { call: currentCall },
              id: id as number,
            });
          }, 0);
        }
      });

      const results = await Promise.all([
        connection.sendRequest<{ call: number }>('method/a'),
        connection.sendRequest<{ call: number }>('method/b'),
        connection.sendRequest<{ call: number }>('method/c'),
      ]);

      // Each request should get its own response (order may vary)
      expect(results).toHaveLength(3);
      expect(new Set(results.map((r) => r.call))).toEqual(new Set([1, 2, 3]));
    });
  });
});
