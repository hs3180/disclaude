import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from '@disclaude/core';
import { WeChatMessageListener, type WeChatListenerState } from './message-listener.js';
import { WeChatStateStore, type WeChatSessionState } from './state-store.js';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate } from './types.js';
import { WeChatMediaError } from './media-error.js';

const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@disclaude/core', () => ({ createLogger: () => logger }));
const owned: WeChatMessageListener[] = [], dirs: string[] = [];
afterEach(async () => { for (const l of owned.splice(0)) { await l.stop(); } for (const d of dirs.splice(0)) { await fs.rm(d, { recursive: true, force: true }); } vi.restoreAllMocks(); });
const image: WeChatUpdate = { message_id: 'image', from_user_id: 'peer', context_token: 'old-context', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'private-ref', aes_key: 'private-key' } } }] };
const text: WeChatUpdate = { message_id: 'text', from_user_id: 'peer', context_token: 'new-context', item_list: [{ type: 1, text_item: { text: 'later instruction' } }] };

async function fixture(batch: WeChatUpdate[], resolve: (item: unknown, signal?: AbortSignal) => Promise<NonNullable<IncomingMessage['attachments']>[number]>, state?: WeChatSessionState, directory?: string) {
  const dir = directory ?? await fs.mkdtemp(join(tmpdir(), 'wechat-inbox-integration-'));
  if (!directory) { dirs.push(dir); }
  const store = new WeChatStateStore(dir);
  let cursor = state?.cursor ?? 'before';
  let snapshot: WeChatListenerState | undefined;
  const acknowledgements: Array<WeChatListenerState | undefined> = [];
  const contexts = new Map(Object.entries(state?.contexts ?? {}));
  const client = {
    setUpdatesCursor: (value: string) => { cursor = value; }, getUpdatesCursor: () => cursor,
    acknowledgeUpdates: () => { acknowledgements.push(structuredClone(snapshot)); cursor = 'after'; },
    getUpdates: vi.fn().mockResolvedValueOnce(batch).mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal.aborted) { abort(); } else { signal.addEventListener('abort', abort, { once: true }); }
    })),
  };
  const processor = vi.fn().mockResolvedValue(undefined);
  const checkpoint = vi.fn(async (value: WeChatListenerState) => {
    await store.saveSession({ ...value, botId: 'bot', contexts: Object.fromEntries(contexts) }); snapshot = value;
  });
  const listener = new WeChatMessageListener(client as unknown as WeChatApiClient, processor, {
    state, checkpoint, resolveAttachment: resolve, onContext: (peer, token) => contexts.set(peer, token),
  });
  owned.push(listener);
  return { dir, store, listener, processor, client, checkpoint, contexts, acknowledgements };
}

