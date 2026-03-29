/**
 * ACP 协议类型定义单元测试
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect } from 'vitest';
import {
  JsonRpcErrorCode,
  AcpMethod,
  ACP_PROTOCOL_VERSION,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isAcpTaskNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
} from './types.js';

describe('ACP Protocol Types', () => {
  describe('Constants', () => {
    it('should have correct JSON-RPC error codes', () => {
      expect(JsonRpcErrorCode.ParseError).toBe(-32700);
      expect(JsonRpcErrorCode.InvalidRequest).toBe(-32600);
      expect(JsonRpcErrorCode.MethodNotFound).toBe(-32601);
      expect(JsonRpcErrorCode.InvalidParams).toBe(-32602);
      expect(JsonRpcErrorCode.InternalError).toBe(-32603);
      expect(JsonRpcErrorCode.TaskNotFound).toBe(-32001);
      expect(JsonRpcErrorCode.TaskCancelled).toBe(-32002);
      expect(JsonRpcErrorCode.ServerUnavailable).toBe(-32003);
    });

    it('should have correct ACP method names', () => {
      expect(AcpMethod.Initialize).toBe('initialize');
      expect(AcpMethod.TaskSend).toBe('tasks/send');
      expect(AcpMethod.TaskCancel).toBe('tasks/cancel');
      expect(AcpMethod.TaskNotification).toBe('notifications/task');
    });

    it('should have a valid protocol version', () => {
      expect(ACP_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('isJsonRpcRequest', () => {
    it('should identify valid JSON-RPC requests', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      };
      expect(isJsonRpcRequest(request)).toBe(true);
    });

    it('should reject JSON-RPC notifications (no id)', () => {
      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'notifications/task',
        params: {},
      };
      expect(isJsonRpcRequest(notification)).toBe(false);
    });

    it('should reject non-objects', () => {
      expect(isJsonRpcRequest(null)).toBe(false);
      expect(isJsonRpcRequest('string')).toBe(false);
      expect(isJsonRpcRequest(42)).toBe(false);
      expect(isJsonRpcRequest(undefined)).toBe(false);
    });

    it('should reject objects without jsonrpc field', () => {
      expect(isJsonRpcRequest({ id: 1, method: 'test' })).toBe(false);
    });

    it('should reject objects with wrong jsonrpc version', () => {
      expect(isJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'test' })).toBe(false);
    });
  });

  describe('isJsonRpcNotification', () => {
    it('should identify valid JSON-RPC notifications', () => {
      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'notifications/task',
        params: { taskId: '123', type: 'text', data: { text: 'hello' } },
      };
      expect(isJsonRpcNotification(notification)).toBe(true);
    });

    it('should reject JSON-RPC requests (has id)', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      };
      expect(isJsonRpcNotification(request)).toBe(false);
    });
  });

  describe('isJsonRpcResponse', () => {
    it('should identify successful JSON-RPC responses', () => {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: { taskId: 'abc-123' },
      };
      expect(isJsonRpcResponse(response)).toBe(true);
    });

    it('should identify error JSON-RPC responses', () => {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      };
      expect(isJsonRpcResponse(response)).toBe(true);
    });

    it('should reject responses without id', () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', result: {} })).toBe(false);
    });

    it('should reject responses without result or error', () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1 })).toBe(false);
    });
  });

  describe('isAcpTaskNotification', () => {
    it('should identify valid ACP task notifications', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'notifications/task',
        params: {
          taskId: 'task-123',
          type: 'text',
          data: { text: 'Hello from agent' },
        },
      };
      expect(isAcpTaskNotification(notification)).toBe(true);
    });

    it('should reject non-notification messages', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'notifications/task',
        params: { taskId: 'task-123', type: 'text', data: {} },
      };
      expect(isAcpTaskNotification(request)).toBe(false);
    });

    it('should reject notifications with wrong method', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'some/other',
        params: { taskId: 'task-123', type: 'text', data: {} },
      };
      expect(isAcpTaskNotification(notification)).toBe(false);
    });

    it('should reject notifications missing taskId or type', () => {
      const noTaskId = {
        jsonrpc: '2.0',
        method: 'notifications/task',
        params: { type: 'text', data: {} },
      };
      expect(isAcpTaskNotification(noTaskId)).toBe(false);

      const noType = {
        jsonrpc: '2.0',
        method: 'notifications/task',
        params: { taskId: 'task-123', data: {} },
      };
      expect(isAcpTaskNotification(noType)).toBe(false);
    });

    it('should identify different notification types', () => {
      const types = ['text', 'tool_use', 'tool_progress', 'tool_result', 'complete', 'error'];
      for (const type of types) {
        const notification = {
          jsonrpc: '2.0',
          method: 'notifications/task',
          params: { taskId: 'task-123', type, data: {} },
        };
        expect(isAcpTaskNotification(notification)).toBe(true);
      }
    });
  });
});
