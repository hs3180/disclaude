/**
 * Unit tests for JSON-RPC 2.0 message types and utilities
 */

import { describe, it, expect } from 'vitest';
import {
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isSuccessResponse,
  isErrorResponse,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createError,
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
  isValidJsonRpcMessage,
  JsonRpcParseError,
  JsonRpcProtocolError,
  JsonRpcErrorCode,
} from './json-rpc.js';

describe('JSON-RPC 2.0', () => {
  // ==========================================================================
  // Type Guards
  // ==========================================================================

  describe('isJsonRpcRequest', () => {
    it('should identify valid request with id', () => {
      const msg = { jsonrpc: '2.0', method: 'test', id: 1 };
      expect(isJsonRpcRequest(msg)).toBe(true);
    });

    it('should identify request with string id', () => {
      const msg = { jsonrpc: '2.0', method: 'test', id: 'abc' };
      expect(isJsonRpcRequest(msg)).toBe(true);
    });

    it('should reject notification (no id)', () => {
      const msg = { jsonrpc: '2.0', method: 'test' };
      expect(isJsonRpcRequest(msg)).toBe(false);
    });

    it('should reject response (has result)', () => {
      const msg = { jsonrpc: '2.0', id: 1, result: {} };
      expect(isJsonRpcRequest(msg)).toBe(false);
    });

    it('should reject response (has error)', () => {
      const msg = { jsonrpc: '2.0', id: 1, error: {} };
      expect(isJsonRpcRequest(msg)).toBe(false);
    });

    it('should reject invalid jsonrpc version', () => {
      const msg = { jsonrpc: '1.0', method: 'test', id: 1 };
      expect(isJsonRpcRequest(msg)).toBe(false);
    });
  });

  describe('isJsonRpcNotification', () => {
    it('should identify notification (method, no id)', () => {
      const msg = { jsonrpc: '2.0', method: 'test' };
      expect(isJsonRpcNotification(msg)).toBe(true);
    });

    it('should reject request with id', () => {
      const msg = { jsonrpc: '2.0', method: 'test', id: 1 };
      expect(isJsonRpcNotification(msg)).toBe(false);
    });

    it('should identify notification with params', () => {
      const msg = { jsonrpc: '2.0', method: 'test', params: { key: 'value' } };
      expect(isJsonRpcNotification(msg)).toBe(true);
    });
  });

  describe('isJsonRpcResponse', () => {
    it('should identify success response', () => {
      const msg = { jsonrpc: '2.0', id: 1, result: { data: 'ok' } };
      expect(isJsonRpcResponse(msg)).toBe(true);
    });

    it('should identify error response', () => {
      const msg = { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' } };
      expect(isJsonRpcResponse(msg)).toBe(true);
    });

    it('should reject request', () => {
      const msg = { jsonrpc: '2.0', method: 'test', id: 1 };
      expect(isJsonRpcResponse(msg)).toBe(false);
    });
  });

  describe('isSuccessResponse', () => {
    it('should identify success response', () => {
      const msg = { jsonrpc: '2.0', id: 1, result: 'ok' };
      expect(isSuccessResponse(msg)).toBe(true);
    });

    it('should reject error response', () => {
      const msg = { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' } };
      expect(isSuccessResponse(msg)).toBe(false);
    });
  });

  describe('isErrorResponse', () => {
    it('should identify error response', () => {
      const msg = { jsonrpc: '2.0' as const, id: 1, error: { code: -32600, message: 'bad' } };
      expect(isErrorResponse(msg)).toBe(true);
    });

    it('should reject success response', () => {
      const msg = { jsonrpc: '2.0' as const, id: 1, result: 'ok' };
      expect(isErrorResponse(msg)).toBe(false);
    });
  });

  // ==========================================================================
  // Message Creation
  // ==========================================================================

  describe('createRequest', () => {
    it('should create request with method and id', () => {
      const req = createRequest('tasks/send', undefined, 1);
      expect(req).toEqual({ jsonrpc: '2.0', method: 'tasks/send', id: 1 });
    });

    it('should create request with params', () => {
      const req = createRequest('tasks/send', { taskId: 'abc' }, 1);
      expect(req.params).toEqual({ taskId: 'abc' });
    });

    it('should create request with array params', () => {
      const req = createRequest('test', ['a', 'b'], 2);
      expect(req.params).toEqual(['a', 'b']);
    });

    it('should create request without id', () => {
      const req = createRequest('test');
      expect(req.id).toBeUndefined();
    });
  });

  describe('createNotification', () => {
    it('should create notification without id', () => {
      const notif = createNotification('notifications/task/message', { taskId: 'abc' });
      expect(notif).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/task/message',
        params: { taskId: 'abc' },
      });
      expect('id' in notif).toBe(false);
    });

    it('should create notification without params', () => {
      const notif = createNotification('ping');
      expect(notif).toEqual({ jsonrpc: '2.0', method: 'ping' });
    });
  });

  describe('createSuccessResponse', () => {
    it('should create success response', () => {
      const res = createSuccessResponse(1, { status: 'ok' });
      expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: { status: 'ok' } });
    });

    it('should create success response with null id', () => {
      const res = createSuccessResponse(null, 'ok');
      expect(res.id).toBeNull();
    });
  });

  describe('createErrorResponse', () => {
    it('should create error response', () => {
      const res = createErrorResponse(1, { code: -32600, message: 'Invalid Request' });
      expect(res).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid Request' },
      });
    });
  });

  describe('createError', () => {
    it('should create error with code and message', () => {
      const err = createError(-32600, 'Invalid Request');
      expect(err).toEqual({ code: -32600, message: 'Invalid Request' });
    });

    it('should create error with data', () => {
      const err = createError(-32602, 'Invalid params', { field: 'taskId' });
      expect(err.data).toEqual({ field: 'taskId' });
    });
  });

  // ==========================================================================
  // Serialization / Deserialization
  // ==========================================================================

  describe('parseJsonRpcMessage', () => {
    it('should parse single message', () => {
      const data = '{"jsonrpc":"2.0","method":"test","id":1}';
      const messages = parseJsonRpcMessage(data);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ jsonrpc: '2.0', method: 'test', id: 1 });
    });

    it('should parse batch of messages', () => {
      const data = '[{"jsonrpc":"2.0","method":"test","id":1},{"jsonrpc":"2.0","method":"test2","id":2}]';
      const messages = parseJsonRpcMessage(data);
      expect(messages).toHaveLength(2);
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseJsonRpcMessage('not json')).toThrow(JsonRpcParseError);
    });

    it('should throw on empty batch', () => {
      expect(() => parseJsonRpcMessage('[]')).toThrow(JsonRpcParseError);
    });

    it('should parse non-object JSON as single message', () => {
      const data = '42';
      const messages = parseJsonRpcMessage(data);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe(42);
    });
  });

  describe('serializeJsonRpcMessage', () => {
    it('should serialize request', () => {
      const req = createRequest('test', { key: 'value' }, 1);
      const serialized = serializeJsonRpcMessage(req);
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual({ jsonrpc: '2.0', method: 'test', params: { key: 'value' }, id: 1 });
    });
  });

  describe('isValidJsonRpcMessage', () => {
    it('should validate request', () => {
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0', method: 'test', id: 1 })).toBe(true);
    });

    it('should validate notification', () => {
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0', method: 'test' })).toBe(true);
    });

    it('should validate success response', () => {
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    });

    it('should validate error response', () => {
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0', id: 1, error: { code: 0, message: '' } })).toBe(true);
    });

    it('should reject null', () => {
      expect(isValidJsonRpcMessage(null)).toBe(false);
    });

    it('should reject non-object', () => {
      expect(isValidJsonRpcMessage('string')).toBe(false);
    });

    it('should reject wrong version', () => {
      expect(isValidJsonRpcMessage({ jsonrpc: '1.0', method: 'test' })).toBe(false);
    });

    it('should reject object without method or result/error', () => {
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0' })).toBe(false);
    });
  });

  // ==========================================================================
  // Error Types
  // ==========================================================================

  describe('JsonRpcParseError', () => {
    it('should have correct name', () => {
      const err = new JsonRpcParseError('test');
      expect(err.name).toBe('JsonRpcParseError');
      expect(err.message).toBe('test');
    });
  });

  describe('JsonRpcProtocolError', () => {
    it('should create from JsonRpcError', () => {
      const err = new JsonRpcProtocolError({ code: -32601, message: 'Method not found' });
      expect(err.name).toBe('JsonRpcProtocolError');
      expect(err.code).toBe(-32601);
      expect(err.message).toBe('Method not found');
    });

    it('should preserve data', () => {
      const err = new JsonRpcProtocolError({
        code: -32602,
        message: 'Invalid params',
        data: { field: 'taskId' },
      });
      expect(err.data).toEqual({ field: 'taskId' });
    });
  });

  // ==========================================================================
  // Error Code Constants
  // ==========================================================================

  describe('JsonRpcErrorCode', () => {
    it('should have standard error codes', () => {
      expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
      expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
      expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
      expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
      expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
    });
  });

  // ==========================================================================
  // Round-trip Tests
  // ==========================================================================

  describe('round-trip serialization', () => {
    it('should preserve request through serialize/parse cycle', () => {
      const original = createRequest('tasks/send', { taskId: 'abc-123', messages: [] }, 'req-1');
      const serialized = serializeJsonRpcMessage(original);
      const [parsed] = parseJsonRpcMessage(serialized);
      expect(parsed).toEqual(original);
    });

    it('should preserve notification through serialize/parse cycle', () => {
      const original = createNotification('notifications/task/status', { taskId: 'abc', status: 'completed' });
      const serialized = serializeJsonRpcMessage(original);
      const [parsed] = parseJsonRpcMessage(serialized);
      expect(parsed).toEqual(original);
    });

    it('should preserve success response through serialize/parse cycle', () => {
      const original = createSuccessResponse('req-1', { taskId: 'abc', status: 'completed' });
      const serialized = serializeJsonRpcMessage(original);
      const [parsed] = parseJsonRpcMessage(serialized);
      expect(parsed).toEqual(original);
    });
  });
});