describe('media reception through the real listener and private account checkpoint', () => {
  it('serializes worker and poll snapshots so a delayed old write cannot overwrite newer state', async () => {
    let releaseDownload!: (value: { fileName: string; filePath: string }) => void;
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    const f = await fixture([image, text], (_item, signal) => new Promise((resolve, reject) => {
      releaseDownload = resolve; signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const path = join(f.dir, 'serialized.png'); await fs.writeFile(path, 'fixture');
    const original = f.checkpoint.getMockImplementation();
    if (!original) { throw new Error('Missing checkpoint fixture'); }
    let writes = 0;
    f.checkpoint.mockImplementation(async state => { if (++writes === 2) { await blockedWrite; } await original(state); });
    try {
      f.listener.start(); await vi.waitFor(() => expect(writes).toBe(2));
      releaseDownload({ fileName: 'serialized.png', filePath: path });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(writes).toBe(2);
      releaseWrite();
      await vi.waitFor(async () => {
        const saved = await f.store.loadSession('bot');
        expect(saved.cursor).toBe('after'); expect(saved.seenMessageIds).toEqual(expect.arrayContaining(['image', 'text']));
        expect(saved.mediaInbox).toBeUndefined();
      });
    } finally { releaseWrite(); }
  });

  it('persists before ACK and processes later messages/polls while the media download is still waiting', async () => {
    let release!: (value: { fileName: string; filePath: string }) => void;
    const f = await fixture([image, { ...text, from_user_id: 'other-peer' }], (_item, signal) => new Promise((resolve, reject) => {
      release = resolve; signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const path = join(f.dir, 'image.png'); await fs.writeFile(path, 'fixture image');
    f.listener.start();
    await vi.waitFor(() => { expect(f.processor).toHaveBeenCalledOnce(); expect(f.client.getUpdates).toHaveBeenCalledTimes(2); });
    expect(f.processor.mock.calls[0][0].messageId).toBe('text');
    expect(f.acknowledgements[0]?.mediaInbox?.[0].id).toBe('image');
    const during = await f.store.loadSession('bot');
    expect(during.cursor).toBe('after'); expect(during.seenMessageIds).toEqual(['text']);
    expect(during.mediaInbox?.[0].state).toBe('pending');
    release({ fileName: 'image.png', filePath: path });
    await vi.waitFor(() => expect(f.processor).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox).toBeUndefined());
    expect(f.processor.mock.calls[1][0]).toMatchObject({ messageId: 'image', attachments: [{ filePath: path }], metadata: { attachmentRecovery: { state: 'completed' } } });
    expect(f.processor.mock.calls[1][0].content).toContain('Later user instructions take precedence');
    expect((await fs.stat(join(f.dir, 'session.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(f.dir)).mode & 0o777).toBe(0o700);
  });

  it('restores a failed download without replaying text or rolling back a newer reply context', async () => {
    const f = await fixture([image, text], () => Promise.reject(new WeChatMediaError({ stage: 'fetch', reason: 'network', elapsedMs: 1 })));
    f.listener.start();
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox?.[0].failures).toBe(1));
    await f.listener.stop();
    const saved = await f.store.loadSession('bot');
    expect(saved.seenMessageIds).toEqual(['text']); expect(saved.contexts.peer).toBe('new-context');
    const realNow = Date.now.bind(Date); const offset = Math.max(0, saved.mediaInbox![0].nextAt - realNow() + 1);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const path = join(f.dir, 'recovered.png'); await fs.writeFile(path, 'recovered');
    const resolve = vi.fn().mockResolvedValue({ fileName: 'recovered.png', filePath: path });
    const restored = await fixture([image, text], resolve, saved, f.dir);
    restored.listener.start();
    await vi.waitFor(() => expect(restored.processor).toHaveBeenCalledOnce());
    expect(restored.processor.mock.calls[0][0].messageId).toBe('image');
    expect(resolve).toHaveBeenCalledOnce(); expect(restored.contexts.get('peer')).toBe('new-context');
    await vi.waitFor(async () => expect((await restored.store.loadSession('bot')).mediaInbox).toBeUndefined());
    expect((await f.store.loadSession('another-account')).mediaInbox).toBeUndefined();
  });

  it('does not ACK or start downloads when the private checkpoint fails', async () => {
    const resolve = vi.fn();
    const f = await fixture([image], resolve);
    f.checkpoint.mockRejectedValue(new Error('private disk failure'));
    f.listener.start();
    await vi.waitFor(() => expect(f.checkpoint).toHaveBeenCalled());
    expect(f.acknowledgements).toEqual([]); expect(resolve).not.toHaveBeenCalled(); expect(f.processor).not.toHaveBeenCalled();
  });

  it('keeps an uncompleted media job on cancellation and never admits a late result', async () => {
    let started = false;
    const f = await fixture([image], (_item, signal) => new Promise((_, reject) => {
      started = true; signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    f.listener.start(); await vi.waitFor(() => expect(started).toBe(true));
    await f.listener.stop();
    const saved = await f.store.loadSession('bot');
    expect(saved.mediaInbox?.[0]).toMatchObject({ state: 'pending', failures: 0 });
    expect(f.processor).not.toHaveBeenCalled();
  });

  it('does not hand off a partial multi-attachment message', async () => {
    const partial = { ...image, item_list: [image.item_list![0], image.item_list![0]] };
    const f = await fixture([partial, text], vi.fn().mockResolvedValueOnce({ fileName: 'one.png', filePath: '/fixture/one.png' })
      .mockRejectedValue(new WeChatMediaError({ stage: 'fetch', reason: 'network', elapsedMs: 1 })));
    f.listener.start();
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox?.[0].failures).toBe(1));
    expect(f.processor).toHaveBeenCalledOnce(); expect(f.processor.mock.calls[0][0].messageId).toBe('text');
  });
});
