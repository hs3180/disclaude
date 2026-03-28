/**
 * Unit tests for ACP JSON-RPC 2.0 message format
 */

import { describe, it, expect } from 'vitest';
import {
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  createStandardError,
  validateMessage,
  isNotification,
  isRequest,
  isResponse,
  isErrorResponse,
  isSuccessResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcMessage,
  type JsonRpcBatch,
  type JsonRpcRequest,
  type ParseResult,
} from './json-rpc.js';
import { AcpErrorCode } from './types.js';

describe('JSON-RPC 2.0', () => {
  describe('createRequest', () => {
    it('should create a valid request with auto-generated id', () => {
      const req = createRequest('acp.task/send', { message: 'hello' });
      expect(req.jsonrpc).toBe('2.0');
      expect(req.method).toBe('acp.task/send');
      expect(req.id).toBeDefined();
      expect(typeof req.id).toBe('string');
      expect(req.params).toEqual({ message: 'hello' });
    });

    it('should create a request with explicit id', () => {
      const req = createRequest('test', {}, 'custom-id');
      expect(req.id).toBe('custom-id');
    });

    it('should create a request without params', () => {
      const req = createRequest('ping');
      expect(req.params).toBeUndefined();
    });

    it('should generate unique ids', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const req = createRequest('test');
        ids.add(req.id);
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('createNotification', () => {
    it('should create a notification without id', () => {
      const notif = createNotification('acp.notification/message', { taskId: '123' });
      expect(notif.jsonrpc).toBe('2.0');
      expect(notif.method).toBe('acp.notification/message');
      expect('id' in notif).toBe(false);
      expect(notif.params).toEqual({ taskId: '123' });
    });
  });

  describe('createSuccessResponse', () => {
    it('should create a success response', () => {
      const resp = createSuccessResponse('req-1', { status: 'ok' });
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.id).toBe('req-1');
      expect(resp.result).toEqual({ status: 'ok' });
    });
  });

  describe('createErrorResponse', () => {
    it('should create an error response', () => {
      const resp = createErrorResponse('req-1', -32602, 'Invalid params', { field: 'name' });
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.id).toBe('req-1');
      expect(resp.error.code).toBe(-32602);
      expect(resp.error.message).toBe('Invalid params');
      expect(resp.error.data).toEqual({ field: 'name' });
    });

    it('should create an error response with null id', () => {
      const resp = createErrorResponse(null, -32700, 'Parse error');
      expect(resp.id).toBeNull();
    });
  });

  describe('createStandardError', () => {
    it('should create error from AcpErrorCode enum', () => {
      const resp = createStandardError(AcpErrorCode.InvalidParams);
      expect(resp.error.code).toBe(-32602);
      expect(resp.error.message).toBe('InvalidParams');
      expect(resp.id).toBeNull();
    });

    it('should accept custom id', () => {
      const resp = createStandardError(AcpErrorCode.TaskNotFound, 'task-123');
      expect(resp.id).toBe('task-123');
      expect(resp.error.code).toBe(-32001);
    });

    it('should accept additional data', () => {
      const resp = createStandardError(AcpErrorCode.Timeout, null, { timeoutMs: 30000 });
      expect(resp.error.data).toEqual({ timeoutMs: 30000 });
    });

    it('should create all standard error codes', () => {
      const codes = [
        AcpErrorCode.InternalError,
        AcpErrorCode.InvalidParams,
        AcpErrorCode.MethodNotFound,
        AcpErrorCode.InvalidRequest,
        AcpErrorCode.ParseError,
        AcpErrorCode.TaskNotFound,
        AcpErrorCode.SessionNotFound,
        AcpErrorCode.CapabilityNotSupported,
        AcpErrorCode.AuthenticationFailed,
        AcpErrorCode.Timeout,
      ];
      for (const code of codes) {
        const resp = createStandardError(code);
        expect(resp.error.code).toBe(code);
        expect(resp.error.message).toBe(AcpErrorCode[code]);
      }
    });
  });

  describe('validateMessage', () => {
    it('should validate a valid request', () => {
      const result = validateMessage({ jsonrpc: '2.0', id: '1', method: 'test' });
      expect(result.valid).toBe(true);
    });

    it('should validate a valid notification', () => {
      const result = validateMessage({ jsonrpc: '2.0', method: 'test' });
      expect(result.valid).toBe(true);
    });

    it('should validate a valid success response', () => {
      const result = validateMessage({ jsonrpc: '2.0', id: '1', result: {} });
      expect(result.valid).toBe(true);
    });

    it('should validate a valid error response', () => {
      const result = validateMessage({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Bad' } });
      expect(result.valid).toBe(true);
    });

    it('should reject non-object', () => {
      const result = validateMessage('string');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('object');
    });

    it('should reject null', () => {
      const result = validateMessage(null);
      expect(result.valid).toBe(false);
    });

    it('should reject wrong jsonrpc version', () => {
      const result = validateMessage({ jsonrpc: '1.0', id: '1', method: 'test' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('2.0');
    });

    it('should reject request with result field', () => {
      const result = validateMessage({ jsonrpc: '2.0', id: '1', method: 'test', result: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('result');
    });

    it('should reject response with both result and error', () => {
      const result = validateMessage({
        jsonrpc: '2.0',
        id: '1',
        result: {},
        error: { code: 1, message: 'err' },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('both');
    });

    it('should reject error response with non-numeric code', () => {
      const result = validateMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: 'bad', message: 'err' },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('numeric');
    });

    it('should reject error response with non-string message', () => {
      const result = validateMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: 1, message: 123 },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('string');
    });

    it('should reject message without method or response fields', () => {
      const result = validateMessage({ jsonrpc: '2.0' });
      expect(result.valid).toBe(false);
    });

    it('should reject request with invalid id type', () => {
      const result = validateMessage({ jsonrpc: '2.0', id: true, method: 'test' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('id');
    });

    it('should accept numeric id', () => {
      const result = validateMessage({ jsonrpc: '2.0', id: 42, method: 'test' });
      expect(result.valid).toBe(true);
    });

    it('should accept null id in request (treated as notification)', () => {
      const result = validateMessage({ jsonrpc: '2.0', id: null, method: 'test' });
      expect(result.valid).toBe(true);
    });
  });

  describe('type guards', () => {
    it('isNotification should identify notifications', () => {
      const notif = createNotification('test');
      expect(isNotification(notif)).toBe(true);
      expect(isRequest(notif)).toBe(false);
      expect(isResponse(notif)).toBe(false);
    });

    it('isRequest should identify requests', () => {
      const req = createRequest('test');
      expect(isRequest(req)).toBe(true);
      expect(isNotification(req)).toBe(false);
      expect(isResponse(req)).toBe(false);
    });

    it('isSuccessResponse should identify success responses', () => {
      const resp = createSuccessResponse('1', {});
      expect(isSuccessResponse(resp)).toBe(true);
      expect(isResponse(resp)).toBe(true);
      expect(isErrorResponse(resp)).toBe(false);
    });

    it('isErrorResponse should identify error responses', () => {
      const resp = createErrorResponse('1', -1, 'err');
      expect(isErrorResponse(resp)).toBe(true);
      expect(isResponse(resp)).toBe(true);
      expect(isSuccessResponse(resp)).toBe(false);
    });
  });

  describe('parseMessage', () => {
    /** Helper: assert parse result is a single message and extract it */
    function extractMessage(result: ParseResult): JsonRpcMessage {
      expect(result.valid).toBe(true);
      const r = result as { valid: true; message: JsonRpcMessage };
      return r.message;
    }

    /** Helper: assert parse result is a batch and extract it */
    function extractBatch(result: ParseResult): JsonRpcBatch {
      expect(result.valid).toBe(true);
      const r = result as { valid: true; batch: JsonRpcBatch };
      return r.batch;
    }

    it('should parse a valid request string', () => {
      const json = JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'test' });
      const msg = extractMessage(parseMessage(json));
      expect(isRequest(msg)).toBe(true);
      if (isRequest(msg)) {
        expect(msg.method).toBe('test');
      }
    });

    it('should parse a valid notification string', () => {
      const json = JSON.stringify({ jsonrpc: '2.0', method: 'notify' });
      const msg = extractMessage(parseMessage(json));
      expect(isNotification(msg)).toBe(true);
    });

    it('should parse a valid success response string', () => {
      const json = JSON.stringify({ jsonrpc: '2.0', id: '1', result: { ok: true } });
      const msg = extractMessage(parseMessage(json));
      expect(isSuccessResponse(msg)).toBe(true);
    });

    it('should parse a valid error response string', () => {
      const json = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -1, message: 'err' } });
      const msg = extractMessage(parseMessage(json));
      expect(isErrorResponse(msg)).toBe(true);
    });

    it('should parse a valid batch', () => {
      const json = JSON.stringify([
        { jsonrpc: '2.0', id: '1', method: 'test' },
        { jsonrpc: '2.0', method: 'notify' },
      ]);
      const batch = extractBatch(parseMessage(json));
      expect(batch).toHaveLength(2);
    });

    it('should reject invalid JSON', () => {
      const result = parseMessage('{bad json');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('Invalid JSON');
      }
    });

    it('should reject empty batch', () => {
      const result = parseMessage('[]');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('Empty batch');
      }
    });

    it('should reject batch with invalid message', () => {
      const json = JSON.stringify([{ jsonrpc: '2.0', id: '1', method: 'ok' }, { bad: true }]);
      const result = parseMessage(json);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('batch');
      }
    });

    it('should reject non-array non-object', () => {
      const result = parseMessage('"string"');
      expect(result.valid).toBe(false);
    });
  });

  describe('serializeMessage', () => {
    it('should serialize a request', () => {
      const req = createRequest('test', { key: 'value' }, 'id-1');
      const json = serializeMessage(req);
      const parsed = JSON.parse(json);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe('id-1');
      expect(parsed.method).toBe('test');
      expect(parsed.params).toEqual({ key: 'value' });
    });

    it('should serialize a batch', () => {
      const batch = [
        createRequest('test1', {}, '1'),
        createNotification('notify'),
      ];
      const json = serializeMessage(batch);
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    it('should round-trip messages correctly', () => {
      const original = createRequest('acp.task/send', {
        message: { role: 'user', content: 'Hello ACP' },
        sessionId: 'sess-1',
      }, 'req-42');

      const json = serializeMessage(original);
      const result = parseMessage(json);
      expect(result.valid).toBe(true);
      const parsed = result as { valid: true; message: JsonRpcRequest };
      const msg = parsed.message as JsonRpcRequest;
      expect(msg.id).toBe('req-42');
      expect(msg.method).toBe('acp.task/send');
      expect(msg.params).toEqual({
        message: { role: 'user', content: 'Hello ACP' },
        sessionId: 'sess-1',
      });
    });
  });
});
