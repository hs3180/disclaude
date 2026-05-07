/**
 * Tests for timing utility (packages/core/src/utils/timing.ts)
 *
 * Covers:
 * - withTiming: success path logs start (debug) + end (info)
 * - withTiming: failure path logs start (debug) + error (info) and re-throws
 * - withTiming: return value is passed through
 * - withTiming: chatId is included in log entries
 * - withTiming: elapsedMs is positive for slow operations
 *
 * @see Issue #3292
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withTiming } from './timing.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import('pino').Logger;
}

describe('withTiming', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return the result of the wrapped function', async () => {
    const result = await withTiming(logger, 'test:op', 'chat_123', () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('should log start (debug) and success (info) for successful operations', async () => {
    await withTiming(logger, 'test:op', 'chat_123', () => Promise.resolve('ok'));

    // Start log at debug level
    expect(logger.debug).toHaveBeenCalledWith(
      { chatId: 'chat_123', timing: 'test:op', elapsedMs: 0 },
    );

    // Success log at info level
    expect(logger.info).toHaveBeenCalledWith(
      { chatId: 'chat_123', timing: 'test:op', elapsedMs: expect.any(Number), ok: true },
    );
  });

  it('should log start (debug) and failure (info) for failed operations and re-throw', async () => {
    const error = new Error('boom');

    await expect(
      withTiming(logger, 'test:fail', undefined, () => Promise.reject(error)),
    ).rejects.toThrow('boom');

    // Start log at debug level
    expect(logger.debug).toHaveBeenCalledWith(
      { chatId: undefined, timing: 'test:fail', elapsedMs: 0 },
    );

    // Failure log at info level with error message
    expect(logger.info).toHaveBeenCalledWith(
      { chatId: undefined, timing: 'test:fail', elapsedMs: expect.any(Number), ok: false, error: 'boom' },
    );
  });

  it('should handle undefined chatId', async () => {
    await withTiming(logger, 'test:noChat', undefined, () => Promise.resolve(null));

    expect(logger.debug).toHaveBeenCalledWith(
      { chatId: undefined, timing: 'test:noChat', elapsedMs: 0 },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { chatId: undefined, timing: 'test:noChat', elapsedMs: expect.any(Number), ok: true },
    );
  });

  it('should report positive elapsedMs for slow operations', async () => {
    await withTiming(logger, 'test:slow', 'chat_1', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    const successCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(successCall.elapsedMs).toBeGreaterThanOrEqual(40); // Allow some tolerance
    expect(successCall.ok).toBe(true);
  });
});
