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
    expect(callbacks.getCapabilities?.('user@im.wechat')?.supportsStreaming).toBe(false);
    const agent = new ChatAgent({ chatId: 'user@im.wechat', callbacks, apiKey: 'test', model: 'test' });
    const iterate = (agent as unknown as { processIterator: (iterator: AsyncIterable<unknown>) => Promise<void> }).processIterator.bind(agent);
    try {
      await iterate((async function* () {
        yield { parsed: { type: 'text', content: '先检查当前状态。', metadata: { phase: 'commentary' } } };
        expect(send.mock.calls.map(([msg]) => msg.text)).toEqual(['先检查当前状态。']);
        yield { parsed: { type: 'text', content: '先检查当前状态。', metadata: { phase: 'commentary' } } };
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
        yield { parsed: { type: 'text', content: '正在检查。', metadata: { phase: 'commentary' } } };
        yield { parsed: { type: 'text', content: '检查完成。', metadata: { phase: 'final_answer' } } };
        yield { parsed: { type: 'result', content: '' } };
      })());
      expect(send.mock.calls.map(([msg]) => msg.text)).toEqual(['正在检查。', '检查完成。']);
      await callbacks.sendProgress?.('user@im.wechat', '正在检查。');
      expect(send).toHaveBeenCalledTimes(3); // A new turn may report the same progress.
      const rest = REST_WIRED_DESCRIPTOR.createCallbacks(new RestChannel({ port: 0, host: '127.0.0.1', fileStorageDir: '/unused' }), { logger } as never)('rest-test');
      expect(rest.finalReplyOnly).toBe(true);
    } finally { agent.dispose(); }
  });
});
