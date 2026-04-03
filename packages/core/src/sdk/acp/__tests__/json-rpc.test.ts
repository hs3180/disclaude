/**
 * Unit tests for ACP JSON-RPC 2.0 message layer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isRequest,
  isNotification,
  isSuccessResponse,
  isErrorResponse,
  isResponse,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  serializeMessage,
  parseMessages,
  isValidJsonRpcMessage,
  JsonRpcError,
  resetIdCounter,
} from '../json-rpc.js';

describe('ACP JSON-RPC', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  describe('Message type guards', () => {
    it('should identify JSON-RPC requests', () => {
      expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(true);
      expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'test', params: {} })).toBe(true);
    });

    it('should reject non-requests', () => {
      expect(isRequest({ jsonrpc: '2.0', method: 'test' })).toBe(false); // no id = notification
      expect(isRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false); // response
      expect(isRequest({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } })).toBe(false); // error response
      expect(isRequest({ jsonrpc: '2.0', id: '1' as unknown as number, method: 'test' })).toBe(false); // string id
    });

    it('should identify JSON-RPC notifications', () => {
      expect(isNotification({ jsonrpc: '2.0', method: 'test' })).toBe(true);
      expect(isNotification({ jsonrpc: '2.0', method: 'test', params: [] })).toBe(true);
    });

    it('should reject non-notifications', () => {
      expect(isNotification({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(false);
    });

    it('should identify success responses', () => {
      expect(isSuccessResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
      expect(isSuccessResponse({ jsonrpc: '2.0', id: 1, result: null })).toBe(true);
    });

    it('should reject non-success responses', () => {
      expect(isSuccessResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } })).toBe(false);
      expect(isSuccessResponse({ jsonrpc: '2.0', method: 'test' })).toBe(false);
    });

    it('should identify error responses', () => {
      expect(isErrorResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Not found' } })).toBe(true);
      expect(isErrorResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })).toBe(true);
    });

    it('should identify any response', () => {
      expect(isResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
      expect(isResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Not found' } })).toBe(true);
      expect(isResponse({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(false);
    });
  });

  describe('Message creation', () => {
    it('should create requests with auto-incrementing IDs', () => {
      const req1 = createRequest('initialize');
      const req2 = createRequest('session/new');

      expect(req1.id).toBe(0);
      expect(req1.method).toBe('initialize');
      expect(req1.jsonrpc).toBe('2.0');
      expect(req2.id).toBe(1);
    });

    it('should create requests with params', () => {
      const params = { protocolVersion: 1, clientInfo: { name: 'test', version: '1.0' } };
      const req = createRequest('initialize', params);

      expect(req.params).toEqual(params);
    });

    it('should create notifications without id', () => {
      const notif = createNotification('session/cancel', { sessionId: 'test' });

      expect('id' in notif).toBe(false);
      expect(notif.method).toBe('session/cancel');
      expect(notif.params).toEqual({ sessionId: 'test' });
    });

    it('should create success responses', () => {
      const resp = createSuccessResponse(1, { sessionId: 'abc' });

      expect(resp.id).toBe(1);
      expect(resp.result).toEqual({ sessionId: 'abc' });
    });

    it('should create error responses', () => {
      const resp = createErrorResponse(1, -32601, 'Method not found', { method: 'foo' });

      expect(resp.id).toBe(1);
      expect(resp.error.code).toBe(-32601);
      expect(resp.error.message).toBe('Method not found');
      expect(resp.error.data).toEqual({ method: 'foo' });
    });

    it('should create error responses with null id', () => {
      const resp = createErrorResponse(null, -32700, 'Parse error');

      expect(resp.id).toBeNull();
    });
  });

  describe('Serialization', () => {
    it('should serialize messages to ndJSON format', () => {
      const req = createRequest('initialize');
      const serialized = serializeMessage(req);

      expect(serialized).toBe(JSON.stringify(req) + '\n');
    });

    it('should parse ndJSON data into messages', () => {
      const req = createRequest('initialize');
      const notif = createNotification('session/cancel');
      const data = serializeMessage(req) + serializeMessage(notif);

      const messages = parseMessages(data);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(req);
      expect(messages[1]).toEqual(notif);
    });

    it('should handle empty lines gracefully', () => {
      const data = '\n\n{"jsonrpc":"2.0","id":1,"method":"test"}\n\n';
      const messages = parseMessages(data);

      expect(messages).toHaveLength(1);
    });

    it('should skip invalid JSON lines', () => {
      const data = 'not json\n{"jsonrpc":"2.0","id":1,"method":"test"}\n{broken\n';
      const messages = parseMessages(data);

      expect(messages).toHaveLength(1);
    });
  });

  describe('Validation', () => {
    it('should validate correct JSON-RPC messages', () => {
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(true);
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0', method: 'test' })).toBe(true);
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } })).toBe(true);
    });

    it('should reject invalid messages', () => {
      expect(isValidJsonRpcMessage(null)).toBe(false);
      expect(isValidJsonRpcMessage(undefined)).toBe(false);
      expect(isValidJsonRpcMessage('string')).toBe(false);
      expect(isValidJsonRpcMessage({ jsonrpc: '1.0', method: 'test' })).toBe(false);
      expect(isValidJsonRpcMessage({ method: 'test' })).toBe(false);
      expect(isValidJsonRpcMessage({ jsonrpc: '2.0' })).toBe(false);
    });
  });

  describe('JsonRpcError', () => {
    it('should create error with code and message', () => {
      const err = new JsonRpcError(-32601, 'Method not found');

      expect(err.name).toBe('JsonRpcError');
      expect(err.code).toBe(-32601);
      expect(err.message).toBe('Method not found');
      expect(err.data).toBeUndefined();
    });

    it('should create error with data', () => {
      const err = new JsonRpcError(-32602, 'Invalid params', { field: 'name' });

      expect(err.data).toEqual({ field: 'name' });
    });

    it('should create standard errors via factory methods', () => {
      expect(JsonRpcError.parseError().code).toBe(-32700);
      expect(JsonRpcError.invalidRequest().code).toBe(-32600);
      expect(JsonRpcError.methodNotFound('foo').code).toBe(-32601);
      expect(JsonRpcError.methodNotFound('foo').message).toContain('foo');
      expect(JsonRpcError.invalidParams().code).toBe(-32602);
      expect(JsonRpcError.internalError().code).toBe(-32603);
    });

    it('should convert to JSON-RPC error response', () => {
      const err = new JsonRpcError(-32601, 'Not found', { method: 'test' });
      const response = err.toResponse(5);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(5);
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toBe('Not found');
      expect(response.error.data).toEqual({ method: 'test' });
    });
  });
});
