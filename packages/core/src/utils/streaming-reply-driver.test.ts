/**
 * Unit tests for StreamingReplyDriver (Issue #4399 / #4208 P2-b).
 *
 * The driver is verified entirely via mock callbacks — no live SDK / channel
 * required. The key invariant under test is the reply-never-lost guarantee:
 * whatever streaming does, the user-visible reply is delivered (stream or
 * sendMessage fallback).
 *
 * Mocks return promises via Promise.resolve/reject (not `async () => …`) so
 * they stay eslint `require-await`-clean.
 */

import { describe, it, expect, vi } from 'vitest';
import { StreamingReplyDriver } from './streaming-reply-driver.js';

function makeCallbacks(overrides: Partial<{
  startStreaming: ReturnType<typeof vi.fn>;
  streamText: ReturnType<typeof vi.fn>;
  finalizeStreaming: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}> = {}) {
  const startStreaming = overrides.startStreaming ?? vi.fn(() => Promise.resolve('card-1'));
  const streamText = overrides.streamText ?? vi.fn(() => Promise.resolve());
  const finalizeStreaming = overrides.finalizeStreaming ?? vi.fn(() => Promise.resolve());
  const sendMessage = overrides.sendMessage ?? vi.fn(() => Promise.resolve());
  return { startStreaming, streamText, finalizeStreaming, sendMessage };
}

function makeDriver(
  cb: ReturnType<typeof makeCallbacks>,
  opts: Partial<{ chatId: string; parentMessageId: string; minIntervalMs: number }> = {},
) {
  return new StreamingReplyDriver({
    chatId: opts.chatId ?? 'oc_test',
    parentMessageId: opts.parentMessageId,
    startStreaming: cb.startStreaming,
    streamText: cb.streamText,
    finalizeStreaming: cb.finalizeStreaming,
    sendMessage: cb.sendMessage,
    // Large window so the 2nd rapid pushText is guaranteed trailing (not
    // emitted) — lets us assert finish() is what flushes the full buffer.
    minIntervalMs: opts.minIntervalMs ?? 1000,
  });
}

describe('StreamingReplyDriver — degrade path (reply never lost)', () => {
  it('degrades to sendMessage when startStreaming returns null', async () => {
    const cb = makeCallbacks({ startStreaming: vi.fn(() => Promise.resolve(null)) });
    const driver = makeDriver(cb);

    await driver.pushText('hello', 'om_root');
    expect(driver.isDegraded).toBe(true);
    expect(driver.isStreaming).toBe(false);
    // First chunk delivered via the fallback, NOT streamed.
    expect(cb.sendMessage).toHaveBeenCalledWith('oc_test', 'hello', 'om_root');
    expect(cb.streamText).not.toHaveBeenCalled();

    await driver.pushText('world', 'om_root');
    // Sticky degrade: every subsequent chunk also via sendMessage.
    expect(cb.sendMessage).toHaveBeenLastCalledWith('oc_test', 'world', 'om_root');
    expect(cb.streamText).not.toHaveBeenCalled();

    await driver.finish('om_root');
    // Degraded turns never touch the streaming callbacks.
    expect(cb.finalizeStreaming).not.toHaveBeenCalled();
  });

  it('degrades to sendMessage when startStreaming throws', async () => {
    const cb = makeCallbacks({
      startStreaming: vi.fn(() => Promise.reject(new Error('boom'))),
    });
    const driver = makeDriver(cb);

    await driver.pushText('hello');
    expect(driver.isDegraded).toBe(true);
    expect(cb.sendMessage).toHaveBeenCalledWith('oc_test', 'hello', undefined);
    expect(cb.streamText).not.toHaveBeenCalled();
  });
});

