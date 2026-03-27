/**
 * ACP 连接管理器测试
 *
 * 测试 AcpConnection 的连接生命周期、能力协商、请求/响应匹配和通知分发。
 * 使用模拟传输层（依赖注入）进行隔离测试。
 *
 * @module sdk/providers/acp/connection.test
 */

import { describe, it, expect, vi } from 'vitest';
import { AcpConnection } from './connection.js';
import { AcpMethod, JsonRpcErrorCode, type JsonRpcMessage, type JsonRpcRequest } from './types.js';
import type { IAcpTransport } from './transport.js';

/**
 * 创建可控的模拟传输层
 */
function createControllableMockTransport() {
  let connected = false;
  let messageHandler: ((msg: JsonRpcMessage) => void) | null = null;
  let errorHandler: ((err: Error) => void) | null = null;
  let closeHandler: ((code: number | null) => void) | null = null;
  const sentMessages: JsonRpcMessage[] = [];

  const transport: IAcpTransport = {
    get connected() { return connected; },
    send: vi.fn((msg: JsonRpcMessage) => sentMessages.push(msg)),
    onMessage: vi.fn((handler: (msg: JsonRpcMessage) => void) => { messageHandler = handler; }),
    onError: vi.fn((handler: (err: Error) => void) => { errorHandler = handler; }),
    onClose: vi.fn((handler: (code: number | null) => void) => { closeHandler = handler; }),
    connect: vi.fn(() => { connected = true; return Promise.resolve(); }),
    disconnect: vi.fn(() => { connected = false; }),
  };

  return {
    transport,
    /** Simulate server sending a message */
    serverSend: (msg: JsonRpcMessage) => messageHandler?.(msg),
    /** Simulate transport error */
    serverError: (err: Error) => errorHandler?.(err),
    /** Simulate transport close */
    serverClose: (code: number | null) => closeHandler?.(code),
    /** Get all messages sent by the client */
    getSentMessages: () => [...sentMessages],
  };
}

/**
 * Helper: complete the initialize handshake for a connection
 */
async function completeHandshake(
  conn: AcpConnection,
  mock: ReturnType<typeof createControllableMockTransport>,
  serverCapabilities: Record<string, unknown> = {}
) {
  const connectPromise = conn.connect();
  await vi.waitFor(() => {
    const initReq = mock.getSentMessages().find(
      (m) => (m as JsonRpcRequest).method === AcpMethod.INITIALIZE
    );
    return expect(initReq).toBeDefined();
  });

  const initRequest = mock.getSentMessages().find(
    (m) => (m as JsonRpcRequest).method === AcpMethod.INITIALIZE
  ) as JsonRpcRequest;

  mock.serverSend({
    jsonrpc: '2.0',
    id: initRequest.id,
    result: {
      serverName: 'test-server',
      serverVersion: '1.0.0',
      protocolVersion: '2025-01-01',
      capabilities: {
        models: [],
        ...serverCapabilities,
      },
    },
  });

  return connectPromise;
}

