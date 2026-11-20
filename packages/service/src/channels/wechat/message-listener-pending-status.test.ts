import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from '@disclaude/core';
import { WeChatMessageListener, type WeChatListenerOptions, type MessageProcessor } from './message-listener.js';
import { WeChatStateStore } from './state-store.js';
import { WeChatMediaError } from './media-error.js';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate } from './types.js';

const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@disclaude/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@disclaude/core')>()),
  createLogger: () => logger,
}));
const owned: WeChatMessageListener[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const l of owned.splice(0)) { await l.stop(); }
  for (const d of dirs.splice(0)) { await fs.rm(d, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

const imageA: WeChatUpdate = { message_id: 'image-a', from_user_id: 'peer-a',
  item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'private-ref', aes_key: 'private-key' } } }] };
const textA: WeChatUpdate = { message_id: 'text-a', from_user_id: 'peer-a', item_list: [{ type: 1, text_item: { text: 'compare with the photo I sent' } }] };
const textA2: WeChatUpdate = { message_id: 'text-a2', from_user_id: 'peer-a', item_list: [{ type: 1, text_item: { text: 'second instruction wins' } }] };
const textB: WeChatUpdate = { message_id: 'text-b', from_user_id: 'peer-b', item_list: [{ type: 1, text_item: { text: 'unrelated question' } }] };
const imageB: WeChatUpdate = { message_id: 'image-b', from_user_id: 'peer-a', create_time: 1_732_128_000,
  item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'private-ref-b', aes_key: 'private-key-b' } } }] };
const imageC: WeChatUpdate = { message_id: 'image-c', from_user_id: 'peer-b',
  item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'private-ref-c', aes_key: 'private-key-c' } } }] };

/** Real listener wiring: controllable resolver, real private account store, recorded processor. */
async function fixture(batches: WeChatUpdate[][], resolve: NonNullable<WeChatListenerOptions['resolveAttachment']>,
  processor: MessageProcessor = vi.fn().mockResolvedValue(undefined)) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-pending-status-'));
  dirs.push(dir);
  const store = new WeChatStateStore(dir);
  let cursor = 'before';
  const client = {
    setUpdatesCursor: (value: string) => { cursor = value; }, getUpdatesCursor: () => cursor,
    acknowledgeUpdates: () => { cursor = 'after'; },
    getUpdates: vi.fn().mockImplementation(({ signal }: { signal: AbortSignal }) => {
      const batch = batches.shift();
      if (batch) { return Promise.resolve(batch); }
      return new Promise<WeChatUpdate[]>((_, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) { abort(); } else { signal.addEventListener('abort', abort, { once: true }); }
      });
    }),
  };
  const listener = new WeChatMessageListener(client as unknown as WeChatApiClient, processor, {
    checkpoint: async value => { await store.saveSession({ ...value, botId: 'bot', contexts: {} }); },
    resolveAttachment: resolve,
  });
  owned.push(listener);
  return { store, listener, processor };
}

/** A download that never finishes on its own; rejects with the abort signal like a real fetch. */
const hangingDownload = (): NonNullable<WeChatListenerOptions['resolveAttachment']> =>
  (_item, signal) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
  });

