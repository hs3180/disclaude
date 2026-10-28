import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from '@disclaude/core';
import type { WeChatUpdate } from './types.js';
import { WeChatMediaInbox, type MediaInboxEntry } from './media-inbox.js';
import { WeChatMediaError } from './media-error.js';

const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@disclaude/core', () => ({ createLogger: () => logger }));
const owned: Array<{ abort: AbortController; worker: Promise<void> }> = [];
afterEach(async () => { for (const r of owned.splice(0)) { r.abort.abort(); await r.worker; } vi.useRealTimers(); vi.clearAllMocks(); });
const update: WeChatUpdate = { message_id: 'image', from_user_id: 'peer', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'private-ref', aes_key: 'private-key' } } }] };
const message: IncomingMessage = { messageId: 'image', chatId: 'peer', userId: 'peer', messageType: 'image', content: '[Image received]', timestamp: 1,
  attachments: [{ fileName: 'image.png', filePath: '/fixture/image.png' }] };

function fixture(resolve = vi.fn().mockResolvedValue(message), accept = vi.fn().mockResolvedValue(undefined), restored: MediaInboxEntry[] = []) {
  let saved: MediaInboxEntry[] = [], failWrite = false;
  const persist = vi.fn(() => { if (failWrite) { throw new Error('disk unavailable'); } saved = inbox.snapshot(); return Promise.resolve(); });
  const inbox = new WeChatMediaInbox(restored, persist, resolve, accept);
  const abort = new AbortController(), worker = inbox.run(abort.signal);
  owned.push({ abort, worker });
  return { inbox, resolve, accept, abort, worker, persist, saved: () => saved, failWrites: (value: boolean) => { failWrite = value; } };
}

describe('durable WeChat media worker', () => {
  it.each([false, true])('commits a confirmed receipt during drain but not after ownership expires (expired=%s)', async expired => {
    vi.useFakeTimers();
    let release!: () => void;
    const acknowledged = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(vi.fn().mockResolvedValue(message), vi.fn(() => acknowledged));
    try {
      await f.inbox.enqueue(update); await vi.advanceTimersByTimeAsync(0);
      expect(f.saved()[0].state).toBe('dispatching');
      f.abort.abort();
      if (expired) { f.inbox.invalidate(); }
      release(); await f.worker;
      expect(f.saved()).toEqual(expired ? [expect.objectContaining({ state: 'dispatching' })] : []);
      expect(f.accept).toHaveBeenCalledOnce();
    } finally { release(); }
  });

  it('does not start an uncommitted job, and a repeated update can repair its checkpoint', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.failWrites(true);
    await expect(f.inbox.enqueue(update)).rejects.toThrow('disk unavailable');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.resolve).not.toHaveBeenCalled();
    f.failWrites(false); await f.inbox.enqueue(update); await vi.advanceTimersByTimeAsync(0);
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.accept).toHaveBeenCalledOnce();
    expect(f.saved()).toEqual([]);
  });

  it('retries three failed downloads then sends one distinct failure notice without accepting a placeholder task', async () => {
    vi.useFakeTimers();
    const error = new WeChatMediaError({ stage: 'fetch', reason: 'network', elapsedMs: 1 }, { code: 'ECONNRESET' });
    const f = fixture(vi.fn().mockRejectedValue(error));
    await f.inbox.enqueue(update); await vi.advanceTimersByTimeAsync(0);
    expect(f.saved()[0]).toMatchObject({ failures: 1, state: 'pending' });
    await vi.advanceTimersByTimeAsync(5_000); expect(f.resolve).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000); expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.accept).toHaveBeenCalledOnce();
    expect(f.accept.mock.calls[0][0]).toMatchObject({ messageId: expect.stringMatching(/^media-failure:/),
      metadata: { attachmentRecovery: { originalMessageId: 'image', state: 'failed' } } });
    expect(f.saved()[0]).toMatchObject({ state: 'failed', reported: true });
    await f.inbox.enqueue(update); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.resolve).toHaveBeenCalledTimes(3); expect(f.accept).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/private-ref|private-key/);
  });

  it('does not retry a nonretryable HTTP verdict, and expires private records', async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn().mockRejectedValue(new WeChatMediaError({ stage: 'fetch', reason: 'http', elapsedMs: 1, httpStatus: 403 })));
    await f.inbox.enqueue(update); await vi.advanceTimersByTimeAsync(0);
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.saved()[0].state).toBe('failed');
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(f.saved()).toEqual([]); expect(f.accept).toHaveBeenCalledOnce();
  });

  it('holds an uncertain admission after restart instead of replaying the original task', async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn().mockResolvedValue(message), vi.fn().mockRejectedValue(new Error('acceptance unknown')));
    await f.inbox.enqueue(update); await vi.advanceTimersByTimeAsync(0);
    expect(f.accept).toHaveBeenCalledOnce(); expect(f.saved()[0].state).toBe('uncertain');
    const restored = fixture(vi.fn(), vi.fn(), f.saved());
    await vi.advanceTimersByTimeAsync(0);
    expect(restored.resolve).not.toHaveBeenCalled(); expect(restored.accept).not.toHaveBeenCalled();
    expect(restored.inbox.snapshot()[0].state).toBe('uncertain');
  });

  it('treats a persisted dispatch intent without a receipt as uncertain', async () => {
    vi.useFakeTimers();
    const row: MediaInboxEntry = { id: 'image', recoveryId: 'owned-recovery', update, state: 'dispatching', failures: 0, nextAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const f = fixture(vi.fn(), vi.fn(), [row]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.inbox.snapshot()[0]).toMatchObject({ state: 'uncertain', reported: true });
    expect(f.accept).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
  });

  it('keeps all admitted jobs when the queue refuses overflow', async () => {
    const f = fixture(); f.abort.abort(); await f.worker;
    for (let i = 0; i < 64; i++) { await f.inbox.enqueue({ ...update, message_id: `image-${i}` }); }
    await expect(f.inbox.enqueue({ ...update, message_id: 'overflow' })).rejects.toThrow('queue is full');
    expect(f.inbox.snapshot()).toHaveLength(64);
  });
});
