/**
 * Tests for error types (src/utils/errors.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  AgentExecutionError,
  TimeoutError,
  SDKError,
  FileOperationError,
  ValidationError,
  isRetryable,
  formatError,
} from './errors.js';

describe('AgentExecutionError', () => {
  describe('constructor', () => {
    it('should create error with message only', () => {
      const error = new AgentExecutionError('Something went wrong', {});

      expect(error.message).toBe('Something went wrong');
      expect(error.name).toBe('AgentExecutionError');
      expect(error.options.agent).toBeUndefined();
      expect(error.options.taskId).toBeUndefined();
      expect(error.options.recoverable).toBeUndefined();
    });

    it('should create error with all options', () => {
      const cause = new Error('Original error');
      const error = new AgentExecutionError('Task failed', {
        cause,
        agent: 'Evaluator',
        taskId: 'task-123',
        iteration: 2,
        recoverable: true,
      });

      expect(error.message).toBe('Task failed (caused by: Original error)');
      expect(error.name).toBe('AgentExecutionError');
      expect(error.options.agent).toBe('Evaluator');
      expect(error.options.taskId).toBe('task-123');
      expect(error.options.iteration).toBe(2);
      expect(error.options.recoverable).toBe(true);
      expect(error.options.cause).toBe(cause);
    });

    it('should include cause message in error message', () => {
      const cause = new Error('Network timeout');
      const error = new AgentExecutionError('Operation failed', { cause });

      expect(error.message).toContain('Network timeout');
    });
  });

  describe('toJSON', () => {
    it('should serialize error to JSON', () => {
      const cause = new Error('Root cause');
      const error = new AgentExecutionError('Task failed', {
        cause,
        agent: 'Executor',
        taskId: 'task-456',
        iteration: 1,
        recoverable: false,
      });

      const json = error.toJSON();

      expect(json.name).toBe('AgentExecutionError');
      expect(json.message).toContain('Task failed');
      expect(json.agent).toBe('Executor');
      expect(json.taskId).toBe('task-456');
      expect(json.iteration).toBe(1);
      expect(json.recoverable).toBe(false);
      expect(json.cause).toBe('Root cause');
      expect(json.stack).toBeDefined();
    });

    it('should handle missing optional fields', () => {
      const error = new AgentExecutionError('Simple error', {});
      const json = error.toJSON();

      expect(json.agent).toBeUndefined();
      expect(json.taskId).toBeUndefined();
      expect(json.iteration).toBeUndefined();
      expect(json.recoverable).toBeUndefined();
      expect(json.cause).toBeUndefined();
    });
  });
});

describe('TimeoutError', () => {
  describe('constructor', () => {
    it('should create error with timeout duration', () => {
      const error = new TimeoutError('Operation timed out', 5000);

      expect(error.message).toBe('Operation timed out');
      expect(error.name).toBe('TimeoutError');
      expect(error.timeoutMs).toBe(5000);
      expect(error.operation).toBeUndefined();
    });

    it('should create error with operation name', () => {
      const error = new TimeoutError('Request timed out', 30000, 'API call');

      expect(error.timeoutMs).toBe(30000);
      expect(error.operation).toBe('API call');
    });
  });

  describe('getTimeoutDuration', () => {
    it('should format milliseconds', () => {
      const error = new TimeoutError('Timeout', 500);
      expect(error.getTimeoutDuration()).toBe('500ms');
    });

    it('should format seconds', () => {
      const error = new TimeoutError('Timeout', 5000);
      expect(error.getTimeoutDuration()).toBe('5.0s');
    });

    it('should format partial seconds', () => {
      const error = new TimeoutError('Timeout', 1500);
      expect(error.getTimeoutDuration()).toBe('1.5s');
    });

    it('should format minutes', () => {
      const error = new TimeoutError('Timeout', 120000);
      expect(error.getTimeoutDuration()).toBe('2.0m');
    });

    it('should format partial minutes', () => {
      const error = new TimeoutError('Timeout', 90000);
      expect(error.getTimeoutDuration()).toBe('1.5m');
    });
  });

  describe('toJSON', () => {
    it('should serialize error to JSON', () => {
      const error = new TimeoutError('API timeout', 30000, 'fetchData');

      const json = error.toJSON();

      expect(json.name).toBe('TimeoutError');
      expect(json.message).toBe('API timeout');
      expect(json.timeoutMs).toBe(30000);
      expect(json.timeoutDuration).toBe('30.0s');
      expect(json.operation).toBe('fetchData');
      expect(json.stack).toBeDefined();
    });
  });
});

describe('SDKError', () => {
  describe('constructor', () => {
    it('should create error with SDK details', () => {
      const details = { code: 'RATE_LIMIT', retryAfter: 60 };
      const error = new SDKError('API rate limit exceeded', details, 'query');

      expect(error.message).toBe('API rate limit exceeded');
      expect(error.name).toBe('SDKError');
      expect(error.sdkDetails).toEqual(details);
      expect(error.sdkOperation).toBe('query');
    });

    it('should create error without operation', () => {
      const error = new SDKError('Unknown error', { status: 500 });

      expect(error.sdkOperation).toBeUndefined();
    });
  });

  describe('isRetryable', () => {
    const retryableMessages = [
      'timeout while connecting',
      'Network error',
      'Connection refused',
      'ECONNRESET by peer',
      'ETIMEDOUT waiting for response',
      'ECONNREFUSED',
      'Rate limit exceeded',
      'Temporary unavailable',
      'Service unavailable',
    ];

    it.each(retryableMessages)('should return true for retryable message: %s', (message) => {
      const error = new SDKError(message, {});
      expect(error.isRetryable()).toBe(true);
    });

    const nonRetryableMessages = [
      'Invalid API key',
      'Authentication failed',
      'Not found',
      'Permission denied',
    ];

    it.each(nonRetryableMessages)('should return false for non-retryable message: %s', (message) => {
      const error = new SDKError(message, {});
      expect(error.isRetryable()).toBe(false);
    });

    it('should be case-insensitive', () => {
      const error1 = new SDKError('TIMEOUT', {});
      const error2 = new SDKError('Timeout', {});
      const error3 = new SDKError('timeout', {});

      expect(error1.isRetryable()).toBe(true);
      expect(error2.isRetryable()).toBe(true);
      expect(error3.isRetryable()).toBe(true);
    });
  });

  describe('toJSON', () => {
    it('should serialize error to JSON', () => {
      const details = { status: 429, retryAfter: 60 };
      const error = new SDKError('Rate limit', details, 'stream');

      const json = error.toJSON();

      expect(json.name).toBe('SDKError');
      expect(json.message).toBe('Rate limit');
      expect(json.sdkOperation).toBe('stream');
      expect(json.isRetryable).toBe(true);
      expect(json.sdkDetails).toEqual(details);
      expect(json.stack).toBeDefined();
    });
  });
});

describe('FileOperationError', () => {
  describe('constructor', () => {
    it('should create error with file path and operation', () => {
      const error = new FileOperationError(
        'Failed to read file',
        '/path/to/file.txt',
        'read'
      );

      expect(error.message).toBe('Failed to read file');
      expect(error.name).toBe('FileOperationError');
      expect(error.filePath).toBe('/path/to/file.txt');
      expect(error.operation).toBe('read');
      expect(error.cause).toBeUndefined();
    });

    it('should create error with cause', () => {
      const cause = new Error('ENOENT');
      const error = new FileOperationError(
        'File not found',
        '/missing/file.txt',
        'read',
        cause
      );

      expect(error.cause).toBe(cause);
    });
  });

  describe('toJSON', () => {
    it('should serialize error to JSON', () => {
      const cause = new Error('Permission denied');
      const error = new FileOperationError(
        'Cannot write file',
        '/protected/file.txt',
        'write',
        cause
      );

      const json = error.toJSON();

      expect(json.name).toBe('FileOperationError');
      expect(json.message).toBe('Cannot write file');
      expect(json.filePath).toBe('/protected/file.txt');
      expect(json.operation).toBe('write');
      expect(json.cause).toBe('Permission denied');
      expect(json.stack).toBeDefined();
    });

    it('should handle missing cause', () => {
      const error = new FileOperationError('Error', '/file.txt', 'delete');
      const json = error.toJSON();

      expect(json.cause).toBeUndefined();
    });
  });
});

describe('ValidationError', () => {
  describe('constructor', () => {
    it('should create error with message only', () => {
      const error = new ValidationError('Invalid input');

      expect(error.message).toBe('Invalid input');
      expect(error.name).toBe('ValidationError');
      expect(error.field).toBeUndefined();
      expect(error.value).toBeUndefined();
    });

    it('should create error with field and value', () => {
      const error = new ValidationError(
        'Field is required',
        'username',
        undefined
      );

      expect(error.field).toBe('username');
      expect(error.value).toBeUndefined();
    });

    it('should create error with field and actual value', () => {
      const error = new ValidationError(
        'Must be positive',
        'age',
        -5
      );

      expect(error.field).toBe('age');
      expect(error.value).toBe(-5);
    });
  });

  describe('toJSON', () => {
    it('should serialize error to JSON', () => {
      const error = new ValidationError('Invalid email', 'email', 'not-an-email');

      const json = error.toJSON();

      expect(json.name).toBe('ValidationError');
      expect(json.message).toBe('Invalid email');
      expect(json.field).toBe('email');
      expect(json.value).toBe('not-an-email');
      expect(json.stack).toBeDefined();
    });
  });
});

describe('isRetryable', () => {
  it('should return true for retryable SDKError', () => {
    const error = new SDKError('timeout', {});
    expect(isRetryable(error)).toBe(true);
  });

  it('should return false for non-retryable SDKError', () => {
    const error = new SDKError('invalid key', {});
    expect(isRetryable(error)).toBe(false);
  });

  it('should return true for recoverable AgentExecutionError', () => {
    const error = new AgentExecutionError('Failed', { recoverable: true });
    expect(isRetryable(error)).toBe(true);
  });

  it('should return false for non-recoverable AgentExecutionError', () => {
    const error = new AgentExecutionError('Failed', { recoverable: false });
    expect(isRetryable(error)).toBe(false);
  });

  it('should return false for TimeoutError', () => {
    const error = new TimeoutError('Timed out', 5000);
    expect(isRetryable(error)).toBe(false);
  });

  it('should return true for FileOperationError', () => {
    const error = new FileOperationError('File locked', '/file.txt', 'write');
    expect(isRetryable(error)).toBe(true);
  });

  it('should return false for ValidationError', () => {
    const error = new ValidationError('Invalid', 'field');
    expect(isRetryable(error)).toBe(false);
  });

  it('should return false for generic Error', () => {
    const error = new Error('Something went wrong');
    expect(isRetryable(error)).toBe(false);
  });
});

describe('formatError', () => {
  it('should format AgentExecutionError', () => {
    const error = new AgentExecutionError('Failed', { agent: 'Test' });
    const formatted = formatError(error);

    expect(formatted.name).toBe('AgentExecutionError');
    expect(formatted.agent).toBe('Test');
  });

  it('should format TimeoutError', () => {
    const error = new TimeoutError('Timeout', 1000);
    const formatted = formatError(error);

    expect(formatted.name).toBe('TimeoutError');
    expect(formatted.timeoutDuration).toBe('1.0s'); // 1000ms = 1.0s
  });

  it('should format SDKError', () => {
    const error = new SDKError('API error', { code: 500 });
    const formatted = formatError(error);

    expect(formatted.name).toBe('SDKError');
    expect(formatted.isRetryable).toBe(false);
  });

  it('should format FileOperationError', () => {
    const error = new FileOperationError('Error', '/file.txt', 'read');
    const formatted = formatError(error);

    expect(formatted.name).toBe('FileOperationError');
    expect(formatted.filePath).toBe('/file.txt');
  });

  it('should format ValidationError', () => {
    const error = new ValidationError('Invalid', 'field', 'value');
    const formatted = formatError(error);

    expect(formatted.name).toBe('ValidationError');
    expect(formatted.field).toBe('field');
  });

  it('should format generic Error', () => {
    const error = new Error('Generic error');
    const formatted = formatError(error);

    expect(formatted.name).toBe('Error');
    expect(formatted.message).toBe('Generic error');
    expect(formatted.stack).toBeDefined();
  });
});
