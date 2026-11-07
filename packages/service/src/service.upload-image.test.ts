/**
 * DisclaudeService.uploadImage dispatch tests (T-083 R3, #5254).
 *
 * The HTTP layer (http-api-server.test.ts) mocks the handler, so it cannot
 * verify the non-trivial part of this slice: that the optional chat
 * attribution selects the OWNING channel's uploadImage (and therefore that
 * channel's app credentials) instead of an arbitrary first app, while the
 * unattributed legacy path stays bit-identical for single-app deployments.
 */

import { describe, it, expect, vi } from 'vitest';
import { DisclaudeService } from './service.js';
import type { ChannelApiHandlers, FeishuApiHandlers, IChannel } from '@disclaude/core';

function makeNode(): {
  node: DisclaudeService;
  registerNamed: (
    id: string,
    uploadImage: ReturnType<typeof vi.fn> | undefined,
    owns: (chatId: string) => boolean
  ) => void;
} {
  const node = new DisclaudeService();
  const registerNamed = (
    id: string,
    uploadImage: ReturnType<typeof vi.fn> | undefined,
    owns: (chatId: string) => boolean
  ) => {
    const handlers = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      ...(uploadImage ? { uploadImage } : {}),
    } as unknown as ChannelApiHandlers;
    const channel = { id, ownsChatId: owns } as unknown as IChannel;
    node.registerChannelHandlers(id, handlers, channel);
  };
  return { node, registerNamed };
}

describe('DisclaudeService.uploadImage dispatch (T-083 R3 — ownership routing)', () => {
  it('uploads through the OWNING named channel when chatId carries the attribution', async () => {
    const { node, registerNamed } = makeNode();
    const personal = vi.fn().mockResolvedValue({ imageKey: 'img_personal' });
    const work = vi.fn().mockResolvedValue({ imageKey: 'img_work' });
    registerNamed('feishu:personal', personal, (id) => id.startsWith('feishu:personal:'));
    registerNamed('feishu:work', work, (id) => id.startsWith('feishu:work:'));

    const res = await node.uploadImage('/tmp/chart.png', 'feishu:work:oc_review');

    expect(res).toEqual({ success: true, imageKey: 'img_work' });
    expect(work).toHaveBeenCalledTimes(1);
    expect(personal).not.toHaveBeenCalled();
  });

  it('keeps the legacy single-app path for unattributed and bare-id requests', async () => {
    const { node } = makeNode();
    const legacy = vi.fn().mockResolvedValue({ imageKey: 'img_legacy' });
    node.registerFeishuHandlers({
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      uploadImage: legacy,
    } as unknown as FeishuApiHandlers);

    expect(await node.uploadImage('/tmp/a.png')).toEqual({ success: true, imageKey: 'img_legacy' });
    expect(await node.uploadImage('/tmp/b.png', 'oc_bare')).toEqual({
      success: true,
      imageKey: 'img_legacy',
    });
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it('rejects clearly when the attribution is unowned or the owner cannot upload', async () => {
    const { node, registerNamed } = makeNode();
    // Owns the routed id but registers no uploadImage capability.
    registerNamed('feishu:work', undefined, (id) => id.startsWith('feishu:work:'));

    // A routed id no channel owns is rejected by the ownership resolver.
    await expect(node.uploadImage('/tmp/x.png', 'feishu:other:oc_1')).rejects.toThrow(
      'No registered channel owns this chat'
    );
    // An owning channel without upload support gets the actionable message.
    await expect(node.uploadImage('/tmp/x.png', 'feishu:work:oc_1')).rejects.toThrow(
      /not supported by the channel owning feishu:work:oc_1/
    );
    // Unattributed + named-only setup: no legacy container exists, and the
    // service must not silently borrow the first named channel's credentials.
    await expect(node.uploadImage('/tmp/x.png')).rejects.toThrow('uploadImage not supported');
  });
});
