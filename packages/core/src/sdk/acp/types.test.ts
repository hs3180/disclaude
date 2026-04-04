/**
 * ACP 类型定义和工具函数测试
 *
 * 验证 JSON-RPC 2.0 消息创建、解析、类型判断等核心功能。
 *
 * Issue #1333: 支持OpenAI Agent - PR A (ACP 协议基础设施)
 */

import { describe, it, expect } from 'vitest';
import {
  AcpMethod,
  JsonRpcErrorCode,
  createJsonRpcRequest,
  createJsonRpcNotification,
  createJsonRpcSuccessResponse,
  createJsonRpcErrorResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
} from './types.js';

// ============================================================================
// createJsonRpcRequest
// ============================================================================

describe('createJsonRpcRequest', () => {
  it('should create a request with method and id', () => {
    const request = createJsonRpcRequest('tasks/send', { id: 'task-1' }, 1);

    expect(request).toEqual({
      jsonrpc: '2.0',
      method: 'tasks/send',
      params: { id: 'task-1' },
      id: 1,
    });
  });

  it('should create a request without params', () => {
    const request = createJsonRpcRequest('initialize', undefined, 1);

    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('initialize');
    expect(request.params).toBeUndefined();
    expect(request.id).toBe(1);
  });

  it('should create a request without id', () => {
    const request = createJsonRpcRequest('tasks/send', { id: 'task-1' });

    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('tasks/send');
    expect(request.params).toEqual({ id: 'task-1' });
    expect(request.id).toBeUndefined();
  });
});

// ============================================================================
// createJsonRpcNotification
// ============================================================================

describe('createJsonRpcNotification', () => {
  it('should create a notification with params', () => {
    const notification = createJsonRpcNotification('notifications/task', {
      id: 'task-1',
      status: 'working',
    });

    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/task',
      params: { id: 'task-1', status: 'working' },
    });
    expect(notification).not.toHaveProperty('id');
  });

  it('should create a notification without params', () => {
    const notification = createJsonRpcNotification('notifications/initialized');

    expect(notification.jsonrpc).toBe('2.0');
    expect(notification.method).toBe('notifications/initialized');
    expect(notification).not.toHaveProperty('id');
  });
});

// ============================================================================
// createJsonRpcSuccessResponse
// ============================================================================

describe('createJsonRpcSuccessResponse', () => {
  it('should create a success response', () => {
    const response = createJsonRpcSuccessResponse(
      { status: 'completed', id: 'task-1' },
      1,
    );

    expect(response).toEqual({
      jsonrpc: '2.0',
      result: { status: 'completed', id: 'task-1' },
      id: 1,
    });
  });
});

// ============================================================================
// createJsonRpcErrorResponse
// ============================================================================

describe('createJsonRpcErrorResponse', () => {
  it('should create an error response', () => {
    const response = createJsonRpcErrorResponse(
      JsonRpcErrorCode.METHOD_NOT_FOUND,
      'Method not found',
      1,
    );

    expect(response).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: 'Method not found',
      },
      id: 1,
    });
  });

  it('should create an error response with data', () => {
    const response = createJsonRpcErrorResponse(
      JsonRpcErrorCode.INVALID_PARAMS,
      'Invalid params',
      2,
      { detail: 'missing id field' },
    );

    expect(response.error.data).toEqual({ detail: 'missing id field' });
  });
});

// ============================================================================
// isJsonRpcRequest
// ============================================================================

describe('isJsonRpcRequest', () => {
  it('should identify valid request', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test', id: 1 })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test' })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test', params: {} })).toBe(true);
  });

  it('should reject non-request messages', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', result: {}, id: 1 })).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', error: {}, id: 1 })).toBe(false);
    expect(isJsonRpcRequest(null)).toBe(false);
    expect(isJsonRpcRequest('string')).toBe(false);
    expect(isJsonRpcRequest(42)).toBe(false);
    expect(isJsonRpcRequest({})).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: '1.0', method: 'test' })).toBe(false);
  });
});

// ============================================================================
// isJsonRpcNotification
// ============================================================================

describe('isJsonRpcNotification', () => {
  it('should identify notification (request without id)', () => {
    expect(
      isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/task', params: {} }),
    ).toBe(true);
    expect(
      isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBe(true);
  });

  it('should reject request with id', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'test', id: 1 })).toBe(false);
  });

  it('should reject non-request messages', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', result: {}, id: 1 })).toBe(false);
  });
});

// ============================================================================
// isJsonRpcResponse
// ============================================================================

describe('isJsonRpcResponse', () => {
  it('should identify success response', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', result: {}, id: 1 })).toBe(true);
  });

  it('should identify error response', () => {
    expect(
      isJsonRpcResponse({ jsonrpc: '2.0', error: { code: -1, message: 'err' }, id: 1 }),
    ).toBe(true);
  });

  it('should reject non-response messages', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', method: 'test', id: 1 })).toBe(false);
    expect(isJsonRpcResponse(null)).toBe(false);
  });
});

// ============================================================================
// parseJsonRpcMessage
// ============================================================================

