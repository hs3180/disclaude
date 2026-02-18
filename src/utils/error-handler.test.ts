/**
 * Tests for error handler utilities (src/utils/error-handler.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyError,
  isRetryable,
  isTransient,
  getSeverity,
  createUserMessage,
  enrichError,
  handleError,
  AppError,
  ErrorCategory,
  ErrorSeverity,
} from './error-handler.js';

describe('AppError', () => {
  it('should create error with all properties', () => {
    const error = new AppError('Test error', ErrorCategory.NETWORK, ErrorSeverity.ERROR, {
      retryable: true,
      transient: true,
      userMessage: 'User-friendly message',
      context: { key: 'value' },
    });

    expect(error.message).toBe('Test error');
    expect(error.category).toBe(ErrorCategory.NETWORK);
    expect(error.severity).toBe(ErrorSeverity.ERROR);
    expect(error.retryable).toBe(true);
    expect(error.transient).toBe(true);
    expect(error.userMessage).toBe('User-friendly message');
    expect(error.context).toEqual({ key: 'value' });
    expect(error.errorId).toMatch(/^err_\d+_[a-z0-9]+$/);
  });

  it('should have default values', () => {
    const error = new AppError('Test error');
    expect(error.category).toBe(ErrorCategory.UNKNOWN);
    expect(error.severity).toBe(ErrorSeverity.ERROR);
    expect(error.retryable).toBe(false);
    expect(error.transient).toBe(false);
  });

  it('should serialize to JSON', () => {
    const error = new AppError('Test', ErrorCategory.API, ErrorSeverity.WARN, {
      context: { url: '/api/test' },
      cause: new Error('Original'),
    });
    const json = error.toJSON();

    expect(json.errorId).toBeDefined();
    expect(json.name).toBe('AppError');
    expect(json.message).toBe('Test');
    expect(json.category).toBe(ErrorCategory.API);
    expect(json.originalError?.message).toBe('Original');
  });
});

describe('classifyError', () => {
  const classificationTests = [
    // Network errors
    { msg: 'ETIMEDOUT', expected: ErrorCategory.NETWORK },
    { msg: 'ENOTFOUND', expected: ErrorCategory.NETWORK },
    { msg: 'ECONNREFUSED', expected: ErrorCategory.NETWORK },
    // Timeout errors
    { msg: 'operation timeout', expected: ErrorCategory.TIMEOUT },
    { msg: 'TimeoutError', expected: ErrorCategory.TIMEOUT },
    // API errors
    { msg: 'rate limit exceeded', expected: ErrorCategory.API },
    { msg: 'HTTP 429', expected: ErrorCategory.API },
    { msg: '500 Internal Server Error', expected: ErrorCategory.API },
    // Validation errors
    { msg: 'invalid input', expected: ErrorCategory.VALIDATION },
    { msg: 'required field missing', expected: ErrorCategory.VALIDATION },
    // Permission errors
    { msg: 'unauthorized', expected: ErrorCategory.PERMISSION },
    { msg: 'forbidden', expected: ErrorCategory.PERMISSION },
    // Filesystem errors
    { msg: 'ENOENT: no such file', expected: ErrorCategory.FILESYSTEM },
    // WebSocket errors
    { msg: 'WebSocket connection failed', expected: ErrorCategory.WEBSOCKET },
    { msg: 'websocket error', expected: ErrorCategory.WEBSOCKET },
    // Unknown
    { msg: 'something unexpected', expected: ErrorCategory.UNKNOWN },
  ];

  it.each(classificationTests)('should classify "$msg" as $expected', ({ msg, expected }) => {
    expect(classifyError(new Error(msg))).toBe(expected);
  });

  it('should return AppError category for AppError instances', () => {
    expect(classifyError(new AppError('Test', ErrorCategory.SDK))).toBe(ErrorCategory.SDK);
  });

  it('should return UNKNOWN for non-Error objects', () => {
    expect(classifyError('string error')).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(null)).toBe(ErrorCategory.UNKNOWN);
  });
});

describe('isRetryable / isTransient', () => {
  const retryableTests = [
    { msg: 'ETIMEDOUT', retryable: true, transient: true },
    { msg: 'ECONNRESET', retryable: true, transient: true },
    { msg: 'rate limit exceeded', retryable: true, transient: true },
    { msg: 'invalid input', retryable: false, transient: false },
    { msg: 'unauthorized', retryable: false, transient: false },
  ];

  it.each(retryableTests)('should handle "$msg" correctly', ({ msg, retryable, transient }) => {
    const error = new Error(msg);
    expect(isRetryable(error)).toBe(retryable);
    expect(isTransient(error)).toBe(transient);
  });

  it('should use AppError properties', () => {
    const error = new AppError('Test', ErrorCategory.UNKNOWN, ErrorSeverity.ERROR, { retryable: true, transient: true });
    expect(isRetryable(error)).toBe(true);
    expect(isTransient(error)).toBe(true);
  });
});

describe('getSeverity', () => {
  it('should return FATAL for configuration/permission errors', () => {
    expect(getSeverity(new AppError('Config', ErrorCategory.CONFIGURATION, ErrorSeverity.FATAL))).toBe(ErrorSeverity.FATAL);
    expect(getSeverity(new Error('unauthorized'))).toBe(ErrorSeverity.FATAL);
  });

  it('should return ERROR for other errors', () => {
    expect(getSeverity(new Error('some error'))).toBe(ErrorSeverity.ERROR);
  });

  it('should use AppError severity', () => {
    expect(getSeverity(new AppError('Test', ErrorCategory.UNKNOWN, ErrorSeverity.WARN))).toBe(ErrorSeverity.WARN);
  });
});

describe('createUserMessage', () => {
  const userMessageTests = [
    { msg: 'ETIMEDOUT', contains: 'Network' },
    { msg: 'operation timeout', contains: 'timed' },
    { msg: 'rate limit exceeded', contains: 'unavailable' },
    { msg: 'invalid input', contains: 'Invalid' },
    { msg: 'unauthorized', contains: 'permission' },
    { msg: 'ENOENT: no such file', contains: 'File system' },
    { msg: 'WebSocket error', contains: 'Reconnecting' },
    { msg: 'something unexpected', contains: 'unexpected' },
  ];

  it.each(userMessageTests)('should handle "$msg"', ({ msg, contains }) => {
    expect(createUserMessage(new Error(msg))).toContain(contains);
  });

  it('should use AppError userMessage if available', () => {
    expect(createUserMessage(new AppError('Tech', ErrorCategory.UNKNOWN, ErrorSeverity.ERROR, { userMessage: 'Custom' }))).toBe('Custom');
  });

  it('should handle non-Error objects', () => {
    expect(createUserMessage('string error')).toContain('unknown');
  });
});

describe('enrichError', () => {
  it('should enrich Error with context', () => {
    const enriched = enrichError(new Error('Test'), { category: ErrorCategory.NETWORK, retryable: true });
    expect(enriched).toBeInstanceOf(AppError);
    expect(enriched.category).toBe(ErrorCategory.NETWORK);
    expect(enriched.retryable).toBe(true);
  });

  it('should convert non-Error to AppError', () => {
    const enriched = enrichError('string error');
    expect(enriched).toBeInstanceOf(AppError);
    expect(enriched.message).toBe('string error');
  });
});

describe('handleError', () => {
  it('should return enriched error without throwing by default', () => {
    const result = handleError(new Error('Test'));
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('Test');
  });

  it('should throw when throwOnError is true', () => {
    expect(() => handleError(new Error('Test'), {}, { throwOnError: true })).toThrow(AppError);
  });

  it('should call userNotifier if provided', () => {
    const notifier = vi.fn();
    handleError(new Error('Test'), {}, { userNotifier: notifier });
    expect(notifier).toHaveBeenCalledTimes(1);
  });
});
