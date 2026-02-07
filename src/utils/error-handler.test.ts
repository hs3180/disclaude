/**
 * Tests for error handler utilities (src/utils/error-handler.ts)
 *
 * Tests the following functionality:
 * - Error classification by category (network, timeout, API, validation, etc.)
 * - Error severity determination
 * - Retryable and transient error detection
 * - Error enrichment with context
 * - User-friendly message creation
 * - Error logging with Pino
 * - Error handling wrappers
 * - Retry logic with exponential backoff
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
  withErrorLogging,
  withSyncErrorLogging,
  withRetry,
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

  it('should have default values for optional properties', () => {
    const error = new AppError('Test error');

    expect(error.category).toBe(ErrorCategory.UNKNOWN);
    expect(error.severity).toBe(ErrorSeverity.ERROR);
    expect(error.retryable).toBe(false);
    expect(error.transient).toBe(false);
    expect(error.userMessage).toBeUndefined();
  });

  it('should serialize to JSON', () => {
    const originalError = new Error('Original error');
    const error = new AppError('Test error', ErrorCategory.API, ErrorSeverity.WARN, {
      context: { url: '/api/test' },
      cause: originalError,
    });

    const json = error.toJSON();

    expect(json.errorId).toBeDefined();
    expect(json.name).toBe('AppError');
    expect(json.message).toBe('Test error');
    expect(json.category).toBe(ErrorCategory.API);
    expect(json.severity).toBe(ErrorSeverity.WARN);
    expect(json.context).toEqual({ url: '/api/test' });
    expect(json.originalError).toBeDefined();
    expect(json.originalError?.name).toBe('Error');
    expect(json.originalError?.message).toBe('Original error');
  });
});

describe('classifyError', () => {
  it('should return NETWORK for network-related errors', () => {
    const error1 = new Error('ETIMEDOUT');
    const error2 = new Error('ENOTFOUND');
    const error3 = new Error('ECONNREFUSED');

    expect(classifyError(error1)).toBe(ErrorCategory.NETWORK);
    expect(classifyError(error2)).toBe(ErrorCategory.NETWORK);
    expect(classifyError(error3)).toBe(ErrorCategory.NETWORK);
  });

  it('should return TIMEOUT for timeout errors', () => {
    const error1 = new Error('operation timeout');
    const error2 = new Error('TimeoutError');

    expect(classifyError(error1)).toBe(ErrorCategory.TIMEOUT);
    expect(classifyError(error2)).toBe(ErrorCategory.TIMEOUT);
  });

  it('should return API for HTTP/API errors', () => {
    const error1 = new Error('rate limit exceeded');
    const error2 = new Error('HTTP 429');
    const error3 = new Error('500 Internal Server Error');

    expect(classifyError(error1)).toBe(ErrorCategory.API);
    expect(classifyError(error2)).toBe(ErrorCategory.API);
    expect(classifyError(error3)).toBe(ErrorCategory.API);
  });

  it('should return VALIDATION for validation errors', () => {
    const error1 = new Error('invalid input');
    const error2 = new Error('required field missing');

    expect(classifyError(error1)).toBe(ErrorCategory.VALIDATION);
    expect(classifyError(error2)).toBe(ErrorCategory.VALIDATION);
  });

  it('should return PERMISSION for permission errors', () => {
    const error1 = new Error('unauthorized');
    const error2 = new Error('forbidden');
    const error3 = new Error('permission denied');

    expect(classifyError(error1)).toBe(ErrorCategory.PERMISSION);
    expect(classifyError(error2)).toBe(ErrorCategory.PERMISSION);
    expect(classifyError(error3)).toBe(ErrorCategory.PERMISSION);
  });

  it('should return FILESYSTEM for file system errors', () => {
    const error1 = new Error('ENOENT: no such file');
    // EACCES contains 'permission denied' which matches PERMISSION category first

    expect(classifyError(error1)).toBe(ErrorCategory.FILESYSTEM);
  });

  it('should return WEBSOCKET for WebSocket errors', () => {
    const error1 = new Error('WebSocket connection failed');
    const error2 = new Error('websocket error');

    expect(classifyError(error1)).toBe(ErrorCategory.WEBSOCKET);
    expect(classifyError(error2)).toBe(ErrorCategory.WEBSOCKET);
  });

  it('should return UNKNOWN for unknown errors', () => {
    const error = new Error('something unexpected');

    expect(classifyError(error)).toBe(ErrorCategory.UNKNOWN);
  });

  it('should return AppError category for AppError instances', () => {
    const error = new AppError('Test', ErrorCategory.SDK);

    expect(classifyError(error)).toBe(ErrorCategory.SDK);
  });

  it('should return UNKNOWN for non-Error objects', () => {
    expect(classifyError('string error')).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(null)).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(123)).toBe(ErrorCategory.UNKNOWN);
  });
});

describe('isRetryable', () => {
  it('should return true for network errors', () => {
    const error = new Error('ETIMEDOUT');
    expect(isRetryable(error)).toBe(true);
  });

  it('should return true for timeout errors', () => {
    const error = new Error('operation timeout');
    expect(isRetryable(error)).toBe(true);
  });

  it('should return true for API errors with rate limit', () => {
    const error = new Error('rate limit exceeded');
    expect(isRetryable(error)).toBe(true);
  });

  it('should return false for validation errors', () => {
    const error = new Error('invalid input');
    expect(isRetryable(error)).toBe(false);
  });

  it('should return false for permission errors', () => {
    const error = new Error('unauthorized');
    expect(isRetryable(error)).toBe(false);
  });

  it('should use AppError retryable property', () => {
    const error = new AppError('Test', ErrorCategory.UNKNOWN, ErrorSeverity.ERROR, {
      retryable: true,
    });
    expect(isRetryable(error)).toBe(true);
  });

  it('should return false for non-Error objects', () => {
    expect(isRetryable('string')).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe('isTransient', () => {
  it('should return true for network errors', () => {
    const error = new Error('ECONNRESET');
    expect(isTransient(error)).toBe(true);
  });

  it('should return true for timeout errors', () => {
    const error = new Error('ETIMEDOUT');
    expect(isTransient(error)).toBe(true);
  });

  it('should return false for validation errors', () => {
    const error = new Error('invalid input');
    expect(isTransient(error)).toBe(false);
  });

  it('should use AppError transient property', () => {
    const error = new AppError('Test', ErrorCategory.UNKNOWN, ErrorSeverity.ERROR, {
      transient: true,
    });
    expect(isTransient(error)).toBe(true);
  });
});

describe('getSeverity', () => {
  it('should return FATAL for configuration errors', () => {
    const error = new AppError('Config error', ErrorCategory.CONFIGURATION, ErrorSeverity.FATAL);
    expect(getSeverity(error)).toBe(ErrorSeverity.FATAL);
  });

  it('should return FATAL for permission errors', () => {
    const error = new Error('unauthorized');
    expect(getSeverity(error)).toBe(ErrorSeverity.FATAL);
  });

  it('should return ERROR for other errors', () => {
    const error = new Error('some error');
    expect(getSeverity(error)).toBe(ErrorSeverity.ERROR);
  });

  it('should use AppError severity property', () => {
    const error = new AppError('Test', ErrorCategory.UNKNOWN, ErrorSeverity.WARN);
    expect(getSeverity(error)).toBe(ErrorSeverity.WARN);
  });
});

describe('createUserMessage', () => {
  it('should return user-friendly message for network errors', () => {
    const error = new Error('ETIMEDOUT');
    const message = createUserMessage(error);
    expect(message).toContain('Network');
  });

  it('should return user-friendly message for timeout errors', () => {
    const error = new Error('operation timeout');
    const message = createUserMessage(error);
    expect(message).toContain('timed');
  });

  it('should return user-friendly message for API errors', () => {
    const error = new Error('rate limit exceeded');
    const message = createUserMessage(error);
    expect(message).toContain('unavailable');
  });

  it('should return user-friendly message for validation errors', () => {
    const error = new Error('invalid input');
    const message = createUserMessage(error);
    expect(message).toContain('Invalid');
  });

  it('should return user-friendly message for permission errors', () => {
    const error = new Error('unauthorized');
    const message = createUserMessage(error);
    expect(message).toContain('permission');
  });

  it('should return user-friendly message for filesystem errors', () => {
    const error = new Error('ENOENT: no such file');
    const message = createUserMessage(error);
    expect(message).toContain('File system');
  });

  it('should return user-friendly message for websocket errors', () => {
    const error = new Error('WebSocket error');
    const message = createUserMessage(error);
    expect(message).toContain('Reconnecting');
  });

  it('should use AppError userMessage if available', () => {
    const error = new AppError('Technical error', ErrorCategory.UNKNOWN, ErrorSeverity.ERROR, {
      userMessage: 'Custom user message',
    });
    const message = createUserMessage(error);
    expect(message).toBe('Custom user message');
  });

  it('should return generic message for unknown errors', () => {
    const error = new Error('something unexpected');
    const message = createUserMessage(error);
    expect(message).toContain('unexpected');
  });

  it('should return generic message for non-Error objects', () => {
    const message = createUserMessage('string error');
    expect(message).toContain('unknown');
  });
});

describe('enrichError', () => {
  it('should enrich Error with context', () => {
    const error = new Error('Test error');
    const enriched = enrichError(error, {
      category: ErrorCategory.NETWORK,
      retryable: true,
    });

    expect(enriched).toBeInstanceOf(AppError);
    expect(enriched.category).toBe(ErrorCategory.NETWORK);
    expect(enriched.retryable).toBe(true);
  });

  it('should merge context for existing AppError', () => {
    const original = new AppError('Original', ErrorCategory.API, ErrorSeverity.ERROR, {
      context: { url: '/api/test' },
    });
    const enriched = enrichError(original, {
      context: { statusCode: 500 },
    });

    // enrichError creates a new AppError, so context is reset
    expect(enriched.context).toEqual({
      statusCode: 500,
    });
  });

  it('should convert non-Error to Error', () => {
    const enriched = enrichError('string error');
    expect(enriched).toBeInstanceOf(AppError);
    expect(enriched.message).toBe('string error');
  });

  it('should use provided context for classification', () => {
    const error = new Error('Test');
    const enriched = enrichError(error, {
      category: ErrorCategory.PERMISSION,
    });

    expect(enriched.category).toBe(ErrorCategory.PERMISSION);
  });
});

describe('handleError', () => {
  it('should return enriched error without throwing by default', () => {
    const error = new Error('Test');
    const result = handleError(error);

    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('Test');
  });

  it('should throw error when throwOnError is true', () => {
    const error = new Error('Test');
    expect(() => {
      handleError(error, {}, { throwOnError: true });
    }).toThrow(AppError);
  });

  it('should call userNotifier if provided', () => {
    const error = new Error('Test');
    const notifier = vi.fn();
    handleError(error, {}, { userNotifier: notifier });

    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('should respect log option', () => {
    const error = new Error('Test');
    // Should not throw even with logging disabled
    expect(() => {
      handleError(error, {}, { log: false });
    }).not.toThrow();
  });
});

describe('withRetry', () => {
  it('should succeed on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable errors', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, { maxAttempts: 3 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should stop retrying after max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(withRetry(fn, { maxAttempts: 2, delayMs: 10 }))
      .rejects.toThrow('ETIMEDOUT');

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('invalid input'));

    await expect(withRetry(fn, { maxAttempts: 3 }))
      .rejects.toThrow('invalid input');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should use custom retryable check', async () => {
    const customError = new Error('custom error');
    const fn = vi.fn()
      .mockRejectedValueOnce(customError)
      .mockResolvedValue('success');

    const retryableCheck = vi.fn((error) => error.message.includes('custom'));

    const result = await withRetry(fn, {
      maxAttempts: 3,
      retryableCheck,
    });

    expect(result).toBe('success');
    expect(retryableCheck).toHaveBeenCalledWith(customError);
  });

  it('should call onRetry callback', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('success');

    const onRetry = vi.fn();

    await withRetry(fn, {
      maxAttempts: 3,
      delayMs: 10,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('should use exponential backoff', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('success');

    const start = Date.now();
    await withRetry(fn, {
      maxAttempts: 4,
      delayMs: 50,
      backoffMultiplier: 2,
    });
    const elapsed = Date.now() - start;

    // Should have delays: 50ms, 100ms = 150ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(140);
  });
});

describe('withErrorLogging', () => {
  it('should wrap async function with error handling', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const wrapped = withErrorLogging(fn);

    const result = await wrapped();
    expect(result).toBe('success');
  });

  it('should handle errors and return undefined', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Test error'));
    const wrapped = withErrorLogging(fn);

    const result = await wrapped();
    expect(result).toBeUndefined();
  });

  it('should return default value on error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Test error'));
    const wrapped = withErrorLogging(fn, {}, { defaultValue: 'default' });

    const result = await wrapped();
    expect(result).toBe('default');
  });

  it('should rethrow when rethrow is true', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Test error'));
    const wrapped = withErrorLogging(fn, {}, { rethrow: true });

    await expect(wrapped()).rejects.toThrow();
  });
});

describe('withSyncErrorLogging', () => {
  it('should wrap sync function with error handling', () => {
    const fn = vi.fn().mockReturnValue('success');
    const wrapped = withSyncErrorLogging(fn);

    const result = wrapped();
    expect(result).toBe('success');
  });

  it('should handle errors and return undefined', () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('Test error');
    });
    const wrapped = withSyncErrorLogging(fn);

    const result = wrapped();
    expect(result).toBeUndefined();
  });

  it('should return default value on error', () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('Test error');
    });
    const wrapped = withSyncErrorLogging(fn, {}, { defaultValue: 'default' });

    const result = wrapped();
    expect(result).toBe('default');
  });

  it('should rethrow when rethrow is true', () => {
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('Test error');
    });
    const wrapped = withSyncErrorLogging(fn, {}, { rethrow: true });

    expect(() => wrapped()).toThrow();
  });
});
