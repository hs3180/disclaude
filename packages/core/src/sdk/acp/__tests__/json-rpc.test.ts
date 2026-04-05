/**
 * Tests for JSON-RPC 2.0 message types and utilities.
 *
 * Issue #1333: ACP protocol infrastructure — PR A.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  JsonRpcErrorCode,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcErrorResponse,
  generateId,
  resetIdCounter,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  parseMessage,
  serializeMessage,
} from '../json-rpc.js';

describe('JsonRpcErrorCode', () => {
  it('should have correct reserved error codes', () => {
    expect(JsonRpcErrorCode.ParseError).toBe(-32700);
    expect(JsonRpcErrorCode.InvalidRequest).toBe(-32600);
    expect(JsonRpcErrorCode.MethodNotFound).toBe(-32601);
    expect(JsonRpcErrorCode.InvalidParams).toBe(-32602);
    expect(JsonRpcErrorCode.InternalError).toBe(-32603);
  });
});

describe('generateId / resetIdCounter', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('should generate sequential IDs starting from 1', () => {
    expect(generateId()).toBe(1);
    expect(generateId()).toBe(2);
    expect(generateId()).toBe(3);
  });

  it('should reset counter', () => {
    generateId();
    generateId();
    resetIdCounter();
    expect(generateId()).toBe(1);
  });
});

describe('createRequest', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('should create a request with auto-generated ID', () => {
    const req = createRequest('initialize', { key: 'value' });

    expect(req.jsonrpc).toBe('2.0');
    expect(req.id).toBe(1);
    expect(req.method).toBe('initialize');
    expect(req.params).toEqual({ key: 'value' });
  });

  it('should create a request without params', () => {
    const req = createRequest('ping');

    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('ping');
    expect(req.params).toBeUndefined();
  });

  it('should create a request with explicit ID', () => {
    const req = createRequest('test', undefined, 'custom-id');

    expect(req.id).toBe('custom-id');
  });
});

describe('createNotification', () => {
  it('should create a notification without id', () => {
    const notif = createNotification('sessionUpdate', { sessionId: 'abc' });

    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe('sessionUpdate');
    expect(notif.params).toEqual({ sessionId: 'abc' });
    expect('id' in notif).toBe(false);
  });
});

describe('createSuccessResponse', () => {
  it('should create a success response', () => {
    const resp = createSuccessResponse(1, { sessionId: 'abc' });

    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ sessionId: 'abc' });
  });
});

describe('createErrorResponse', () => {
  it('should create an error response', () => {
    const resp = createErrorResponse(1, -32601, 'Method not found');

    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(1);
    expect(resp.error).toEqual({
      code: -32601,
      message: 'Method not found',
    });
  });

  it('should create an error response with data', () => {
    const resp = createErrorResponse(1, -32602, 'Invalid params', { field: 'name' });

    expect(resp.error.data).toEqual({ field: 'name' });
  });
});

describe('Type guards', () => {
  it('isJsonRpcRequest should identify requests', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'test' })).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
    expect(isJsonRpcRequest(null)).toBe(false);
    expect(isJsonRpcRequest('string')).toBe(false);
  });

  it('isJsonRpcNotification should identify notifications', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'update' })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'update' })).toBe(false);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'update', params: {} })).toBe(true);
  });

  it('isJsonRpcResponse should identify responses', () => {
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, method: 'test' })).toBe(false);
  });

  it('isJsonRpcErrorResponse should identify error responses', () => {
    expect(isJsonRpcErrorResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'err' } })).toBe(true);
    expect(isJsonRpcErrorResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
  });
});

describe('parseMessage', () => {
  it('should parse a valid JSON-RPC request', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');

    expect(msg).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
  });

  it('should parse a valid JSON-RPC notification', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","method":"sessionUpdate"}');

    expect(isJsonRpcNotification(msg)).toBe(true);
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseMessage('not json')).toThrow();
  });

  it('should throw on missing jsonrpc field', () => {
    expect(() => parseMessage('{"id":1,"method":"test"}')).toThrow('Invalid JSON-RPC message');
  });

  it('should throw on wrong jsonrpc version', () => {
    expect(() => parseMessage('{"jsonrpc":"1.0","id":1,"method":"test"}')).toThrow('Invalid JSON-RPC message');
  });
});

describe('serializeMessage', () => {
  it('should serialize a request with newline', () => {
    const req = createRequest('test', { key: 'value' }, 1);
    const serialized = serializeMessage(req);

    expect(serialized).toBe('{"jsonrpc":"2.0","id":1,"method":"test","params":{"key":"value"}}\n');
  });

  it('should serialize a notification', () => {
    const notif = createNotification('update');
    const serialized = serializeMessage(notif);

    expect(serialized).toBe('{"jsonrpc":"2.0","method":"update"}\n');
  });

  it('should produce valid round-trip', () => {
    const original = createRequest('initialize', { clientInfo: { name: 'test', version: '1.0' } }, 42);
    const serialized = serializeMessage(original);
    const parsed = parseMessage(serialized.trim());

    expect(parsed).toEqual(original);
  });
});
