/**
 * Unit tests for ACP Protocol Errors
 *
 * @module sdk/protocol/errors.test
 */

import { describe, it, expect } from 'vitest';
import {
  ACPProtocolError,
  ACPConnectionError,
  ACPTimeoutError,
} from './errors.js';

describe('ACPProtocolError', () => {
  it('should create error with default values', () => {
    const error = new ACPProtocolError('Something went wrong');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ACPProtocolError);
    expect(error.name).toBe('ACPProtocolError');
    expect(error.message).toBe('Something went wrong');
    expect(error.code).toBe('server_error');
    expect(error.statusCode).toBe(500);
    expect(error.data).toBeUndefined();
  });

  it('should create error with custom code and status', () => {
    const error = new ACPProtocolError(
      'Agent not found',
      'not_found',
      404
    );

    expect(error.code).toBe('not_found');
    expect(error.statusCode).toBe(404);
  });

  it('should create error with data', () => {
    const error = new ACPProtocolError(
      'Validation failed',
      'invalid_input',
      400,
      { field: 'agent_name', reason: 'required' }
    );

    expect(error.data).toEqual({ field: 'agent_name', reason: 'required' });
  });

  it('should create from valid HTTP response body', () => {
    const error = ACPProtocolError.fromResponse(404, {
      code: 'not_found',
      message: 'Agent "xyz" not found',
      data: { agent_name: 'xyz' },
    });

    expect(error.code).toBe('not_found');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Agent "xyz" not found');
    expect(error.data).toEqual({ agent_name: 'xyz' });
  });

  it('should handle invalid error code in response body', () => {
    const error = ACPProtocolError.fromResponse(500, {
      code: 'unknown_code',
      message: 'Internal error',
    });

    expect(error.code).toBe('server_error');
    expect(error.message).toBe('Internal error');
  });

  it('should handle non-object response body', () => {
    const error = ACPProtocolError.fromResponse(500, 'plain text error');

    expect(error.code).toBe('server_error');
    expect(error.message).toBe('ACP request failed with status 500');
  });

  it('should handle null response body', () => {
    const error = ACPProtocolError.fromResponse(502, null);

    expect(error.code).toBe('server_error');
    expect(error.message).toBe('ACP request failed with status 502');
  });

  it('should handle missing message in response body', () => {
    const error = ACPProtocolError.fromResponse(400, {
      code: 'invalid_input',
    });

    expect(error.message).toBe('ACP request failed with status 400');
  });

  it('should handle valid error codes correctly', () => {
    const codes = ['server_error', 'invalid_input', 'not_found'] as const;

    for (const code of codes) {
      const error = new ACPProtocolError('test', code, 400);
      expect(error.code).toBe(code);
    }
  });
});

describe('ACPConnectionError', () => {
  it('should create error with URL', () => {
    const error = new ACPConnectionError('http://localhost:8000');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ACPConnectionError);
    expect(error.name).toBe('ACPConnectionError');
    expect(error.message).toContain('http://localhost:8000');
    expect(error.url).toBe('http://localhost:8000');
    expect(error.cause).toBeUndefined();
  });

  it('should create error with cause', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new ACPConnectionError('http://localhost:8000', cause);

    expect(error.cause).toBe(cause);
    expect(error.message).toContain('http://localhost:8000');
  });

  it('should create error with non-Error cause', () => {
    const error = new ACPConnectionError('http://localhost:8000', new Error('timeout'));

    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('ACPTimeoutError', () => {
  it('should create error with timeout', () => {
    const error = new ACPTimeoutError(30000);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ACPTimeoutError);
    expect(error.name).toBe('ACPTimeoutError');
    expect(error.timeoutMs).toBe(30000);
    expect(error.message).toContain('30000ms');
  });

  it('should create error with custom operation name', () => {
    const error = new ACPTimeoutError(5000, 'stream');

    expect(error.message).toContain('stream');
    expect(error.message).toContain('5000ms');
  });

  it('should use default operation name', () => {
    const error = new ACPTimeoutError(10000);

    expect(error.message).toContain('request');
  });
});
