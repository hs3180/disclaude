/**
 * Tests for JSON-RPC 2.0 message types and utilities.
 *
 * Verifies message construction, parsing, and validation.
 *
 * @see Issue #1333 - 支持OpenAI Agent
 */

import { describe, it, expect } from 'vitest';
import {
  JsonRpcErrorCode,
  AcpJsonRpcMethod,
  createRequest,
  createNotification,
  createSuccessResponse,
  createErrorResponse,
  isRequest,
  isNotification,
  isSuccessResponse,
  isErrorResponse,
  validateMessage,
  type JsonRpcMessage,
} from './jsonrpc.js';

describe('createRequest', () => {
  it('should create a request with auto-generated id', () => {
    const request = createRequest('test.method', { key: 'value' });

    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('test.method');
    expect(request.params).toEqual({ key: 'value' });
    expect(request.id).toBeDefined();
    expect(typeof request.id).toBe('string');
  });

  it('should create a request with custom id', () => {
    const request = createRequest('test.method', undefined, 'custom-id');

    expect(request.id).toBe('custom-id');
  });

  it('should create a request without params', () => {
    const request = createRequest('ping');

    expect(request.method).toBe('ping');
    expect(request.params).toBeUndefined();
  });

  it('should create a request with array params', () => {
    const request = createRequest('add', [1, 2]);

    expect(request.params).toEqual([1, 2]);
  });

  it('should create requests with ACP method names', () => {
    const pingReq = createRequest(AcpJsonRpcMethod.PING);
    expect(pingReq.method).toBe('acp.ping');

    const runReq = createRequest(AcpJsonRpcMethod.CREATE_RUN, {
      agent_name: 'test',
    });
    expect(runReq.method).toBe('acp.createRun');
  });
});

describe('createNotification', () => {
  it('should create a notification without id', () => {
    const notification = createNotification('log', { level: 'info' });

    expect(notification.jsonrpc).toBe('2.0');
    expect(notification.method).toBe('log');
    expect(notification.params).toEqual({ level: 'info' });
    expect(notification.id).toBeUndefined();
  });
});

describe('createSuccessResponse', () => {
  it('should create a success response', () => {
    const response = createSuccessResponse('req-1', { result: 'ok' });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('req-1');
    expect(response.result).toEqual({ result: 'ok' });
  });

  it('should create a response with null id', () => {
    const response = createSuccessResponse(null, 'ok');
    expect(response.id).toBeNull();
    expect(response.result).toBe('ok');
  });
});

describe('createErrorResponse', () => {
  it('should create an error response', () => {
    const response = createErrorResponse(
      'req-1',
      JsonRpcErrorCode.METHOD_NOT_FOUND,
      'Method not found'
    );

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('req-1');
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toBe('Method not found');
  });

  it('should include error data', () => {
    const response = createErrorResponse(
      'req-2',
      JsonRpcErrorCode.INVALID_PARAMS,
      'Invalid params',
      { field: 'name' }
    );

    expect(response.error.data).toEqual({ field: 'name' });
  });
});

describe('isRequest', () => {
  it('should identify requests', () => {
    const request = createRequest('test');
    expect(isRequest(request)).toBe(true);
  });

  it('should not identify responses as requests', () => {
    const response = createSuccessResponse('id', {});
    expect(isRequest(response as JsonRpcMessage)).toBe(false);
  });

  it('should identify notifications as requests (they have method)', () => {
    const notification = createNotification('test');
    expect(isRequest(notification)).toBe(true);
  });
});

describe('isNotification', () => {
  it('should identify notifications (no id)', () => {
    const notification = createNotification('test');
    expect(isNotification(notification)).toBe(true);
  });

  it('should not identify requests with id as notifications', () => {
    const request = createRequest('test');
    expect(isNotification(request)).toBe(false);
  });
});

describe('isSuccessResponse', () => {
  it('should identify success responses', () => {
    const response = createSuccessResponse('id', {});
    expect(isSuccessResponse(response as JsonRpcMessage)).toBe(true);
  });

  it('should not identify error responses as success', () => {
    const response = createErrorResponse('id', -1, 'error');
    expect(isSuccessResponse(response as JsonRpcMessage)).toBe(false);
  });

  it('should not identify requests as responses', () => {
    const request = createRequest('test');
    expect(isSuccessResponse(request as JsonRpcMessage)).toBe(false);
  });
});

describe('isErrorResponse', () => {
  it('should identify error responses', () => {
    const response = createErrorResponse('id', -1, 'error');
    expect(isErrorResponse(response as JsonRpcMessage)).toBe(true);
  });

  it('should not identify success responses as errors', () => {
    const response = createSuccessResponse('id', {});
    expect(isErrorResponse(response as JsonRpcMessage)).toBe(false);
  });
});

describe('validateMessage', () => {
  it('should validate a valid request', () => {
    const result = validateMessage({ jsonrpc: '2.0', method: 'test', id: '1' });
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
    const result = validateMessage({
      jsonrpc: '2.0',
      id: '1',
      error: { code: -1, message: 'error' },
    });
    expect(result.valid).toBe(true);
  });

  it('should reject non-objects', () => {
    expect(validateMessage(null).valid).toBe(false);
    expect(validateMessage('string').valid).toBe(false);
    expect(validateMessage(42).valid).toBe(false);
  });

  it('should reject wrong jsonrpc version', () => {
    const result = validateMessage({ jsonrpc: '1.0', method: 'test' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('2.0');
  });

  it('should reject missing jsonrpc field', () => {
    const result = validateMessage({ method: 'test' });
    expect(result.valid).toBe(false);
  });

  it('should reject request with non-string method', () => {
    const result = validateMessage({ jsonrpc: '2.0', method: 123 });
    expect(result.valid).toBe(false);
  });

  it('should reject response without id', () => {
    const result = validateMessage({ jsonrpc: '2.0', result: {} });
    expect(result.valid).toBe(false);
  });

  it('should reject error with invalid error object', () => {
    const result = validateMessage({
      jsonrpc: '2.0',
      id: '1',
      error: { message: 'missing code' },
    });
    expect(result.valid).toBe(false);
  });

  it('should reject empty object', () => {
    const result = validateMessage({});
    expect(result.valid).toBe(false);
  });
});

describe('JsonRpcErrorCode', () => {
  it('should have standard error codes', () => {
    expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
    expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
    expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
    expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
    expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
    expect(JsonRpcErrorCode.SERVER_ERROR).toBe(-32000);
  });
});

describe('AcpJsonRpcMethod', () => {
  it('should have all ACP methods defined', () => {
    expect(AcpJsonRpcMethod.PING).toBe('acp.ping');
    expect(AcpJsonRpcMethod.LIST_AGENTS).toBe('acp.listAgents');
    expect(AcpJsonRpcMethod.GET_AGENT).toBe('acp.getAgent');
    expect(AcpJsonRpcMethod.CREATE_RUN).toBe('acp.createRun');
    expect(AcpJsonRpcMethod.GET_RUN).toBe('acp.getRun');
    expect(AcpJsonRpcMethod.RESUME_RUN).toBe('acp.resumeRun');
    expect(AcpJsonRpcMethod.CANCEL_RUN).toBe('acp.cancelRun');
    expect(AcpJsonRpcMethod.GET_RUN_EVENTS).toBe('acp.getRunEvents');
    expect(AcpJsonRpcMethod.GET_SESSION).toBe('acp.getSession');
  });
});
