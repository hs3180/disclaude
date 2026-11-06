/**
 * Same-process Feishu + WeChat routing/lifecycle integration (#5449).
 * External platform transports are deterministic test doubles; the real service,
 * channel manager, handler registration and inbound wiring are exercised.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IChannel, IncomingMessage } from '@disclaude/core';
import { DisclaudeService } from '../../packages/service/src/service.js';

function channel(id: string, ownsChatId: (chatId: string) => boolean): IChannel {
  const instance: IChannel = {
    id,
    name: id,
    status: 'stopped',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn(),
    start: vi.fn(async () => {
      instance.status = 'running';
    }),
    stop: vi.fn(async () => {
      instance.status = 'stopped';
    }),
    isHealthy: vi.fn(() => instance.status === 'running'),
    getCapabilities: vi.fn(() => ({
      supportsCard: id === 'feishu',
      supportsThread: id === 'feishu',
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: id === 'feishu',
      supportsUpdate: false,
    })),
    ownsChatId,
  };
  return instance;
}

describe('Feishu and WeChat coexistence in one service', () => {
  it('isolates inbound/outbound routes and keeps the healthy channel available after a peer failure', async () => {
    const service = new DisclaudeService();
    const manager = service.getChannelManager();
    const feishu = channel('feishu', (id) => /^o[cu]_/.test(id));
    const wechat = channel('wechat:account', (id) => id.startsWith('wechat:account:'));
    service.registerChannel(feishu);
    service.registerChannel(wechat);

    const feishuSend = vi.fn(async () => 'om_feishu');
    const wechatSend = vi.fn(async () => 'wx_wechat');
    const feishuUpload = vi.fn(async () => ({ fileKey: 'feishu-file' }));
    const wechatUpload = vi.fn(async () => {
      throw new Error('attachment unsupported by fixture');
    });
    service.registerChannelHandlers(
      'feishu',
      { sendMessage: feishuSend, uploadFile: feishuUpload } as never,
      feishu
    );
    service.registerChannelHandlers(
      'wechat',
      { sendMessage: wechatSend, uploadFile: wechatUpload } as never,
      wechat
    );

    const received: Array<{ channel: string; chatId: string }> = [];
    for (const [name, instance] of [
      ['feishu', feishu],
      ['wechat', wechat],
    ] as const) {
      manager.setupHandlers(
        instance,
        async (message: IncomingMessage) => {
          received.push({ channel: name, chatId: message.chatId });
        },
        vi.fn()
      );
    }
    const inbound = (instance: IChannel) => vi.mocked(instance.onMessage).mock.calls[0][0];
    await inbound(feishu)({
      messageId: 'om_in',
      chatId: 'oc_shared',
      content: 'feishu',
      messageType: 'text',
    });
    await inbound(wechat)({
      messageId: 'wx_in',
      chatId: 'wechat:account:peer',
      content: 'wechat',
      messageType: 'text',
    });
    expect(received).toEqual([
      { channel: 'feishu', chatId: 'oc_shared' },
      { channel: 'wechat', chatId: 'wechat:account:peer' },
    ]);

    await expect(service.sendMessage('oc_shared', 'to feishu')).resolves.toEqual({
      success: true,
      messageId: 'om_feishu',
    });
    await expect(service.sendMessage('wechat:account:peer', 'to wechat')).resolves.toEqual({
      success: true,
      messageId: 'wx_wechat',
    });
    await expect(service.uploadFile('oc_shared', '/tmp/fixture.txt')).resolves.toMatchObject({
      fileKey: 'feishu-file',
    });
    await expect(service.uploadFile('wechat:account:peer', '/tmp/fixture.txt')).rejects.toThrow(
      'unsupported'
    );
    expect(feishuSend).toHaveBeenCalledTimes(1);
    expect(wechatSend).toHaveBeenCalledTimes(1);

    await expect(service.sendMessage('unknown-peer', 'do not deliver')).rejects.toThrow(
      'No registered channel owns'
    );
    // A raw ID collision must not silently rebind the existing Feishu route to WeChat.
    await inbound(wechat)({
      messageId: 'wx_collision',
      chatId: 'oc_shared',
      content: 'collision',
      messageType: 'text',
    });
    await expect(service.sendMessage('oc_shared', 'do not misroute')).rejects.toThrow('Ambiguous');
    expect(feishuSend).toHaveBeenCalledTimes(1);
    expect(wechatSend).toHaveBeenCalledTimes(1);

    vi.mocked(wechat.start).mockRejectedValueOnce(new Error('login expired'));
    await expect(manager.startAll()).resolves.toBeUndefined();
    expect(feishu.status).toBe('running');
    expect(feishu.isHealthy()).toBe(true);
    expect(
      service.getChannels().map((item) => ({ id: item.id, capabilities: item.getCapabilities() }))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'feishu',
          capabilities: expect.objectContaining({ supportsCard: true }),
        }),
        expect.objectContaining({
          id: 'wechat:account',
          capabilities: expect.objectContaining({ supportsCard: false }),
        }),
      ])
    );

    service.unregisterChannel(wechat.id);
    await expect(service.sendMessage('oc_shared', 'healthy route restored')).resolves.toEqual({
      success: true,
      messageId: 'om_feishu',
    });
    expect(feishuSend).toHaveBeenCalledTimes(2);
    expect(wechatSend).toHaveBeenCalledTimes(1);
  });
});
