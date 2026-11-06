import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { WeChatMessageListener } from './message-listener.js';
import { WeChatStateStore, type WeChatSessionState } from './state-store.js';
import { downloadWeChatMedia } from './media.js';
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
  nock.cleanAll(); vi.restoreAllMocks();
});

// A fixed key and ciphertext let every leg assert real decrypt behavior.
const aesKey = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
const cipher = createCipheriv('aes-128-ecb', aesKey, null);
const ciphertext = Buffer.concat([cipher.update(Buffer.from('essay-photo-bytes')), cipher.final()]);
const wrongCipher = createCipheriv('aes-128-ecb', Buffer.from('fedcba9876543210fedcba9876543210', 'hex'), null);
const undecryptable = Buffer.concat([wrongCipher.update(Buffer.from('not-the-essay')), wrongCipher.final()]);

const image: WeChatUpdate = {
  message_id: 'image', from_user_id: 'peer', context_token: 'ctx',
  item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'private-ref' }, aeskey: aesKey.toString('hex') } }],
};
const text: WeChatUpdate = { message_id: 'text', from_user_id: 'peer', item_list: [{ type: 1, text_item: { text: 'later instruction' } }] };

/** Real listener wiring: the production resolver plus a private account store. */
async function fixture(batch: WeChatUpdate[], state?: WeChatSessionState, directory?: string) {
  const dir = directory ?? await fs.mkdtemp(join(tmpdir(), 'wechat-5518-'));
  if (!directory) { dirs.push(dir); }
  const store = new WeChatStateStore(dir);
  let cursor = state?.cursor ?? 'before';
  const acknowledgements: string[] = [];
  const contexts = new Map(Object.entries(state?.contexts ?? {}));
  const client = {
    setUpdatesCursor: (value: string) => { cursor = value; }, getUpdatesCursor: () => cursor,
    acknowledgeUpdates: () => { acknowledgements.push(cursor); cursor = 'after'; },
    getUpdates: vi.fn().mockResolvedValueOnce(batch).mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal.aborted) { abort(); } else { signal.addEventListener('abort', abort, { once: true }); }
    })),
  };
  const processor = vi.fn().mockResolvedValue(undefined);
  const listener = new WeChatMessageListener(client as unknown as WeChatApiClient, processor, {
    state,
    checkpoint: async value => { await store.saveSession({ ...value, botId: 'bot', contexts: Object.fromEntries(contexts) }); },
    resolveAttachment: (item, signal) => downloadWeChatMedia(item, join(dir, 'media'), signal),
    onContext: (peer, token) => contexts.set(peer, token),
  });
  owned.push(listener);
  return { dir, store, listener, processor };
}

describe('inbound attachment failures are never confirmed processed (#5518)', () => {
  it('keeps a failed image out of seenMessageIds, retains a recoverable record with stage+cause, and recovers it after restart', async () => {
    // First leg: the CDN download fails while the batch's text proceeds.
    nock('https://novac2c.cdn.weixin.qq.com').get('/c2c/download').query(true)
      .replyWithError({ code: 'ECONNRESET', message: 'private-reset' });
    const f = await fixture([image, text]);
    f.listener.start();
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox?.[0].failures).toBe(1));
    const saved = await f.store.loadSession('bot');
    expect(saved.seenMessageIds).toContain('text');
    expect(saved.seenMessageIds).not.toContain('image');
    expect(saved.mediaInbox?.[0]).toMatchObject({ id: 'image', state: 'pending' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'media_recovery_failed', messageId: 'image',
      stage: 'fetch', reason: 'network', retryable: true }), expect.any(String));
    await f.listener.stop();

    // Restart leg: the retained record retries the download and delivers the image.
    const restored0 = await f.store.loadSession('bot');
    const realNow = Date.now.bind(Date); const offset = Math.max(0, restored0.mediaInbox![0].nextAt - realNow() + 1);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    nock('https://novac2c.cdn.weixin.qq.com').get('/c2c/download').query(true).reply(200, () => ciphertext);
    const restored = await fixture([], restored0, f.dir);
    restored.listener.start();
    await vi.waitFor(() => expect(restored.processor).toHaveBeenCalledOnce());
    expect(restored.processor.mock.calls[0][0]).toMatchObject({ messageId: 'image',
      metadata: { attachmentRecovery: { state: 'completed', originalMessageId: 'image' } } });
    expect(await fs.readFile(restored.processor.mock.calls[0][0].attachments![0].filePath)).toEqual(Buffer.from('essay-photo-bytes'));
    await vi.waitFor(async () => {
      const done = await restored.store.loadSession('bot');
      expect(done.mediaInbox).toBeUndefined();
      expect(done.seenMessageIds).toContain('image');
    });
  });

  it('treats an undecryptable image as terminal-failed: no success confirmation, no silent loss, diagnostics retained', async () => {
    nock('https://novac2c.cdn.weixin.qq.com').get('/c2c/download').query(true).reply(200, () => undecryptable);
    const f = await fixture([image]);
    f.listener.start();
    await vi.waitFor(() => expect(f.processor).toHaveBeenCalledOnce());
    expect(f.processor.mock.calls[0][0]).toMatchObject({ chatId: 'peer',
      metadata: { attachmentRecovery: { state: 'failed', originalMessageId: 'image' } } });
    expect(f.processor.mock.calls[0][0].content).toContain('Attachment processing failed');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'media_recovery_failed', messageId: 'image',
      stage: 'decrypt', reason: 'decrypt', retryable: false, cause: expect.anything() }), expect.any(String));
    await f.listener.stop();
    const saved = await f.store.loadSession('bot');
    expect(saved.seenMessageIds).not.toContain('image');
    expect(saved.mediaInbox?.[0]).toMatchObject({ id: 'image', state: 'failed', reported: true });
  });

  it('delivers a decryptable image on the first attempt without regression', async () => {
    nock('https://novac2c.cdn.weixin.qq.com').get('/c2c/download').query(true).reply(200, () => ciphertext);
    const f = await fixture([image, text]);
    f.listener.start();
    await vi.waitFor(() => expect(f.processor).toHaveBeenCalledTimes(2));
    const delivered = f.processor.mock.calls.map(call => call[0]).find(m => m.messageId === 'image');
    expect(delivered).toBeTruthy();
    expect(await fs.readFile(delivered!.attachments![0].filePath)).toEqual(Buffer.from('essay-photo-bytes'));
    await vi.waitFor(async () => expect((await f.store.loadSession('bot')).mediaInbox).toBeUndefined());
    expect(await fs.stat(delivered!.attachments![0].filePath)).toBeTruthy();
  });
});