describe('parseJsonRpcMessage', () => {
  it('should parse a valid request', () => {
    const message = parseJsonRpcMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'tasks/send', id: 1, params: { id: 't1' } }),
    );

    expect(isJsonRpcRequest(message)).toBe(true);
    if (isJsonRpcRequest(message)) {
      expect(message.method).toBe('tasks/send');
      expect(message.id).toBe(1);
      expect(message.params).toEqual({ id: 't1' });
    }
  });

  it('should parse a valid notification', () => {
    const message = parseJsonRpcMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/task', params: { status: 'working' } }),
    );

    expect(isJsonRpcNotification(message)).toBe(true);
    expect(isJsonRpcRequest(message)).toBe(true);
  });

  it('should parse a valid success response', () => {
    const message = parseJsonRpcMessage(
      JSON.stringify({ jsonrpc: '2.0', result: { status: 'done' }, id: 1 }),
    );

    expect(isJsonRpcResponse(message)).toBe(true);
    if (isJsonRpcResponse(message) && 'result' in message) {
      expect(message.result).toEqual({ status: 'done' });
    }
  });

  it('should parse a valid error response', () => {
    const message = parseJsonRpcMessage(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: 1 }),
    );

    expect(isJsonRpcResponse(message)).toBe(true);
    if (isJsonRpcResponse(message) && 'error' in message) {
      expect(message.error.code).toBe(-32601);
    }
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseJsonRpcMessage('not json')).toThrow('not valid JSON');
  });

  it('should throw on non-object', () => {
    expect(() => parseJsonRpcMessage('"string"')).toThrow('not an object');
    expect(() => parseJsonRpcMessage('42')).toThrow('not an object');
    expect(() => parseJsonRpcMessage('null')).toThrow('not an object');
  });

  it('should throw on missing jsonrpc version', () => {
    expect(() => parseJsonRpcMessage('{"method": "test"}')).toThrow('jsonrpc version');
  });

  it('should throw on wrong jsonrpc version', () => {
    expect(() => parseJsonRpcMessage('{"jsonrpc": "1.0", "method": "test"}')).toThrow('jsonrpc version');
  });

  it('should throw on message with no method, result, or error', () => {
    expect(() => parseJsonRpcMessage('{"jsonrpc": "2.0"}')).toThrow('missing method');
  });
});

// ============================================================================
// serializeJsonRpcMessage
// ============================================================================

describe('serializeJsonRpcMessage', () => {
  it('should serialize a request', () => {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'tasks/send',
      id: 1,
      params: { id: 't1' },
    };

    const serialized = serializeJsonRpcMessage(request);
    const parsed = JSON.parse(serialized);

    expect(parsed).toEqual(request);
  });

  it('should serialize a notification', () => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };

    const serialized = serializeJsonRpcMessage(notification);
    const parsed = JSON.parse(serialized);

    expect(parsed).toEqual(notification);
  });

  it('should serialize a success response', () => {
    const response: JsonRpcSuccessResponse = {
      jsonrpc: '2.0',
      result: { status: 'done' },
      id: 1,
    };

    const serialized = serializeJsonRpcMessage(response);
    const parsed = JSON.parse(serialized);

    expect(parsed).toEqual(response);
  });

  it('should serialize an error response', () => {
    const response: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Not found' },
      id: 1,
    };

    const serialized = serializeJsonRpcMessage(response);
    const parsed = JSON.parse(serialized);

    expect(parsed).toEqual(response);
  });
});

// ============================================================================
// AcpMethod constants
// ============================================================================

describe('AcpMethod', () => {
  it('should have all required method names', () => {
    expect(AcpMethod.INITIALIZE).toBe('initialize');
    expect(AcpMethod.INITIALIZED).toBe('notifications/initialized');
    expect(AcpMethod.TASK_SEND).toBe('tasks/send');
    expect(AcpMethod.TASK_CANCEL).toBe('tasks/cancel');
    expect(AcpMethod.TASK_NOTIFICATION).toBe('notifications/task');
    expect(AcpMethod.MESSAGE_NOTIFICATION).toBe('notifications/message');
  });
});

// ============================================================================
// JsonRpcErrorCode constants
// ============================================================================

describe('JsonRpcErrorCode', () => {
  it('should have standard JSON-RPC error codes', () => {
    expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
    expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
    expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
    expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
    expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
  });

  it('should have ACP-specific error codes', () => {
    expect(JsonRpcErrorCode.TASK_NOT_FOUND).toBe(-32001);
    expect(JsonRpcErrorCode.TASK_ALREADY_COMPLETED).toBe(-32002);
    expect(JsonRpcErrorCode.CAPABILITY_NOT_SUPPORTED).toBe(-32003);
  });
});

// ============================================================================
// Round-trip: create → serialize → parse → verify
// ============================================================================

describe('round-trip serialization', () => {
  it('should preserve request through round-trip', () => {
    const original = createJsonRpcRequest('tasks/send', { id: 'task-1', message: 'hello' }, 42);
    const serialized = serializeJsonRpcMessage(original);
    const parsed = parseJsonRpcMessage(serialized);

    expect(parsed).toEqual(original);
  });

  it('should preserve notification through round-trip', () => {
    const original = createJsonRpcNotification('notifications/task', { status: 'completed' });
    const serialized = serializeJsonRpcMessage(original);
    const parsed = parseJsonRpcMessage(serialized);

    expect(parsed).toEqual(original);
  });

  it('should preserve success response through round-trip', () => {
    const original = createJsonRpcSuccessResponse({ capabilities: { streaming: true } }, 5);
    const serialized = serializeJsonRpcMessage(original);
    const parsed = parseJsonRpcMessage(serialized);

    expect(parsed).toEqual(original);
  });

  it('should preserve error response through round-trip', () => {
    const original = createJsonRpcErrorResponse(
      JsonRpcErrorCode.TASK_NOT_FOUND,
      'Task not found',
      10,
      { taskId: 't1' },
    );
    const serialized = serializeJsonRpcMessage(original);
    const parsed = parseJsonRpcMessage(serialized);

    expect(parsed).toEqual(original);
  });
});