describe('text turns see same-peer queued media status (#5754)', () => {
  it('appends one bounded status note while the peer image is still queued (download waiting)', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    const f = await fixture([[imageA, textA]], hangingDownload(), processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledOnce());
    const delivered = processor.mock.calls[0]!.at(0) as IncomingMessage;
    expect(delivered.messageId).toBe('text-a');
    expect(delivered.content.startsWith('compare with the photo I sent\n[系统注记: 此前发送的 1 条图片/文件消息仍在处理中')).toBe(true);
    expect(delivered.content.endsWith('暂无法读取;无需重新发送]')).toBe(true);
    expect(delivered.content.split('\n')).toHaveLength(2);
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox?.[0].state).toBe('pending'));
  });

  it('appends the note while a downloaded image is dispatching to the peer', async () => {
    let releaseDispatch!: () => void;
    const gate = new Promise<void>(resolve => { releaseDispatch = resolve; });
    const processor = vi.fn((message: IncomingMessage) =>
      message.messageId === 'image-a' ? gate.then(() => undefined) : Promise.resolve());
    const resolve = vi.fn().mockResolvedValue({ fileName: 'image-a.png', filePath: join(tmpdir(), 'image-a.png') });
    const f = await fixture([[imageA], [textA]], resolve, processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor.mock.calls.some(call => (call[0] as IncomingMessage).messageId === 'image-a')).toBe(true));
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox?.[0].state).toBe('dispatching'));
    // The gated accept keeps the entry alive, so the text turn must carry the note
    // whether it lands while the entry is still pending or already dispatching.
    await vi.waitFor(() => {
      const text = processor.mock.calls.map(call => call[0] as IncomingMessage).find(m => m.messageId === 'text-a');
      expect(text).toBeTruthy();
      expect(text!.content).toContain('[系统注记: 此前发送的 1 条图片/文件消息仍在处理中');
    });
    releaseDispatch();
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox).toBeUndefined());
  });

  it('leaves text content byte-identical when nothing is queued for the peer', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn();
    const f = await fixture([[textB]], resolve, processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledOnce());
    expect(processor.mock.calls[0][0]).toMatchObject({ messageId: 'text-b', content: 'unrelated question' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps peer-a queued-media status out of peer-b turns (cross-sender isolation)', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    const f = await fixture([[imageA, textA, textB]], hangingDownload(), processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2));
    const [aTurn, bTurn] = processor.mock.calls.map(call => call[0] as IncomingMessage);
    expect(aTurn.messageId).toBe('text-a');
    expect(aTurn.content).toContain('[系统注记:');
    expect(bTurn.messageId).toBe('text-b');
    expect(bTurn.content).toBe('unrelated question');
  });

  it('resumes the queued comparison text inside the single recovery turn once media arrives (#5754)', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    let releaseDownload!: () => void;
    const gate = new Promise<void>(resolve => { releaseDownload = resolve; });
    const resolve = vi.fn().mockImplementation(() =>
      gate.then(() => ({ fileName: 'image-a.png', filePath: join(tmpdir(), 'image-a.png') })));
    const f = await fixture([[imageA, textA]], resolve, processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledOnce()); // text turn with the status note
    releaseDownload();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2));
    const resumed = processor.mock.calls[1][0] as IncomingMessage;
    expect(resumed.messageId).toBe('image-a');
    expect(resumed.content).toContain('[系统注记: 此前发送的附件已就绪');
    expect(resumed.content).toContain('compare with the photo I sent');
    expect(resumed.metadata?.attachmentRecovery).toMatchObject({ state: 'completed', resumedRequest: true, resumedFromMessageId: 'text-a' });
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox).toBeUndefined());
  });

  it('replays only the latest queued text (last-wins), never both (#5754)', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    let releaseDownload!: () => void;
    const gate = new Promise<void>(resolve => { releaseDownload = resolve; });
    const resolve = vi.fn().mockImplementation(() =>
      gate.then(() => ({ fileName: 'image-a.png', filePath: join(tmpdir(), 'image-a.png') })));
    const f = await fixture([[imageA, textA, textA2]], resolve, processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2)); // both text turns, image still queued
    releaseDownload();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(3));
    const resumed = processor.mock.calls[2][0] as IncomingMessage;
    expect(resumed.messageId).toBe('image-a');
    expect(resumed.content).toContain('second instruction wins');
    expect(resumed.content).not.toContain('compare with the photo');
  });
});