describe('StreamingReplyDriver — streaming path', () => {
  it('starts streaming on first pushText and passes chatId + parentMessageId', async () => {
    const cb = makeCallbacks();
    const driver = makeDriver(cb, { parentMessageId: 'om_root' });

    await driver.pushText('hello');
    expect(driver.isStreaming).toBe(true);
    expect(cb.startStreaming).toHaveBeenCalledTimes(1);
    expect(cb.startStreaming).toHaveBeenCalledWith('oc_test', 'om_root');
    // Leading PATCH emitted immediately with the chunk.
    expect(cb.streamText).toHaveBeenCalledWith('card-1', 'hello');
    await driver.finish();
  });

  it('accumulates multi-chunk text and flushes the full buffer on finish', async () => {
    const cb = makeCallbacks();
    const driver = makeDriver(cb);

    await driver.pushText('a');
    await driver.pushText('b');
    await driver.pushText('c');

    // Only the leading emission of the first chunk fired; the rest are trailing
    // (coalesced within the minIntervalMs window) and not yet emitted.
    expect(cb.streamText).toHaveBeenCalledTimes(1);
    expect(cb.streamText).toHaveBeenCalledWith('card-1', 'a');

    await driver.finish();

    // finish() does a direct (awaited) final PATCH with the FULL accumulated
    // buffer, then freezes the card.
    expect(cb.streamText).toHaveBeenLastCalledWith('card-1', 'a\nb\nc');
    expect(cb.finalizeStreaming).toHaveBeenCalledTimes(1);
    expect(cb.finalizeStreaming).toHaveBeenCalledWith('card-1');
  });

  it('re-delivers the full reply via sendMessage if the final flush throws', async () => {
    // streamText rejects on every call (card PATCH permanently broken).
    const cb = makeCallbacks({
      streamText: vi.fn(() => Promise.reject(new Error('patch-fail'))),
    });
    const driver = makeDriver(cb);

    await driver.pushText('a');
    await driver.pushText('b');
    await driver.finish('om_root');

    // Final-delivery guarantee: the complete buffer reached the user via
    // sendMessage even though streaming was broken.
    expect(cb.sendMessage).toHaveBeenCalledWith('oc_test', 'a\nb', 'om_root');
    // finalizeStreaming was skipped because the flush threw before it.
    expect(cb.finalizeStreaming).not.toHaveBeenCalled();
  });

  it('swallows a mid-stream streamText rejection without an unhandled rejection', async () => {
    // The leading PATCH rejects once, then resolves (so the finish flush works).
    const cb = makeCallbacks({
      streamText: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue(undefined),
    });
    const driver = makeDriver(cb);

    // Should not throw despite the rejected leading PATCH (throttle voids emitFn;
    // the driver's closure owns the error).
    await driver.pushText('a');
    await driver.finish();

    // The finish flush (2nd call) resolved, so finalize ran.
    expect(cb.finalizeStreaming).toHaveBeenCalledWith('card-1');
  });

  it('finish() drains in-flight PATCHes before the final flush (no overtake race)', async () => {
    // Regression for the #4438 review's Low finding: a slow earlier
    // fire-and-forget PATCH must settle before the direct final flush, so it
    // can't land after — and overwrite — the final content. The leading PATCH
    // is made slow & controllable via a deferred.
    let resolveLeading: () => void = () => {};
    const log: string[] = [];
    const cb = makeCallbacks({
      streamText: vi.fn((_id: string, text: string) => {
        log.push(text);
        if (text === 'a') {
          return new Promise<void>((resolve) => {
            resolveLeading = resolve;
          });
        }
        return Promise.resolve();
      }),
    });
    const driver = makeDriver(cb);

    await driver.pushText('a'); // leading PATCH in flight (pending)
    await driver.pushText('b'); // trailing, coalesced within the window

    let finished = false;
    const finishPromise = driver.finish().then(() => {
      finished = true;
    });

    // Let microtasks settle. finish() is blocked in throttle.drain() awaiting
    // the leading PATCH, so the final flush must NOT have been issued yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(log).toEqual(['a']); // only the leading PATCH so far

    resolveLeading(); // leading PATCH settles → drain() completes → final flush
    await finishPromise;

    // Final flush carries the full buffer and was issued AFTER the leading
    // PATCH settled — the slow emission can no longer overtake the final one.
    expect(log).toEqual(['a', 'a\nb']);
    expect(cb.finalizeStreaming).toHaveBeenCalledWith('card-1');
  });
});

describe('StreamingReplyDriver — finish semantics', () => {
  it('is a no-op when streaming never started (no pushText)', async () => {
    const cb = makeCallbacks();
    const driver = makeDriver(cb);
    await driver.finish();
    expect(cb.finalizeStreaming).not.toHaveBeenCalled();
    expect(cb.streamText).not.toHaveBeenCalled();
    expect(cb.sendMessage).not.toHaveBeenCalled();
  });

  it('is idempotent — double finish finalizes only once', async () => {
    const cb = makeCallbacks();
    const driver = makeDriver(cb);
    await driver.pushText('hello');
    await driver.finish();
    await driver.finish(); // second call must be a no-op
    expect(cb.finalizeStreaming).toHaveBeenCalledTimes(1);
  });

  it('does not re-call startStreaming on every pushText (once per turn)', async () => {
    const cb = makeCallbacks();
    const driver = makeDriver(cb);
    await driver.pushText('a');
    await driver.pushText('b');
    await driver.pushText('c');
    expect(cb.startStreaming).toHaveBeenCalledTimes(1);
    await driver.finish();
  });

  it('swallows a sendMessage fallback failure (never masks the turn error)', async () => {
    const cb = makeCallbacks({
      startStreaming: vi.fn(() => Promise.resolve(null)),
      sendMessage: vi.fn(() => Promise.reject(new Error('send-fail'))),
    });
    const driver = makeDriver(cb);
    // Must not throw even though the fallback itself failed.
    await expect(driver.pushText('hello')).resolves.toBe(true);
    await expect(driver.finish()).resolves.toBeUndefined();
  });
});
