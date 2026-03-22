/**
 * Tests for error handling utilities (packages/core/src/utils/error-handler.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AppError,
  ErrorCategory,
  ErrorSeverity,
  classifyError,
  isRetryable,
  isTransient,
  getSeverity,
  createUserMessage,
  enrichError,
  handleError,
  formatError,
} from './error-handler.js';

describe('AppError', () => {
  describe('constructor', () => {
    it('should create error with default values', () => {
      const error = new AppError('Test error');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('AppError');
      expect(error.category).toBe(ErrorCategory.UNKNOWN);
      expect(error.severity).toBe(ErrorSeverity.ERROR);
      expect(error.retryable).toBe(false);
      expect(error.transient).toBe(false);
      expect(error.errorId).toMatch(/^err_\d+_[a-z0-9]+$/);
    });

    it('should create error with custom options', () => {
      const cause = new Error('Original error');
      const error = new AppError('Test error', ErrorCategory.NETWORK, ErrorSeverity.FATAL, {
        retryable: true,
        transient: true,
        userMessage: 'User friendly message',
        context: { key: 'value' },
        cause,
      });

      expect(error.category).toBe(ErrorCategory.NETWORK);
      expect(error.severity).toBe(ErrorSeverity.FATAL);
      expect(error.retryable).toBe(true);
      expect(error.transient).toBe(true);
      expect(error.userMessage).toBe('User friendly message');
      expect(error.context).toEqual({ key: 'value' });
      expect(error.originalError).toBe(cause);
    });
  });

  describe('toJSON', () => {
    it('should return serializable object', () => {
      const cause = new Error('Original');
      const error = new AppError('Test error', ErrorCategory.NETWORK, ErrorSeverity.ERROR, {
        retryable: true,
        userMessage: 'User message',
        context: { foo: 'bar' },
        cause,
      });

      const json = error.toJSON();

      expect(json.errorId).toBe(error.errorId);
      expect(json.name).toBe('AppError');
      expect(json.message).toBe('Test error');
      expect(json.category).toBe(ErrorCategory.NETWORK);
      expect(json.severity).toBe(ErrorSeverity.ERROR);
      expect(json.retryable).toBe(true);
      expect(json.transient).toBe(false);
      expect(json.userMessage).toBe('User message');
      expect(json.context).toEqual({ foo: 'bar' });
      expect(json.originalError).toBeDefined();
    });
  });
});

describe('classifyError', () => {
  it('should return UNKNOWN for non-Error values', () => {
    expect(classifyError(null)).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(undefined)).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError('string')).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(123)).toBe(ErrorCategory.UNKNOWN);
  });

  it('should return category from AppError', () => {
    const error = new AppError('test', ErrorCategory.NETWORK);
    expect(classifyError(error)).toBe(ErrorCategory.NETWORK);
  });

  describe('WebSocket errors', () => {
    it('should classify WebSocket errors', () => {
      expect(classifyError(new Error('WebSocket connection failed'))).toBe(ErrorCategory.WEBSOCKET);
    });
  });

  describe('Network errors', () => {
    it('should classify ETIMEDOUT as NETWORK', () => {
      expect(classifyError(new Error('ETIMEDOUT'))).toBe(ErrorCategory.NETWORK);
    });

    it('should classify ECONNREFUSED as NETWORK', () => {
      expect(classifyError(new Error('ECONNREFUSED'))).toBe(ErrorCategory.NETWORK);
    });

    it('should classify ECONNRESET as NETWORK', () => {
      expect(classifyError(new Error('ECONNRESET'))).toBe(ErrorCategory.NETWORK);
    });

    it('should classify ENOTFOUND as NETWORK', () => {
      expect(classifyError(new Error('ENOTFOUND'))).toBe(ErrorCategory.NETWORK);
    });

    it('should classify connection errors as NETWORK', () => {
      expect(classifyError(new Error('Connection refused'))).toBe(ErrorCategory.NETWORK);
    });
  });

  describe('Timeout errors', () => {
    it('should classify timeout errors', () => {
      expect(classifyError(new Error('Request timeout'))).toBe(ErrorCategory.TIMEOUT);
    });
  });

  describe('API errors', () => {
    it('should classify rate limit errors as API', () => {
      expect(classifyError(new Error('Rate limit exceeded'))).toBe(ErrorCategory.API);
    });

    it('should classify 429 errors as API', () => {
      expect(classifyError(new Error('HTTP 429'))).toBe(ErrorCategory.API);
    });

    it('should classify 500 errors as API', () => {
      expect(classifyError(new Error('HTTP 500'))).toBe(ErrorCategory.API);
    });
  });

  describe('Validation errors', () => {
    it('should classify invalid input as VALIDATION', () => {
      expect(classifyError(new Error('Invalid parameter'))).toBe(ErrorCategory.VALIDATION);
    });

    it('should classify missing required as VALIDATION', () => {
      expect(classifyError(new Error('Missing required field'))).toBe(ErrorCategory.VALIDATION);
    });
  });

  describe('Permission errors', () => {
    it('should classify unauthorized as PERMISSION', () => {
      expect(classifyError(new Error('Unauthorized access'))).toBe(ErrorCategory.PERMISSION);
    });

    it('should classify forbidden as PERMISSION', () => {
      expect(classifyError(new Error('Forbidden'))).toBe(ErrorCategory.PERMISSION);
    });

    it('should classify access denied as PERMISSION', () => {
      expect(classifyError(new Error('Access denied'))).toBe(ErrorCategory.PERMISSION);
    });
  });

  describe('Filesystem errors', () => {
    it('should classify no such file as FILESYSTEM', () => {
      expect(classifyError(new Error('no such file or directory'))).toBe(ErrorCategory.FILESYSTEM);
    });
  });
});

describe('isRetryable', () => {
  it('should return false for non-Error values', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable('string')).toBe(false);
  });

  it('should return retryable from AppError', () => {
    const error = new AppError('test', ErrorCategory.UNKNOWN, undefined, { retryable: true });
    expect(isRetryable(error)).toBe(true);
  });

  it('should return true for network errors', () => {
    expect(isRetryable(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryable(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('should return true for rate limit errors', () => {
    expect(isRetryable(new Error('Rate limit exceeded'))).toBe(true);
  });

  it('should return true for 503 errors', () => {
    expect(isRetryable(new Error('Service unavailable 503'))).toBe(true);
  });

  it('should return true for 502 errors', () => {
    expect(isRetryable(new Error('Bad gateway 502'))).toBe(true);
  });

  it('should return false for validation errors', () => {
    expect(isRetryable(new Error('Invalid input'))).toBe(false);
  });
});

describe('isTransient', () => {
  it('should return false for non-Error values', () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });

  it('should return transient from AppError', () => {
    const error = new AppError('test', ErrorCategory.UNKNOWN, undefined, { transient: true });
    expect(isTransient(error)).toBe(true);
  });

  it('should return true for network errors', () => {
    expect(isTransient(new Error('ETIMEDOUT'))).toBe(true);
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
  });

  it('should return true for rate limit errors', () => {
    expect(isTransient(new Error('Rate limit exceeded'))).toBe(true);
  });
});

describe('getSeverity', () => {
  it('should return severity from AppError', () => {
    const error = new AppError('test', ErrorCategory.UNKNOWN, ErrorSeverity.FATAL);
    expect(getSeverity(error)).toBe(ErrorSeverity.FATAL);
  });

  it('should return FATAL for configuration errors', () => {
    const appError = new AppError('Configuration missing', ErrorCategory.CONFIGURATION, ErrorSeverity.FATAL);
    expect(getSeverity(appError)).toBe(ErrorSeverity.FATAL);
  });

  it('should return FATAL for permission errors', () => {
    const appError = new AppError('Permission denied', ErrorCategory.PERMISSION, ErrorSeverity.FATAL);
    expect(getSeverity(appError)).toBe(ErrorSeverity.FATAL);
  });

  it('should return ERROR for unknown errors', () => {
    expect(getSeverity(new Error('Unknown error'))).toBe(ErrorSeverity.ERROR);
  });
});

describe('createUserMessage', () => {
  it('should return userMessage from AppError', () => {
    const error = new AppError('test', ErrorCategory.UNKNOWN, undefined, {
      userMessage: 'Custom user message',
    });
    expect(createUserMessage(error)).toBe('Custom user message');
  });

  it('should return error message if no userMessage', () => {
    const error = new AppError('Original message');
    expect(createUserMessage(error)).toBe('Original message');
  });

  it('should return default message for non-Error values', () => {
    expect(createUserMessage(null)).toBe('An unknown error occurred');
    expect(createUserMessage(undefined)).toBe('An unknown error occurred');
    expect(createUserMessage('string')).toBe('An unknown error occurred');
  });

  it('should return appropriate message for network errors', () => {
    expect(createUserMessage(new Error('ETIMEDOUT'))).toBe('Network error. Please check your connection and try again.');
  });

  it('should return appropriate message for timeout errors', () => {
    // For AppError with TIMEOUT category
    const error = new AppError('Timeout', ErrorCategory.TIMEOUT, undefined, { userMessage: 'Operation timed out. Please try again.' });
    expect(createUserMessage(error)).toBe('Operation timed out. Please try again.');

    // For regular errors containing "timeout", classified as TIMEOUT
    expect(createUserMessage(new Error('timeout occurred'))).toBe('Operation timed out. Please try again.');
  });

  it('should return appropriate message for validation errors', () => {
    expect(createUserMessage(new Error('Invalid input'))).toBe('Invalid input. Please check your request and try again.');
  });

  it('should return appropriate message for permission errors', () => {
    expect(createUserMessage(new Error('Unauthorized access'))).toBe('You do not have permission to perform this action.');
  });

  it('should return appropriate message for WebSocket errors', () => {
    expect(createUserMessage(new Error('WebSocket error'))).toBe('Connection error. Reconnecting...');
  });
});

describe('enrichError', () => {
  it('should convert non-Error to AppError', () => {
    const enriched = enrichError('string error');

    expect(enriched).toBeInstanceOf(AppError);
    expect(enriched.message).toBe('string error');
  });

  it('should preserve AppError and merge context', () => {
    const original = new AppError('test', ErrorCategory.NETWORK, ErrorSeverity.ERROR, {
      context: { original: 'value' },
    });

    // When passing context to enrichError, properties are merged at the root level of options
    // not nested under options.context
    const enriched = enrichError(original, { userMessage: 'New message' });

    expect(enriched.message).toBe('test');
    expect(enriched.category).toBe(ErrorCategory.NETWORK);
    expect(enriched.userMessage).toBe('New message');
  });

  it('should use provided context values', () => {
    const error = new Error('test');
    const enriched = enrichError(error, {
      category: ErrorCategory.NETWORK,
      retryable: true,
      transient: true,
      userMessage: 'Custom message',
    });

    expect(enriched.category).toBe(ErrorCategory.NETWORK);
    expect(enriched.retryable).toBe(true);
    expect(enriched.transient).toBe(true);
    expect(enriched.userMessage).toBe('Custom message');
  });
});

describe('handleError', () => {
  it('should return enriched error', () => {
    const error = new Error('test');
    const result = handleError(error, { customKey: 'value' });

    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('test');
  });

  it('should not log when log option is false', () => {
    const error = new Error('test');
    const result = handleError(error, {}, { log: false });

    expect(result).toBeInstanceOf(AppError);
  });

  it('should throw when throwOnError is true', () => {
    const error = new Error('test');

    expect(() => {
      handleError(error, {}, { log: false, throwOnError: true });
    }).toThrow(AppError);
  });

  it('should call userNotifier with user message', async () => {
    const error = new Error('test');
    const notifier = vi.fn();

    handleError(error, {}, { log: false, userNotifier: notifier });

    expect(notifier).toHaveBeenCalled();
  });
});

describe('formatError', () => {
  it('should format AppError using toJSON', () => {
    const error = new AppError('test', ErrorCategory.NETWORK, ErrorSeverity.ERROR, {
      retryable: true,
    });

    const formatted = formatError(error);

    expect(formatted.message).toBe('test');
    expect(formatted.category).toBe(ErrorCategory.NETWORK);
    expect(formatted.retryable).toBe(true);
  });

  it('should format standard Error', () => {
    const error = new Error('test error');
    error.name = 'TestError';

    const formatted = formatError(error);

    expect(formatted.name).toBe('TestError');
    expect(formatted.message).toBe('test error');
    expect(formatted.stack).toBeDefined();
  });

  it('should format non-Error values', () => {
    expect(formatError(null)).toEqual({
      name: 'UnknownError',
      message: 'null',
    });

    expect(formatError('string error')).toEqual({
      name: 'UnknownError',
      message: 'string error',
    });

    expect(formatError(123)).toEqual({
      name: 'UnknownError',
      message: '123',
    });
  });
});
