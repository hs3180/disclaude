/**
 * Tests for retry utility functions (packages/core/src/utils/retry.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import { retry, retryAsyncIterable, withRetry } from './retry.js';
import { AppError, ErrorCategory } from './error-handler.js';

describe('retry', () => {
  describe('successful operations', () => {
    it('should return result immediately on success', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const result = await retry(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should pass options to operation', async () => {
      const operation = vi.fn().mockResolvedValue('result');

      await retry(operation, { maxRetries: 2 });

      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry behavior', () => {
    it('should retry on retryable error', async () => {
      const networkError = new Error('ETIMEDOUT');
      const operation = vi.fn()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce('success');

      const result = await retry(operation, {
        maxRetries: 1,
        initialDelayMs: 1,
        jitter: false,
      });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should call onRetry callback before each retry', async () => {
      const networkError = new Error('ECONNRESET');
      const onRetry = vi.fn();
      const operation = vi.fn()
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce('success');

      await retry(operation, {
        maxRetries: 2,
        initialDelayMs: 1,
        jitter: false,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, networkError);
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, networkError);
    });

    it('should respect maxRetries option', async () => {
      const networkError = new Error('ETIMEDOUT');
      const operation = vi.fn().mockRejectedValue(networkError);

      await expect(retry(operation, {
        maxRetries: 2,
        initialDelayMs: 1,
        jitter: false,
      })).rejects.toThrow('ETIMEDOUT');

      expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('non-retryable errors', () => {
    it('should not retry on non-retryable error', async () => {
      const validationError = new Error('Invalid input');
      const operation = vi.fn().mockRejectedValue(validationError);

      await expect(retry(operation)).rejects.toThrow('Invalid input');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should not retry on AppError with retryable=false', async () => {
      const appError = new AppError(
        'Validation failed',
        ErrorCategory.VALIDATION,
        undefined,
        { retryable: false }
      );
      const operation = vi.fn().mockRejectedValue(appError);

      await expect(retry(operation)).rejects.toThrow('Validation failed');
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('exponential backoff', () => {
    it('should delay between retries', async () => {
      const networkError = new Error('ETIMEDOUT');
      const operation = vi.fn()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce('success');

      const startTime = Date.now();
      await retry(operation, {
        maxRetries: 1,
        initialDelayMs: 50,
        jitter: false,
      });
      const elapsed = Date.now() - startTime;

      // Should have delayed at least 50ms
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should add jitter when enabled', async () => {
      const networkError = new Error('ETIMEDOUT');
      const operation = vi.fn()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce('success');

      // With jitter, delay should be between 50% and 100% of base delay
      const startTime = Date.now();
      await retry(operation, {
        maxRetries: 1,
        initialDelayMs: 50,
        jitter: true,
      });
      const elapsed = Date.now() - startTime;

      // Should have delayed at least 25ms (50% of 50ms) due to jitter
      expect(elapsed).toBeGreaterThanOrEqual(20);
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should throw the last error after all retries fail', async () => {
      const networkError = new Error('Connection failed');
      const operation = vi.fn().mockRejectedValue(networkError);

      await expect(retry(operation, {
        maxRetries: 1,
        initialDelayMs: 1,
        jitter: false,
      })).rejects.toThrow('Connection failed');
    });

    it('should handle non-Error rejections', async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce('string error')
        .mockResolvedValueOnce('success');

      // Non-Error values are not retryable, so it should fail immediately
      await expect(retry(operation, {
        maxRetries: 1,
        initialDelayMs: 1,
      })).rejects.toThrow('string error');
    });
  });
});

describe('retryAsyncIterable', () => {
  describe('successful operations', () => {
    it('should yield all values on success', async () => {
      async function* operation() {
        yield 1;
        yield 2;
        yield 3;
      }

      const results: number[] = [];
      for await (const value of retryAsyncIterable(operation)) {
        results.push(value);
      }

      expect(results).toEqual([1, 2, 3]);
    });
  });

  describe('retry behavior', () => {
    it('should retry on retryable error', async () => {
      let attempt = 0;
      const networkError = new Error('ETIMEDOUT');

      async function* operation() {
        attempt++;
        if (attempt === 1) {
          throw networkError;
        }
        yield 'success';
      }

      const results: string[] = [];
      for await (const value of retryAsyncIterable(operation, {
        maxRetries: 1,
        initialDelayMs: 1,
        jitter: false,
      })) {
        results.push(value);
      }

      expect(results).toEqual(['success']);
      expect(attempt).toBe(2);
    });

    it('should throw after max retries exhausted', async () => {
      const networkError = new Error('ETIMEDOUT');
      let attempt = 0;

      async function* operation() {
        attempt++;
        throw networkError;
      }

      await expect(async () => {
        for await (const _ of retryAsyncIterable(operation, {
          maxRetries: 2,
          initialDelayMs: 1,
          jitter: false,
        })) {
          // consume iterable
        }
      }).rejects.toThrow('ETIMEDOUT');

      expect(attempt).toBe(3); // initial + 2 retries
    });
  });
});

describe('withRetry', () => {
  it('should wrap function with retry logic', async () => {
    const networkError = new Error('ETIMEDOUT');
    let callCount = 0;

    const operation = async () => {
      await Promise.resolve();
      callCount++;
      if (callCount === 1) {
        throw networkError;
      }
      return 'success';
    };

    const wrappedOperation = withRetry(operation, {
      maxRetries: 1,
      initialDelayMs: 1,
      jitter: false,
    });

    const result = await wrappedOperation();

    expect(result).toBe('success');
    expect(callCount).toBe(2);
  });

  it('should pass arguments to wrapped function', async () => {
    const operation = vi.fn().mockResolvedValue('result');
    const wrappedOperation = withRetry(operation);

    await wrappedOperation('arg1', 'arg2');

    expect(operation).toHaveBeenCalledWith('arg1', 'arg2');
  });

  it('should use default options', async () => {
    const operation = vi.fn().mockResolvedValue('success');
    const wrappedOperation = withRetry(operation);

    const result = await wrappedOperation();

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