describe('five-state replay and boundaries (#5754)', () => {
  /** Downloads gated per image by its private CDN reference; no gate match rejects loudly. */
  const gatedDownloads = (gates: Record<string, Promise<void>>): NonNullable<WeChatListenerOptions['resolveAttachment']> =>
    (item) => {
      const reference = item.type === 2 ? item.image_item.media?.encrypt_query_param : undefined;
      const gate = (reference !== undefined ? gates[reference] : undefined) ?? Promise.reject(new Error('unexpected media item'));
      return gate.then(() => ({ fileName: 'image.png', filePath: join(tmpdir(), 'image.png') }));
    };

  it('delivers both images readable and resumes only the latest comparison text (both-readable full chain)', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    let releaseA!: () => void; let releaseB!: () => void;
    const resolve = gatedDownloads({
      'private-ref': new Promise<void>(r => { releaseA = r; }),
      'private-ref-b': new Promise<void>(r => { releaseB = r; }),
    });
    const f = await fixture([[imageA], [textA], [imageB, textA2]], resolve, processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2)); // both text turns, both images queued
    const [firstText, secondText] = processor.mock.calls.map(call => call[0] as IncomingMessage);
    expect(firstText).toMatchObject({ messageId: 'text-a' });
    expect(firstText.content).toContain('1 条图片/文件消息仍在处理中');
    expect(secondText).toMatchObject({ messageId: 'text-a2' });
    expect(secondText.content).toContain('2 条图片/文件消息仍在处理中');
    releaseA(); releaseB();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(4));
    const turns = processor.mock.calls.map(call => call[0] as IncomingMessage);
    const aTurn = turns.find(m => m.messageId === 'image-a')!;
    const bTurn = turns.find(m => m.messageId === 'image-b')!;
    expect(aTurn.content).toContain('Attachments from an earlier message'); // slot moved on with the newer text
    expect(aTurn.metadata?.attachmentRecovery).not.toHaveProperty('resumedRequest');
    expect(bTurn.content).toContain('附件已就绪');
    expect(bTurn.content).toContain('second instruction wins');
    expect(bTurn.content).not.toContain('compare with the photo');
    expect(bTurn.metadata?.attachmentRecovery).toMatchObject({ state: 'completed', resumedRequest: true, resumedFromMessageId: 'text-a2' });
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox).toBeUndefined());
  });

  it('names the undelivered image when recovery permanently fails and never replays the queued text', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    let failNow!: () => void;
    const gate = new Promise<void>(r => { failNow = r; });
    const resolve: NonNullable<WeChatListenerOptions['resolveAttachment']> = () =>
      gate.then(() => { throw new WeChatMediaError({ stage: 'fetch', reason: 'http', elapsedMs: 1, httpStatus: 403 }); });
    const f = await fixture([[imageB, textA]], resolve, processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledOnce()); // noted text turn while the download hangs
    failNow();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2)); // one terminal failure notice
    const failure = processor.mock.calls[1][0] as IncomingMessage;
    expect(failure.messageId).toMatch(/^media-failure:/);
    expect(failure.content).toContain('Attachment processing failed');
    expect(failure.content).toContain('第 1 张图片(消息时间 2024-11-20T18:40:00.000Z)');
    expect(failure.content).not.toMatch(/private-ref-b|private-key-b/); // no private CDN references in the notice
    expect(failure.content).not.toContain('compare with the photo'); // the queued text is never replayed
    expect(failure.metadata?.attachmentRecovery).toMatchObject({ state: 'failed', originalMessageId: 'image-b' });
    await new Promise(resolveTimer => setTimeout(resolveTimer, 200)); // terminal state (failed+reported) must stay silent
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it('keeps both peers’ queued media counts and recovery slots separate', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    let releaseA!: () => void; let releaseC!: () => void;
    const resolve = gatedDownloads({
      'private-ref': new Promise<void>(r => { releaseA = r; }),
      'private-ref-c': new Promise<void>(r => { releaseC = r; }),
    });
    const f = await fixture([[imageA, imageC], [textA, textB]], resolve, processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2));
    const [aText, bText] = processor.mock.calls.map(call => call[0] as IncomingMessage);
    expect(aText).toMatchObject({ messageId: 'text-a' });
    expect(aText.content).toContain('1 条图片/文件消息仍在处理中'); // each peer sees only its own queue
    expect(bText).toMatchObject({ messageId: 'text-b' });
    expect(bText.content).toContain('1 条图片/文件消息仍在处理中');
    releaseA(); releaseC();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(4));
    const turns = processor.mock.calls.map(call => call[0] as IncomingMessage);
    const aResumed = turns.find(m => m.messageId === 'image-a')!;
    const cResumed = turns.find(m => m.messageId === 'image-c')!;
    expect(aResumed.content).toContain('compare with the photo I sent');
    expect(aResumed.content).not.toContain('unrelated question');
    expect(cResumed.content).toContain('unrelated question');
    expect(cResumed.content).not.toContain('compare with the photo');
  });

  it('dispatches queued media exactly once when the same update is delivered twice', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const resolve = vi.fn().mockImplementation(() =>
      gate.then(() => ({ fileName: 'image.png', filePath: join(tmpdir(), 'image.png') })));
    const f = await fixture([[imageA], [imageA], [textA]], resolve, processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledOnce()); // noted text turn after the duplicate enqueue
    release();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2));
    const mediaTurns = processor.mock.calls.map(call => call[0] as IncomingMessage).filter(m => m.messageId === 'image-a');
    expect(mediaTurns).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1); // one download, one dispatch, no reset
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox).toBeUndefined());
  });

  it('cancels queued recovery on stop() and keeps the record with its pending request for restart', async () => {
    const processor = vi.fn().mockResolvedValue(undefined);
    const f = await fixture([[imageA, textA]], hangingDownload(), processor);
    f.listener.start();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledOnce()); // noted text turn; slot persisted
    await f.listener.stop();
    expect(processor).toHaveBeenCalledOnce(); // no dispatch after the cancel boundary
    expect((await f.store.loadSession('bot')).mediaInbox?.[0])
      .toMatchObject({ id: 'image-a', state: 'pending', pendingRequest: { messageId: 'text-a' } });
  });
});
