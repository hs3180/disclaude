/**
 * Tests for retry utility (src/utils/retry.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import { retry, retryAsyncIterable, withRetry } from './retry.js';
import { SDKError, AgentExecutionError } from './errors.js';

describe('retry', () => {
  describe('successful operation', () => {
    it('should return result immediately on success', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const result = await retry(operation, { initialDelayMs: 0 });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should not retry on success', async () => {
      const operation = vi.fn().mockResolvedValue('result');
      const onRetry = vi.fn();

      await retry(operation, { onRetry, initialDelayMs: 0 });

      expect(onRetry).not.toHaveBeenCalled();
    });
  });

  describe('retryable errors', () => {
    it('should retry on SDKError with retryable message', async () => {
      const error = new SDKError('timeout occurred', { code: 'TIMEOUT' });
      const operation = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('success');

      const result = await retry(operation, { initialDelayMs: 0 });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should retry on recoverable AgentExecutionError', async () => {
      const error = new AgentExecutionError('Agent failed', { recoverable: true });
      const operation = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('success');

      const result = await retry(operation, { initialDelayMs: 0 });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should call onRetry callback with attempt and error', async () => {
      const error = new SDKError('network error', {});
      const operation = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('success');
      const onRetry = vi.fn();

      await retry(operation, { onRetry, initialDelayMs: 0 });

      expect(onRetry).toHaveBeenCalledWith(1, error);
    });
  });

  describe('non-retryable errors', () => {
    it('should not retry on non-retryable error', async () => {
      const error = new Error('Permanent failure');
      const operation = vi.fn().mockRejectedValue(error);

      await expect(retry(operation, { initialDelayMs: 0 })).rejects.toThrow('Permanent failure');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should not retry on AgentExecutionError with recoverable=false', async () => {
      const error = new AgentExecutionError('Fatal error', { recoverable: false });
      const operation = vi.fn().mockRejectedValue(error);

      await expect(retry(operation, { initialDelayMs: 0 })).rejects.toThrow('Fatal error');
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('max retries', () => {
    it('should exhaust max retries before giving up', async () => {
      const error = new SDKError('timeout', {});
      const operation = vi.fn().mockRejectedValue(error);
      const onRetry = vi.fn();

      await expect(retry(operation, { maxRetries: 2, initialDelayMs: 0, onRetry }))
        .rejects.toThrow('timeout');
      expect(operation).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it('should use default maxRetries of 3', async () => {
      const error = new SDKError('timeout', {});
      const operation = vi.fn().mockRejectedValue(error);
      const onRetry = vi.fn();

      await expect(retry(operation, { initialDelayMs: 0, onRetry }))
        .rejects.toThrow('timeout');
      expect(operation).toHaveBeenCalledTimes(4); // Initial + 3 retries
      expect(onRetry).toHaveBeenCalledTimes(3);
    });
  });

  describe('non-Error objects', () => {
    it('should wrap non-Error throws in Error object', async () => {
      const operation = vi.fn().mockRejectedValue('string error');

      // Non-Error objects are not retryable by default
      await expect(retry(operation, { initialDelayMs: 0 })).rejects.toThrow('string error');
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });
});

describe('retryAsyncIterable', () => {
  describe('successful iteration', () => {
    it('should yield all values from successful operation', async () => {
      async function* operation() {
        yield 'value1';
        yield 'value2';
        yield 'value3';
      }

      const results: string[] = [];
      for await (const value of retryAsyncIterable(operation, { initialDelayMs: 0 })) {
        results.push(value);
      }

      expect(results).toEqual(['value1', 'value2', 'value3']);
    });
  });

  describe('retry on error', () => {
    it('should not retry on non-retryable error', async () => {
      async function* operation() {
        yield 'value';
        throw new Error('Permanent failure');
      }

      const results: string[] = [];
      await expect(async () => {
        for await (const value of retryAsyncIterable(operation, { initialDelayMs: 0 })) {
          results.push(value);
        }
      }).rejects.toThrow('Permanent failure');
    });
  });

  describe('max retries', () => {
    it('should exhaust max retries', async () => {
      let attempts = 0;
      const onRetry = vi.fn();

      async function* operation() {
        attempts++;
        throw new SDKError('timeout', {});
      }

      await expect(async () => {
        for await (const _ of retryAsyncIterable(operation, { maxRetries: 2, initialDelayMs: 0, onRetry })) {
          // Consume iterator
        }
      }).rejects.toThrow('timeout');
      expect(attempts).toBe(3); // Initial + 2 retries
      expect(onRetry).toHaveBeenCalledTimes(2);
    });
  });
});

describe('withRetry', () => {
  it('should wrap function with retry logic', async () => {
    const originalFn = vi.fn()
      .mockRejectedValueOnce(new SDKError('timeout', {}))
      .mockResolvedValueOnce('success');

    const wrappedFn = withRetry(originalFn, { initialDelayMs: 0 });

    const result = await wrappedFn('arg1', 'arg2');
    expect(result).toBe('success');
    expect(originalFn).toHaveBeenCalledWith('arg1', 'arg2');
    expect(originalFn).toHaveBeenCalledTimes(2);
  });

  it('should preserve function arguments', async () => {
    const originalFn = vi.fn().mockResolvedValue('result');
    const wrappedFn = withRetry(originalFn, { initialDelayMs: 0 });

    await wrappedFn('a', 'b', 'c');

    expect(originalFn).toHaveBeenCalledWith('a', 'b', 'c');
  });

  it('should apply default options', async () => {
    const error = new SDKError('timeout', {});
    const originalFn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const wrappedFn = withRetry(originalFn, { maxRetries: 1, initialDelayMs: 0 });

    await wrappedFn();
    expect(originalFn).toHaveBeenCalledTimes(2);
  });
});
