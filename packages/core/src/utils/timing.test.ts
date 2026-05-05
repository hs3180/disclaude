/**
 * Tests for withTiming() utility (Issue #3292).
 *
 * @module utils/timing.test
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { withTiming } from './timing.js';

/** Create a silent logger that captures log entries for assertions. */
function createCaptureLogger() {
  const entries: Array<{ msg?: string; chatId?: string; timing?: string; elapsedMs?: number; ok?: boolean; error?: string }> = [];
  const logger = pino(
    { level: 'info' },
    {
      write: (data: string) => {
        try { entries.push(JSON.parse(data)); } catch { /* ignore */ }
      },
    },
  );
  return { logger, entries };
}

describe('withTiming', () => {
  it('should log start and success when fn resolves', async () => {
    const { logger, entries } = createCaptureLogger();
    const result = await withTiming(logger, 'test-op', 'chat-123', () => Promise.resolve('hello'));

    expect(result).toBe('hello');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ chatId: 'chat-123', timing: 'test-op', elapsedMs: 0 });
    expect(entries[1]).toMatchObject({ chatId: 'chat-123', timing: 'test-op', ok: true });
    expect(entries[1]!.elapsedMs!).toBeGreaterThanOrEqual(0);
  });

  it('should log start and failure when fn rejects', async () => {
    const { logger, entries } = createCaptureLogger();
    await expect(
      withTiming(logger, 'failing-op', undefined, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ timing: 'failing-op', elapsedMs: 0 });
    expect(entries[1]).toMatchObject({ timing: 'failing-op', ok: false, error: 'boom' });
  });

  it('should handle non-Error rejections', async () => {
    const { logger, entries } = createCaptureLogger();
    await expect(
      withTiming(logger, 'non-error', undefined, () => Promise.reject('string-error')),
    ).rejects.toBe('string-error');

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ ok: false, error: 'string-error' });
  });

  it('should work with undefined chatId', async () => {
    const { logger, entries } = createCaptureLogger();
    await withTiming(logger, 'no-chat', undefined, async () => {
      await Promise.resolve(42);
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]!.timing).toBe('no-chat');
  });

  it('should measure actual elapsed time', async () => {
    const { logger, entries } = createCaptureLogger();
    await withTiming(logger, 'slow-op', undefined, async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(entries).toHaveLength(2);
    expect(entries[1]!.elapsedMs!).toBeGreaterThanOrEqual(40);
  });
});
