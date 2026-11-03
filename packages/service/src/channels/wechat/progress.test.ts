import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAgent } from '../../agents/chat-agent.js';
import { WECHAT_WIRED_DESCRIPTOR, REST_WIRED_DESCRIPTOR } from '../wired-descriptors.js';
import { WeChatChannel } from './wechat-channel.js';
import { RestChannel } from '../rest-channel.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
afterEach(() => vi.restoreAllMocks());

describe('WeChat public progress through the actual descriptor and ChatAgent', () => {
  it('classifies legacy assistant text preceding a tool as progress, keeping final delivery separate', async () => {
    const channel = new WeChatChannel();
    const send = vi.spyOn(channel, 'sendMessage').mockResolvedValue('ack');
    const callbacks = WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never)('legacy@im.wechat');
    const agent = new ChatAgent({ chatId: 'legacy@im.wechat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await (agent as unknown as { processIterator: (iterator: AsyncIterable<unknown>) => Promise<void> }).processIterator((async function* () {
        yield { parsed: { type: 'text', content: '先核对登录状态。' } };
        yield { parsed: { type: 'tool_use', content: 'private-tool-command' } };
        expect(send.mock.calls.map(([msg]) => msg.text)).toEqual(['先核对登录状态。']);
        yield { parsed: { type: 'text', content: '核对完成。' } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(send.mock.calls.map(([msg]) => msg.text)).toEqual(['先核对登录状态。', '核对完成。']);
    } finally { agent.dispose(); }
  });
  it('sends commentary and decisions before one final answer without forwarding tool payloads', async () => {
    const channel = new WeChatChannel();
    const send = vi.spyOn(channel, 'sendMessage').mockResolvedValue('ack');
    const callbacks = WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never)('user@im.wechat');
    expect(callbacks.finalReplyOnly).not.toBe(true);
    expect(callbacks.progressMinIntervalMs).toBeUndefined();
    expect(callbacks).not.toHaveProperty('sendProgress');
    expect(callbacks.getCapabilities?.('user@im.wechat')?.supportsStreaming).toBe(false);
    const agent = new ChatAgent({ chatId: 'user@im.wechat', callbacks, apiKey: 'test', model: 'test' });
    const iterate = (agent as unknown as { processIterator: (iterator: AsyncIterable<unknown>) => Promise<void> }).processIterator.bind(agent);
    try {
      await iterate((async function* () {
        yield { parsed: { type: 'text', content: '先检查当前状态。', metadata: { phase: 'commentary' } } };
        expect(send.mock.calls.map(([msg]) => msg.text)).toEqual(['先检查当前状态。']);
        yield { parsed: { type: 'tool_use', content: 'private-command', metadata: { narration: '状态显示已登录，接下来检查路由。' } } };
        yield { parsed: { type: 'tool_progress', content: 'private-progress' } };
        yield { parsed: { type: 'tool_result', content: 'private-output' } };
        expect(send).toHaveBeenCalledTimes(2);
        yield { parsed: { type: 'text', content: '检查完成。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(send.mock.calls.map(([msg]) => msg.text)).toEqual(['先检查当前状态。', '状态显示已登录，接下来检查路由。', '检查完成。']);
      expect(JSON.stringify(send.mock.calls)).not.toContain('private-');
    } finally { agent.dispose(); }
  });

  it('keeps an uncertain progress send from failing the turn or being blindly resent', async () => {
    const channel = new WeChatChannel();
    const send = vi.spyOn(channel, 'sendMessage').mockRejectedValueOnce(new Error('unknown delivery outcome')).mockResolvedValue('final-ack');
    const callbacks = WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never)('user@im.wechat');
    const agent = new ChatAgent({ chatId: 'user@im.wechat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await (agent as unknown as { processIterator: (iterator: AsyncIterable<unknown>) => Promise<void> }).processIterator((async function* () {
        yield { parsed: { type: 'text', content: '正在检查。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '检查完成。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(send.mock.calls.map(([msg]) => msg.text)).toEqual(['正在检查。', '检查完成。']);
      const rest = REST_WIRED_DESCRIPTOR.createCallbacks(new RestChannel({ port: 0, host: '127.0.0.1', fileStorageDir: '/unused' }), { logger } as never)('rest-test');
      expect(rest.finalReplyOnly).toBe(true);
    } finally { agent.dispose(); }
  });
});

describe('WeChat progressUpdates configuration (#5453)', () => {
  const drive = (agent: ChatAgent) =>
    (agent as unknown as { processIterator: (iterator: AsyncIterable<unknown>) => Promise<void> }).processIterator.bind(agent);

  it('progressUpdates:false restores final-reply-only while the final answer still arrives', async () => {
    const channel = new WeChatChannel({ progressUpdates: false });
    const send = vi.spyOn(channel, 'sendMessage').mockResolvedValue('ack');
    const callbacks = WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never)('user@im.wechat');
    expect(callbacks.finalReplyOnly).toBe(true);
    expect(callbacks.progressMinIntervalMs).toBeUndefined();
    const agent = new ChatAgent({ chatId: 'user@im.wechat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await drive(agent)((async function* () {
        yield { parsed: { type: 'text', content: '先检查当前状态。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'tool_use', content: 'private-command', metadata: { narration: '决策：先查日志。' } } };
        yield { parsed: { type: 'text', content: '检查完成，结论如下。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(send.mock.calls.map(([msg]) => msg.text)).toEqual(['检查完成，结论如下。']);
    } finally { agent.dispose(); }
  });

  it('coalesces a high-frequency progress burst into one merged text and keeps the final reply separate', async () => {
    const now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const channel = new WeChatChannel({ progressUpdates: { minIntervalMs: 10_000 } });
    const send = vi.spyOn(channel, 'sendMessage').mockResolvedValue('ack');
    const callbacks = WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never)('user@im.wechat');
    expect(callbacks.progressMinIntervalMs).toBe(10_000);
    const agent = new ChatAgent({ chatId: 'user@im.wechat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await drive(agent)((async function* () {
        yield { parsed: { type: 'text', content: '第一步：核对配置。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '第二步：扫描日志。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '第三步：复现问题。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'tool_use', content: 'private-command', metadata: { narration: '决策：直接读堆栈。' } } };
        yield { parsed: { type: 'text', content: '定位完成，答案是 42。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(send.mock.calls.map(([msg]) => msg.text)).toEqual([
        '第一步：核对配置。',
        '第二步：扫描日志。\n\n第三步：复现问题。\n\n决策：直接读堆栈。',
        '定位完成，答案是 42。',
      ]);
    } finally { agent.dispose(); }
  });

  it('flushes a pending batch once the window elapses and passes slow updates through one by one', async () => {
    let now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const channel = new WeChatChannel({ progressUpdates: { minIntervalMs: 10_000 } });
    const send = vi.spyOn(channel, 'sendMessage').mockResolvedValue('ack');
    const callbacks = WECHAT_WIRED_DESCRIPTOR.createCallbacks(channel, { logger } as never)('user@im.wechat');
    const agent = new ChatAgent({ chatId: 'user@im.wechat', callbacks, apiKey: 'test', model: 'test' });
    try {
      await drive(agent)((async function* () {
        yield { parsed: { type: 'text', content: '启动检查。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '被合并的快速更新。', metadata: { phase: 'commentary' } } };
        now += 20_000;
        nowSpy.mockImplementation(() => now);
        yield { parsed: { type: 'text', content: '窗口已过，应随批次发出。', metadata: { phase: 'commentary' } } };
        now += 20_000;
        nowSpy.mockImplementation(() => now);
        yield { parsed: { type: 'text', content: '独立慢速更新。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '最终结论。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(send.mock.calls.map(([msg]) => msg.text)).toEqual([
        '启动检查。',
        '被合并的快速更新。\n\n窗口已过，应随批次发出。',
        '独立慢速更新。',
        '最终结论。',
      ]);
    } finally { agent.dispose(); }
  });

  it('leaves the REST channel final-only boundary untouched', () => {
    const rest = REST_WIRED_DESCRIPTOR.createCallbacks(new RestChannel({ port: 0, host: '127.0.0.1', fileStorageDir: '/unused' }), { logger } as never)('rest-boundary');
    expect(rest.finalReplyOnly).toBe(true);
    expect(rest.progressMinIntervalMs).toBeUndefined();
  });
});
