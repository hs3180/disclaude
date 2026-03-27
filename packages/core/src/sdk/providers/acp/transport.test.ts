/**
 * ACP 传输层测试
 *
 * 使用 mock 子进程测试 StdioTransport 和 createTransport。
 * 不使用 vi.mock()，而是通过模拟接口进行测试。
 *
 * @module sdk/providers/acp/transport.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
} from './types.js';
import { createTransport, type IAcpTransport } from './transport.js';

/**
 * 创建模拟传输层用于测试
 */
function createMockTransport(): {
  transport: IAcpTransport;
  simulateMessage: (message: JsonRpcMessage) => void;
  simulateError: (error: Error) => void;
  simulateClose: (code: number | null) => void;
} {
  const handlers = {
    message: [] as Array<(msg: JsonRpcMessage) => void>,
    error: [] as Array<(err: Error) => void>,
    close: [] as Array<(code: number | null) => void>,
  };
  let connected = false;

  const transport: IAcpTransport = {
    get connected() { return connected; },
    send: vi.fn(),
    onMessage: vi.fn((handler) => { handlers.message.push(handler); }),
    onError: vi.fn((handler) => { handlers.error.push(handler); }),
    onClose: vi.fn((handler) => { handlers.close.push(handler); }),
    connect: vi.fn(() => { connected = true; return Promise.resolve(); }),
    disconnect: vi.fn(() => { connected = false; }),
  };

  return {
    transport,
    simulateMessage: (msg) => handlers.message.forEach(h => h(msg)),
    simulateError: (err) => handlers.error.forEach(h => h(err)),
    simulateClose: (code) => handlers.close.forEach(h => h(code)),
  };
}

describe('ACP Transport', () => {
  describe('createTransport', () => {
    it('should create StdioTransport for stdio config', () => {
      const transport = createTransport({
        type: 'stdio',
        command: 'echo',
        args: ['hello'],
      });

      expect(transport).toBeDefined();
      expect(transport.connected).toBe(false);
    });

    it('should throw for SSE config (not yet implemented)', () => {
      expect(() => createTransport({
        type: 'sse',
        url: 'http://localhost:8080/acp',
      })).toThrow('SSE transport is not yet implemented');
    });

    it('should throw for unknown transport type', () => {
      expect(() => createTransport({
        type: 'websocket' as 'stdio',
        command: 'test',
      })).toThrow("Unknown transport type: 'websocket'");
    });
  });

  describe('MockTransport (interface contract)', () => {
    it('should support connect/disconnect lifecycle', async () => {
      const { transport } = createMockTransport();

      expect(transport.connected).toBe(false);
      await transport.connect();
      expect(transport.connected).toBe(true);
      transport.disconnect();
      expect(transport.connected).toBe(false);
    });

    it('should support send', async () => {
      const { transport } = createMockTransport();
      await transport.connect();

      const message: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'acp/task/send',
        params: { taskId: 'test' },
      };

      transport.send(message);
      expect(transport.send).toHaveBeenCalledWith(message);
    });

    it('should deliver messages to registered handlers', async () => {
      const { transport, simulateMessage } = createMockTransport();
      const receivedMessages: JsonRpcMessage[] = [];
      await transport.connect();

      transport.onMessage((msg: JsonRpcMessage) => receivedMessages.push(msg));

      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'acp/notification/message',
        params: { taskId: '1', message: { role: 'assistant', content: 'Hi' } },
      };

      simulateMessage(notification);
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(notification);
    });

    it('should deliver errors to registered handlers', async () => {
      const { transport, simulateError } = createMockTransport();
      const receivedErrors: Error[] = [];
      await transport.connect();

      transport.onError((err: Error) => receivedErrors.push(err));

      const error = new Error('Connection lost');
      simulateError(error);
      expect(receivedErrors).toHaveLength(1);
      expect(receivedErrors[0].message).toBe('Connection lost');
    });

    it('should deliver close events to registered handlers', async () => {
      const { transport, simulateClose } = createMockTransport();
      const closeCodes: (number | null)[] = [];
      await transport.connect();

      transport.onClose((code: number | null) => closeCodes.push(code));

      simulateClose(0);
      expect(closeCodes).toEqual([0]);
    });
  });
});