describe('AcpConnection', () => {
  describe('construction', () => {
    it('should create with mock transport (dependency injection)', () => {
      const { transport } = createControllableMockTransport();
      const conn = new AcpConnection(transport);

      expect(conn.isConnected).toBe(false);
      expect(conn.getState()).toBe('disconnected');
      expect(conn.getServerCapabilities()).toBeNull();
    });

    it('should create with options', () => {
      const { transport } = createControllableMockTransport();
      const conn = new AcpConnection(transport, {
        clientName: 'test-client',
        clientVersion: '2.0.0',
        requestTimeout: 5000,
      });

      expect(conn.isConnected).toBe(false);
      expect(conn.getState()).toBe('disconnected');
    });
  });

  describe('connect', () => {
    it('should establish connection and negotiate capabilities', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);

      const capabilities = await completeHandshake(conn, mock, {
        models: [{ id: 'test-model', contextWindow: 100000 }],
        toolUse: true,
        streaming: true,
      });

      expect(conn.isConnected).toBe(true);
      expect(conn.getState()).toBe('connected');
      expect(capabilities.models).toHaveLength(1);
      expect(capabilities.models?.[0].id).toBe('test-model');
      expect(conn.getProtocolVersion()).toBe('2025-01-01');
    });

    it('should throw on connection failure', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);

      (mock.transport.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Command not found')
      );

      await expect(conn.connect()).rejects.toThrow('Command not found');
      expect(conn.getState()).toBe('error');
    });

    it('should throw on initialize error response', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);

      const connectPromise = conn.connect();
      await vi.waitFor(() => {
        const initReq = mock.getSentMessages().find(
          (m) => (m as JsonRpcRequest).method === AcpMethod.INITIALIZE
        );
        return expect(initReq).toBeDefined();
      });

      const initRequest = mock.getSentMessages().find(
        (m) => (m as JsonRpcRequest).method === AcpMethod.INITIALIZE
      ) as JsonRpcRequest;

      mock.serverSend({
        jsonrpc: '2.0',
        id: initRequest.id,
        error: {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: 'Server initialization failed',
        },
      });

      await expect(connectPromise).rejects.toThrow('Server initialization failed');
      expect(conn.getState()).toBe('error');
    });
  });

  describe('sendRequest', () => {
    it('should send request and receive response', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);
      await completeHandshake(conn, mock);

      // Send a task request
      const taskPromise = conn.sendRequest(AcpMethod.TASK_SEND, {
        taskId: 'task-123',
        message: { role: 'user', content: 'Hello' },
      });

      await vi.waitFor(() => {
        const taskReq = mock.getSentMessages().find(
          (m) => (m as JsonRpcRequest).method === AcpMethod.TASK_SEND
        );
        return expect(taskReq).toBeDefined();
      });

      const taskRequest = mock.getSentMessages().find(
        (m) => (m as JsonRpcRequest).method === AcpMethod.TASK_SEND
      ) as JsonRpcRequest;

      // Simulate response
      mock.serverSend({
        jsonrpc: '2.0',
        id: taskRequest.id,
        result: { status: 'queued' },
      });

      const result = await taskPromise;
      expect(result).toEqual({ status: 'queued' });
    });

    it('should throw if not connected', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);

      await expect(
        conn.sendRequest(AcpMethod.TASK_SEND, { taskId: 'test' })
      ).rejects.toThrow('not established');
    });

    it('should reject on timeout', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport, { requestTimeout: 100 });
      await completeHandshake(conn, mock);

      // Send request that will timeout (no response)
      await expect(
        conn.sendRequest(AcpMethod.TASK_STATUS, { taskId: 'test' })
      ).rejects.toThrow('timed out');
    });

    it('should handle error response', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);
      await completeHandshake(conn, mock);

      const taskPromise = conn.sendRequest(AcpMethod.TASK_SEND, { taskId: 'task-1' });

      await vi.waitFor(() => {
        const taskReq = mock.getSentMessages().find(
          (m) => (m as JsonRpcRequest).method === AcpMethod.TASK_SEND
        );
        return expect(taskReq).toBeDefined();
      });

      const taskRequest = mock.getSentMessages().find(
        (m) => (m as JsonRpcRequest).method === AcpMethod.TASK_SEND
      ) as JsonRpcRequest;

      mock.serverSend({
        jsonrpc: '2.0',
        id: taskRequest.id,
        error: {
          code: JsonRpcErrorCode.INVALID_PARAMS,
          message: 'Invalid task ID',
        },
      });

      await expect(taskPromise).rejects.toThrow('Invalid task ID');
    });
  });

  describe('sendNotification', () => {
    it('should send notification without expecting response', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);
      await completeHandshake(conn, mock);

      conn.sendNotification('custom/notification', { key: 'value' });

      const notifCall = mock.getSentMessages().find(
        (msg) => {
          const m = msg as JsonRpcRequest;
          return m.method === 'custom/notification';
        }
      );
      expect(notifCall).toBeDefined();
      // Notifications should NOT have an id
      expect((notifCall as JsonRpcRequest).id).toBeUndefined();
    });

    it('should warn and skip when not connected', () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);

      // Should not throw, just warn
      expect(() => conn.sendNotification('test', {})).not.toThrow();
      // Transport send should not be called
      expect(mock.transport.send).not.toHaveBeenCalled();
    });
  });

  describe('onNotification', () => {
    it('should dispatch notification messages to handlers', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);
      await completeHandshake(conn, mock);

      const receivedParams: Array<Record<string, unknown>> = [];
      conn.onNotification(AcpMethod.NOTIFICATION_MESSAGE, (params) => {
        receivedParams.push(params);
      });

      mock.serverSend({
        jsonrpc: '2.0',
        method: AcpMethod.NOTIFICATION_MESSAGE,
        params: {
          taskId: 'task-1',
          message: { role: 'assistant', content: 'Hello from server' },
        },
      });

      expect(receivedParams).toHaveLength(1);
      expect(receivedParams[0].taskId).toBe('task-1');
    });

    it('should support removing notification handlers', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);
      await completeHandshake(conn, mock);

      const receivedParams: Array<Record<string, unknown>> = [];
      const handler = (params: Record<string, unknown>) => {
        receivedParams.push(params);
      };

      conn.onNotification(AcpMethod.NOTIFICATION_MESSAGE, handler);
      conn.offNotification(AcpMethod.NOTIFICATION_MESSAGE, handler);

      mock.serverSend({
        jsonrpc: '2.0',
        method: AcpMethod.NOTIFICATION_MESSAGE,
        params: { taskId: 'task-1' },
      });

      expect(receivedParams).toHaveLength(0);
    });
  });

  describe('disconnect', () => {
    it('should reject pending requests on disconnect', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);
      await completeHandshake(conn, mock);

      // Start a request that won't get a response
      const requestPromise = conn.sendRequest(AcpMethod.TASK_STATUS, { taskId: 'pending' });

      // Disconnect immediately
      conn.disconnect();

      await expect(requestPromise).rejects.toThrow('Connection closed');
      expect(conn.isConnected).toBe(false);
      expect(conn.getState()).toBe('disconnected');
    });

    it('should clean up transport on disconnect', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);
      await completeHandshake(conn, mock);

      conn.disconnect();

      expect(mock.transport.disconnect).toHaveBeenCalled();
      expect(conn.getServerCapabilities()).toBeNull();
      expect(conn.getProtocolVersion()).toBe('');
    });
  });

  describe('state events', () => {
    it('should emit state-change events during lifecycle', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);

      const states: string[] = [];
      conn.on('state-change', (state: string) => states.push(state));

      await completeHandshake(conn, mock);
      conn.disconnect();

      expect(states).toContain('connecting');
      expect(states).toContain('connected');
      expect(states).toContain('disconnected');
    });

    it('should emit error events on transport error', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);

      const errors: Error[] = [];
      conn.on('error', (err: Error) => errors.push(err));

      // Connect first
      await completeHandshake(conn, mock);

      // Simulate transport error
      mock.serverError(new Error('Connection reset'));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Connection reset');
      expect(conn.getState()).toBe('error');
    });
  });

  describe('edge cases', () => {
    it('should return cached capabilities on second connect call', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);

      await completeHandshake(conn, mock);
      const capabilities2 = await conn.connect();

      expect(capabilities2).toBeDefined();
      // Should not have sent another initialize request
      const initCount = mock.getSentMessages().filter(
        (m) => (m as JsonRpcRequest).method === AcpMethod.INITIALIZE
      ).length;
      expect(initCount).toBe(1);
    });

    it('should handle response for unknown request ID gracefully', async () => {
      const mock = createControllableMockTransport();
      const conn = new AcpConnection(mock.transport);
      await completeHandshake(conn, mock);

      // Should not throw
      mock.serverSend({
        jsonrpc: '2.0',
        id: 99999,
        result: { unknown: true },
      });

      // Give event loop time to process
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  });
});
