import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAgent } from './chat-agent.js';

/**
 * #5453: anti-flood coalescing of live progress (public commentary and
 * decision narration) driven through the real processIterator pipeline.
 * Mirrors the descriptor-level scenarios in channels/wechat/progress.test.ts
 * with hand-built callbacks so the mechanism is covered independent of
 * channel wiring.
 */
const createCallbacks = (extra?: Record<string, unknown>) => ({
  sendMessage: vi.fn().mockResolvedValue('ack'),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
  getCapabilities: vi.fn(() => ({ supportsStreaming: false, supportsCard: false, supportsThread: false,
    supportsFile: true, supportsMarkdown: false, supportsMention: false, supportsUpdate: false })),
  getChatHistory: vi.fn().mockResolvedValue(undefined),
  ...extra,
});
const drive = (agent: ChatAgent) =>
  (agent as unknown as { processIterator: (iterator: AsyncIterable<unknown>) => Promise<void> }).processIterator.bind(agent);
const texts = (callbacks: { sendMessage: ReturnType<typeof vi.fn> }) => callbacks.sendMessage.mock.calls.map(([, text]) => text);

afterEach(() => vi.restoreAllMocks());

describe('progress coalescing (#5453)', () => {
  it('sends every progress item immediately when no interval is configured', async () => {
    const callbacks = createCallbacks();
    const agent = new ChatAgent({ chatId: 'plain-chat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await drive(agent)((async function* () {
        yield { parsed: { type: 'text', content: '阶段一。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'tool_use', content: 'private-command', metadata: { narration: '决策：读取日志。' } } };
        yield { parsed: { type: 'text', content: '最终答案。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(texts(callbacks)).toEqual(['阶段一。', '决策：读取日志。', '最终答案。']);
    } finally { agent.dispose(); }
  });

  it('merges a high-frequency burst into one text and keeps the final reply separate', async () => {
    const now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const callbacks = createCallbacks({ progressMinIntervalMs: 10_000 });
    const agent = new ChatAgent({ chatId: 'burst-chat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await drive(agent)((async function* () {
        yield { parsed: { type: 'text', content: '第一步。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '第二步。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '第三步。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'tool_use', content: 'private-command', metadata: { narration: '决策：检查堆栈。' } } };
        expect(texts(callbacks)).toEqual(['第一步。']);
        yield { parsed: { type: 'text', content: '完成，结论如下。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(texts(callbacks)).toEqual(['第一步。', '第二步。\n\n第三步。\n\n决策：检查堆栈。', '完成，结论如下。']);
      expect(JSON.stringify(callbacks.sendMessage.mock.calls)).not.toContain('private-command');
    } finally { agent.dispose(); }
  });

  it('flushes the pending batch once the window elapses; slow updates pass one by one', async () => {
    let now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const callbacks = createCallbacks({ progressMinIntervalMs: 10_000 });
    const agent = new ChatAgent({ chatId: 'window-chat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await drive(agent)((async function* () {
        yield { parsed: { type: 'text', content: '启动。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '快速更新。', metadata: { phase: 'commentary' } } };
        now += 20_000;
        nowSpy.mockImplementation(() => now);
        yield { parsed: { type: 'text', content: '窗口后更新。', metadata: { phase: 'commentary' } } };
        now += 20_000;
        nowSpy.mockImplementation(() => now);
        yield { parsed: { type: 'text', content: '慢速更新。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '最终结论。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(texts(callbacks)).toEqual(['启动。', '快速更新。\n\n窗口后更新。', '慢速更新。', '最终结论。']);
    } finally { agent.dispose(); }
  });

  it('finalReplyOnly suppresses commentary and narration while the final answer still arrives', async () => {
    const callbacks = createCallbacks({ finalReplyOnly: true });
    const agent = new ChatAgent({ chatId: 'final-only-chat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await drive(agent)((async function* () {
        yield { parsed: { type: 'text', content: '阶段说明。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'tool_use', content: 'private-command', metadata: { narration: '决策说明。' } } };
        yield { parsed: { type: 'text', content: '只有最终答案。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(texts(callbacks)).toEqual(['只有最终答案。']);
    } finally { agent.dispose(); }
  });

  it('a failed coalesced progress send never fails the turn', async () => {
    const now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const send = vi.fn()
      .mockResolvedValueOnce('ack')
      .mockRejectedValueOnce(new Error('delivery unknown'))
      .mockResolvedValue('ack');
    const callbacks = createCallbacks({ progressMinIntervalMs: 10_000, sendMessage: send });
    const agent = new ChatAgent({ chatId: 'retry-chat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await drive(agent)((async function* () {
        yield { parsed: { type: 'text', content: '立即发出。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '合并批次。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '最终答案。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(texts(callbacks)).toEqual(['立即发出。', '合并批次。', '最终答案。']);
      expect(texts(callbacks).some((text) => String(text).includes('❌'))).toBe(false);
    } finally { agent.dispose(); }
  });
});
