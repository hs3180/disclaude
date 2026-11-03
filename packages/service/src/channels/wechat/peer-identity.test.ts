/**
 * Tests for stable peer identity bindings (#5600).
 *
 * Covers the store (persistence, re-registration continuation, scope
 * isolation, no-stable-id fallback) and the channel wiring (continued chatId
 * emission, outbound alias routing, ownership after restart).
 *
 * @see Issue #5600 - bind session identity to a stable WeChat user id
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatPeerIdentityStore } from './peer-identity.js';

const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const PEER = 'wxid_peer-1@im.wechat';
const PEER2 = 'wxid_peer-2@im.wechat';

async function tempRoot(): Promise<string> {
  return await fs.mkdtemp(join(tmpdir(), 'wechat-peer-identity-'));
}

describe('WeChatPeerIdentityStore', () => {
  it('binds the first-seen chatId and persists it across processes', async () => {
    const dir = await tempRoot();
    const first = await new WeChatPeerIdentityStore(dir).continuePeer({
      peer: PEER, channelId: `wechat:${OLD_ID}`, registrationId: OLD_ID, scope: 'operator-1',
    });
    expect(first).toMatchObject({ chatId: `wechat:${OLD_ID}:${PEER}`, continued: false });
    const onDisk = JSON.parse(await fs.readFile(join(dir, 'peer-identities.json'), 'utf8'));
    expect(Object.keys(onDisk.bindings)).toHaveLength(1);
    // A fresh instance (new process/registration) reads the same binding.
    const binding = await new WeChatPeerIdentityStore(dir).loadBinding(PEER, 'operator-1');
    expect(binding).toMatchObject({ chatId: `wechat:${OLD_ID}:${PEER}`, registrationId: OLD_ID });
  });

  it('continues the original chatId when a new registration sees the same stable peer id', async () => {
    const dir = await tempRoot();
    const store = new WeChatPeerIdentityStore(dir);
    await store.continuePeer({ peer: PEER, channelId: `wechat:${OLD_ID}`, registrationId: OLD_ID, scope: 'operator-1' });
    const reregistered = await new WeChatPeerIdentityStore(dir).continuePeer({
      peer: PEER, channelId: `wechat:${NEW_ID}`, registrationId: NEW_ID, scope: 'operator-1',
    });
    expect(reregistered).toMatchObject({
      chatId: `wechat:${OLD_ID}:${PEER}`, continued: true, previousRegistrationId: OLD_ID,
    });
    // The re-registration must not rebind the conversation to its own prefix.
    expect(await new WeChatPeerIdentityStore(dir).loadBinding(PEER, 'operator-1'))
      .toMatchObject({ chatId: `wechat:${OLD_ID}:${PEER}` });
  });

  it('keeps behavior unchanged when no stable id is available', async () => {
    const dir = await tempRoot();
    const store = new WeChatPeerIdentityStore(dir, () => undefined);
    const result = await store.continuePeer({ peer: PEER, channelId: `wechat:${NEW_ID}`, registrationId: NEW_ID });
    expect(result).toEqual({ chatId: `wechat:${NEW_ID}:${PEER}`, continued: false });
    await expect(fs.access(join(dir, 'peer-identities.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never continues a peer across operator scopes', async () => {
    const dir = await tempRoot();
    const store = new WeChatPeerIdentityStore(dir);
    await store.continuePeer({ peer: PEER, channelId: `wechat:${OLD_ID}`, registrationId: OLD_ID, scope: 'operator-1' });
    const other = await store.continuePeer({ peer: PEER, channelId: `wechat:${NEW_ID}`, registrationId: NEW_ID, scope: 'operator-2' });
    expect(other).toMatchObject({ chatId: `wechat:${NEW_ID}:${PEER}`, continued: false });
  });

  it('does not rewrite the binding when the owning registration asks again', async () => {
    const dir = await tempRoot();
    const store = new WeChatPeerIdentityStore(dir);
    await store.continuePeer({ peer: PEER, channelId: `wechat:${OLD_ID}`, registrationId: OLD_ID, scope: 'operator-1' });
    const before = await fs.readFile(join(dir, 'peer-identities.json'), 'utf8');
    const again = await store.continuePeer({ peer: PEER, channelId: `wechat:${OLD_ID}`, registrationId: OLD_ID, scope: 'operator-1' });
    expect(again).toEqual({ chatId: `wechat:${OLD_ID}:${PEER}`, continued: false });
    expect(await fs.readFile(join(dir, 'peer-identities.json'), 'utf8')).toBe(before);
  });

  it('rejects a corrupt identities file instead of guessing', async () => {
    const dir = await tempRoot();
    await fs.writeFile(join(dir, 'peer-identities.json'), '{not json', { mode: 0o600 });
    await expect(new WeChatPeerIdentityStore(dir).continuePeer({
      peer: PEER, channelId: `wechat:${NEW_ID}`, registrationId: NEW_ID,
    })).rejects.toThrow('Invalid WeChat peer identities');
  });
});

// Channel wiring: real state store in a temp registry; API client, auth and
// listener mocked following the established wechat-channel.test.ts pattern.
const mockSendText = vi.fn().mockResolvedValue('sent-id');
const listenerCtorCalls: Array<{ processor: (message: unknown) => Promise<void> }> = [];

vi.mock('./api-client.js', () => ({
  WeChatApiError: class WeChatApiError extends Error {
    readonly authExpired: boolean;
    readonly detail: { errmsg?: string; diagnosticId?: string } | undefined;
    constructor(readonly code: number, detail?: { errmsg?: string; diagnosticId?: string }) {
      super(`WeChat API error [${code}]`);
      this.name = 'WeChatApiError';
      this.authExpired = code === -14 || code === 401;
      this.detail = detail;
    }
  },
  WeChatApiClient: vi.fn(class {
    sendText = mockSendText;
    sendTyping = vi.fn().mockResolvedValue(undefined);
    setToken = vi.fn();
    hasToken = vi.fn().mockReturnValue(true);
    getUpdates = vi.fn().mockResolvedValue([]);
    checkSession = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('./auth.js', () => ({
  WeChatAuth: vi.fn(class {
    authenticate = vi.fn();
    isAuthenticating = vi.fn().mockReturnValue(false);
    abort = vi.fn();
  }),
}));

vi.mock('./message-listener.js', () => ({
  WeChatMessageListener: vi.fn(class {
    start = vi.fn();
    stop = vi.fn().mockResolvedValue(undefined);
    isListening = vi.fn().mockReturnValue(true);
    isHealthy = vi.fn().mockReturnValue(true);
    applyAuthProbe = vi.fn();
    constructor(_client: unknown, processor: (message: unknown) => Promise<void>) {
      listenerCtorCalls.push({ processor });
    }
  }),
  MessageProcessor: undefined,
}));

describe('WeChatChannel peer identity continuation (#5600)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenerCtorCalls.length = 0;
    mockSendText.mockResolvedValue('sent-id');
  });

  it('continues the original conversation after re-registration and routes replies to this account', async () => {
    const { WeChatChannel } = await import('./wechat-channel.js');
    const { WeChatStateStore } = await import('./state-store.js');
    const root = await tempRoot();
    const accountDir = join(root, 'accounts', NEW_ID);
    // Default identity dir = dirname(accountDir): the registry's accounts
    // root, shared by every registration of this host.
    const identityDir = join(root, 'accounts');
    // The previous registration bound this operator's peer to its chatId.
    await new WeChatPeerIdentityStore(identityDir).continuePeer({
      peer: PEER, channelId: `wechat:${OLD_ID}`, registrationId: OLD_ID, scope: 'operator-1',
    });
    // The re-registered account already persisted a reply context for the peer.
    const stateStore = new WeChatStateStore(accountDir);
    await stateStore.saveCredentials({ token: 'tok', botId: 'bot-new', userId: 'operator-1', baseUrl: 'https://ilinkai.weixin.qq.com', savedAt: new Date().toISOString() });
    await stateStore.saveSession({ botId: 'bot-new', cursor: '', seenMessageIds: [], contexts: { [PEER]: 'ctx-1' } });

    const channel = new WeChatChannel({ registrationId: NEW_ID, stateDir: accountDir });
    try {
      // Warmed from the persisted session: the old chatId is owned at start.
      expect(channel.ownsChatId(`wechat:${OLD_ID}:${PEER}`)).toBe(false);
      await channel.start();
      expect(channel.ownsChatId(`wechat:${OLD_ID}:${PEER}`)).toBe(true);
      expect(channel.ownsChatId(`wechat:${OLD_ID}:${PEER2}`)).toBe(false);

      const received: Array<{ chatId: string; metadata?: Record<string, unknown> }> = [];
      channel.onMessage((message) => { received.push(message as { chatId: string; metadata?: Record<string, unknown> }); return Promise.resolve(); });
      const processor = listenerCtorCalls.at(-1)?.processor;
      if (!processor) { throw new Error('message listener was not constructed'); }

      // Same peer, new account id: the original chatId is kept — no fork.
      await processor({ messageId: 'm1', chatId: PEER, userId: PEER, content: 'hi', messageType: 'text', timestamp: 1 });
      expect(received.at(-1)?.chatId).toBe(`wechat:${OLD_ID}:${PEER}`);
      expect(received.at(-1)?.metadata).toMatchObject({ channelId: `wechat:${NEW_ID}`, registrationId: NEW_ID });

      // An unknown peer still gets this registration's natural prefix.
      await processor({ messageId: 'm2', chatId: PEER2, userId: PEER2, content: 'yo', messageType: 'text', timestamp: 2 });
      expect(received.at(-1)?.chatId).toBe(`wechat:${NEW_ID}:${PEER2}`);

      // Replies to the continued chatId reach this account's peer and context.
      await (channel as unknown as { doSendMessage: (m: unknown) => Promise<string | void> })
        .doSendMessage({ type: 'text', chatId: `wechat:${OLD_ID}:${PEER}`, text: 'reply' });
      expect(mockSendText).toHaveBeenCalledWith(expect.objectContaining({ to: PEER, contextToken: 'ctx-1' }));
    } finally {
      await channel.stop();
    }
  });

  it('leaves channels without a registrationId untouched', async () => {
    const { WeChatChannel } = await import('./wechat-channel.js');
    const channel = new WeChatChannel({ token: 'test-token' });
    const processor = listenerCtorCalls.at(-1); // none yet
    expect(processor).toBeUndefined();
    expect((channel as unknown as { peerIdentities: unknown }).peerIdentities).toBeUndefined();
  });
});
