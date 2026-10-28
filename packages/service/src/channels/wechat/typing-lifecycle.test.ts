import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, IteratorYieldResult, StreamingUserMessage } from '@disclaude/core';
import { ChatAgent } from '../../agents/chat-agent.js';
import { WECHAT_WIRED_DESCRIPTOR } from '../wired-descriptors.js';
import { WeChatChannel } from './wechat-channel.js';
import { WeChatApiClient } from './api-client.js';

const captured = vi.hoisted(() => [] as Array<{ processor: (message: IncomingMessage) => Promise<unknown>; onContext: (peer: string, token: string) => void }>);
vi.mock('./message-listener.js', () => ({ WeChatMessageListener: class {
  constructor(_client: unknown, processor: (message: IncomingMessage) => Promise<unknown>, options: { onContext: (peer: string, token: string) => void }) {
    captured.push({ processor, onContext: options.onContext });
  }
  start() {} async stop() {} isListening() { return true; } isHealthy() { return true; }
} }));
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => vi.advanceTimersByTimeAsync(0);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); captured.splice(0); });

async function fixture(background = false) {
  vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live network forbidden in typing test'); }));
  const root = await mkdtemp(join(tmpdir(), 'disclaude-typing-'));
  vi.stubEnv('DISCLAUDE_WORKSPACE_DIR', root);
  const send = vi.spyOn(WeChatApiClient.prototype, 'sendTyping').mockResolvedValue(true);
  vi.spyOn(WeChatApiClient.prototype, 'sendText').mockResolvedValue('text-ack');
  const channel = new WeChatChannel({ token: 'offline-fixture' }); await channel.start();
  const listener = captured.at(-1)!; listener.onContext('peer@im.wechat', 'private-context-A');
  const callbacks = { ...WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never)('peer@im.wechat'),
    getChatHistory: () => Promise.resolve(undefined), getChatLogFilePaths: () => Promise.resolve([]),
  };
  const agent = new ChatAgent({ chatId: 'peer@im.wechat', agentBackend: 'claude', callbacks, apiKey: 'offline-fixture', model: 'offline-fixture', cwdProvider: () => root });
  const gates = new Map<string, ReturnType<typeof deferred>>(); const closed: Promise<void>[] = []; const backgroundEnd = deferred();
  vi.spyOn(agent as any, 'createQueryStream').mockImplementation((input: unknown) => {
    let cancelled = false; let pending: ReturnType<typeof deferred> | undefined;
    const ended = deferred(); closed.push(ended.promise);
    return { handle: { close: () => { cancelled = true; pending?.resolve(); } }, iterator: (async function* (): AsyncGenerator<IteratorYieldResult> {
      try {
        for await (const message of input as AsyncIterable<StreamingUserMessage>) {
          if (cancelled) { return; }
          pending = gates.get(message.correlation!.sourceMessageId)!; await pending.promise;
          if (cancelled) { return; }
          if (background) { yield { raw: { type: 'text', content: '', role: 'assistant' }, parsed: { type: 'tool_progress', content: '', metadata: { backgroundTaskIds: ['native-job'] } } }; }
          yield { raw: { type: 'text', content: '', role: 'assistant' }, parsed: { type: 'text', content: '工作已完成。' } };
          yield { raw: { type: 'text', content: '', role: 'assistant' }, parsed: { type: 'result', content: '' } };
          if (background) {
            pending = backgroundEnd; await backgroundEnd.promise; if (cancelled) { return; }
            yield { raw: { type: 'text', content: '', role: 'assistant' }, parsed: { type: 'tool_progress', content: '', metadata: { backgroundTaskIds: [] } } };
          }
        }
      } finally { ended.resolve(); }
    })() };
  });
  channel.onMessage(async message => {
    await agent.processMessage({ chatId: message.chatId, messageId: message.messageId, payload: message.content, senderOpenId: message.userId });
  });
  const incoming = async (id: string) => {
    gates.set(id, deferred());
    await listener.processor({ messageId: id, chatId: 'peer@im.wechat', userId: 'peer@im.wechat', content: '完成隔离测试任务', messageType: 'text', timestamp: Date.now() });
    await tick();
  };
  const cleanup = async () => {
    agent.dispose(); backgroundEnd.resolve(); for (const gate of gates.values()) { gate.resolve(); }
    await Promise.all(closed); await channel.stop(); await rm(root, { recursive: true, force: true });
  };
  return { agent, channel, listener, send, gates, incoming, cleanup, backgroundEnd };
}

describe('actual channel processor / ChatAgent / delivery typing lifecycle (#5471)', () => {
  it('keeps quiet and queued turns alive, then waits for the last file delivery before cancelling', async () => {
    const f = await fixture(); const file = deferred();
    vi.spyOn(f.channel as any, 'sendViaCdn').mockImplementation(async () => { await file.promise; return 'file-ack'; });
    try {
      await f.incoming('input-one'); await vi.advanceTimersByTimeAsync(15_000);
      expect(f.send.mock.calls.map(([params]) => params.status)).toEqual([1, 1, 1, 1]);
      await f.incoming('input-two');
      const sendingFile = f.channel.sendMessage({ chatId: 'peer@im.wechat', type: 'file', filePath: '/offline-fixture/result.txt' });
      f.gates.get('input-one')!.resolve(); await f.agent.turnCompleteFor('input-one'); await tick();
      expect(f.send.mock.calls.some(([params]) => params.status === 2)).toBe(false);
      f.listener.onContext('peer@im.wechat', 'private-context-B');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.send.mock.calls.at(-1)?.[0].contextToken).toBe('private-context-B');
      f.gates.get('input-two')!.resolve(); await f.agent.turnCompleteFor('input-two'); await tick();
      expect(f.send.mock.calls.some(([params]) => params.status === 2)).toBe(false);
      file.resolve(); await sendingFile; await tick();
      expect(f.send.mock.calls.at(-1)?.[0].status).toBe(2);
      const count = f.send.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
      expect(f.send).toHaveBeenCalledTimes(count);
    } finally { file.resolve(); await f.cleanup(); }
  });
  it('releases every accepted input on reset without leaving a stale refresh loop', async () => {
    const f = await fixture();
    try {
      await f.incoming('input-one'); await f.incoming('input-two');
      const one = f.agent.turnCompleteFor('input-one')!; const two = f.agent.turnCompleteFor('input-two')!;
      const outcomes = Promise.allSettled([one, two]); f.agent.reset();
      expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
      await tick(); expect(f.send.mock.calls.at(-1)?.[0].status).toBe(2);
      const count = f.send.mock.calls.length; await vi.advanceTimersByTimeAsync(30_000);
      expect(f.send).toHaveBeenCalledTimes(count);
    } finally { await f.cleanup(); }
  });
  it('keeps explicitly reported native background work alive after its parent turn settles', async () => {
    const f = await fixture(true);
    try {
      await f.incoming('input-one'); f.gates.get('input-one')!.resolve();
      await f.agent.turnCompleteFor('input-one'); await tick();
      expect(f.agent.activeBackgroundTaskCount).toBe(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.send.mock.calls.some(([params]) => params.status === 2)).toBe(false);
      f.backgroundEnd.resolve(); await tick();
      expect(f.agent.activeBackgroundTaskCount).toBe(0);
      expect(f.send.mock.calls.at(-1)?.[0].status).toBe(2);
    } finally { await f.cleanup(); }
  });
});
