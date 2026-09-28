/**
 * Tests for DisclaudeService.sendInteractive — the REST-parity counterpart of the
 * REST API sendInteractive handler (Issue #4279, part 5).
 *
 * The HTTP layer (http-api-server.test.ts) mocks the handler, so it cannot
 * verify the *non-trivial* part of this slice: that the public method delegates
 * to the channel's sendInteractive AND mirrors the REST API handler by registering
 * the resolved action prompts via InteractiveContextStore.register so button
 * clicks resolve. These tests exercise that registration path directly.
 *
 * Canonical reference: packages/core/src/channel-api/unix-socket-server.ts sendInteractive case.
 */

import { describe, it, expect, vi } from 'vitest';
import { DisclaudeService } from './service.js';
import type { ChannelApiHandlers, IChannel } from '@disclaude/core';

const TEST_CHAT = 'oc_interactive_test';

/** Subclass to expose the protected InteractiveContextStore for spy wiring. */
class TestableDisclaudeService extends DisclaudeService {
  getInteractiveContextStore() {
    return this.interactiveContextStore;
  }
}

/**
 * Build a DisclaudeService whose TEST_CHAT routes to handlers with the given
 * sendInteractive mock. Returns the node and the mock so each test can wire
 * its own channel return value.
 */
function makeNode(sendInteractive: ReturnType<typeof vi.fn>): TestableDisclaudeService {
  const node = new TestableDisclaudeService();
  const handlers = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendInteractive,
    pushToAgent: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as ChannelApiHandlers;
  const channel = { ownsChatId: (id: string) => id === TEST_CHAT } as unknown as IChannel;
  node.registerChannelHandlers('test', handlers, channel);
  return node;
}

const BASE_PARAMS = {
  question: 'approve?',
  options: [{ text: '✅ Approve', value: 'approve', type: 'primary' as const }],
  title: 'Review',
};

describe('DisclaudeService.sendInteractive (Issue #4279 — registration path)', () => {
  it('delegates to the channel handler and registers action prompts resolved from the result', async () => {
    const resolvedPrompts = { approve: '[user] approved' };
    // Issue #1572: the channel may auto-generate default action prompts.
    const sendInteractive = vi.fn().mockResolvedValue({
      messageId: 'om_card_1',
      actionPrompts: resolvedPrompts,
    });
    const node = makeNode(sendInteractive);
    const registerSpy = vi.spyOn(node.getInteractiveContextStore(), 'register');

    const res = await node.sendInteractive(TEST_CHAT, BASE_PARAMS);

    expect(sendInteractive).toHaveBeenCalledTimes(1);
    expect(sendInteractive).toHaveBeenCalledWith(TEST_CHAT, BASE_PARAMS);
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith('om_card_1', TEST_CHAT, resolvedPrompts, Object.fromEntries(BASE_PARAMS.options.map(option => [option.value, option.text])));
    // Mirrors the REST API handler: success is true whenever the channel resolves.
    expect(res).toEqual({ success: true, messageId: 'om_card_1' });
  });

  it('falls back to params.actionPrompts when the channel result omits them', async () => {
    const sendInteractive = vi.fn().mockResolvedValue({ messageId: 'om_card_2' });
    const node = makeNode(sendInteractive);
    const registerSpy = vi.spyOn(node.getInteractiveContextStore(), 'register');
    const paramsPrompts = { approve: '[user] approved', reject: '[user] rejected' };

    await node.sendInteractive(TEST_CHAT, { ...BASE_PARAMS, actionPrompts: paramsPrompts });

    expect(registerSpy).toHaveBeenCalledWith('om_card_2', TEST_CHAT, paramsPrompts, Object.fromEntries(BASE_PARAMS.options.map(option => [option.value, option.text])));
  });

  it('persists the topic-thread root with a card so clicks route to the same agent session', async () => {
    const sendInteractive = vi.fn().mockResolvedValue({ messageId: 'om_topic_card' });
    const node = makeNode(sendInteractive);
    const registerSpy = vi.spyOn(node.getInteractiveContextStore(), 'register');
    const actionPrompts = { continue: '[user] Continue with the selected direction.' };
    const params = { ...BASE_PARAMS, actionPrompts, threadRootId: 'om_topic_root' };

    await node.sendInteractive(TEST_CHAT, params);

    expect(sendInteractive).toHaveBeenCalledWith(TEST_CHAT, params);
    expect(registerSpy).toHaveBeenCalledWith(
      'om_topic_card', TEST_CHAT, actionPrompts,
      Object.fromEntries(BASE_PARAMS.options.map(option => [option.value, option.text])), 'om_topic_root',
    );
  });

  it('coalesces concurrent card sends and reuses the registered card on retry', async () => {
    let resolveChannel!: (value: { messageId: string }) => void;
    const pending = new Promise<{ messageId: string }>(resolve => { resolveChannel = resolve; });
    const sendInteractive = vi.fn().mockReturnValue(pending);
    const node = makeNode(sendInteractive);
    const params = {
      ...BASE_PARAMS,
      actionPrompts: { continue: '[user] Continue with the selected direction.' },
      threadRootId: 'om_topic_root',
      idempotencyKey: 'codex-followup:om_source',
    };

    const first = node.sendInteractive(TEST_CHAT, params);
    const concurrentRetry = node.sendInteractive(TEST_CHAT, params);
    expect(sendInteractive).toHaveBeenCalledTimes(1);
    resolveChannel({ messageId: 'om_idempotent_card' });
    const results = await Promise.all([first, concurrentRetry]);
    const laterRetry = await node.sendInteractive(TEST_CHAT, params);

    expect(results).toEqual([
      { success: true, messageId: 'om_idempotent_card' },
      { success: true, messageId: 'om_idempotent_card' },
    ]);
    expect(laterRetry).toEqual({ success: true, messageId: 'om_idempotent_card' });
    expect(sendInteractive).toHaveBeenCalledTimes(1);
    expect(node.getInteractiveContextStore().getThreadRootId('om_idempotent_card', TEST_CHAT)).toBe('om_topic_root');
    expect(node.getInteractiveContextStore().getMessageIdByIdempotencyKey(TEST_CHAT, 'codex-followup:om_source')).toBe('om_idempotent_card');
  });

  it('persists the topic-thread root with a card so clicks route to the same agent session', async () => {
    const sendInteractive = vi.fn().mockResolvedValue({ messageId: 'om_topic_card' });
    const node = makeNode(sendInteractive);
    const registerSpy = vi.spyOn(node.getInteractiveContextStore(), 'register');
    const actionPrompts = { continue: '[user] Continue with the selected direction.' };

    await node.sendInteractive(TEST_CHAT, { ...BASE_PARAMS, actionPrompts, threadRootId: 'om_topic_root' });

    expect(sendInteractive).toHaveBeenCalledWith(TEST_CHAT, { ...BASE_PARAMS, actionPrompts, threadRootId: 'om_topic_root' });
    expect(registerSpy).toHaveBeenCalledWith(
      'om_topic_card', TEST_CHAT, actionPrompts,
      Object.fromEntries(BASE_PARAMS.options.map(option => [option.value, option.text])), 'om_topic_root',
    );
  });

  it('does not register when neither result nor params carry action prompts', async () => {
    const sendInteractive = vi.fn().mockResolvedValue({ messageId: 'om_card_3' });
    const node = makeNode(sendInteractive);
    const registerSpy = vi.spyOn(node.getInteractiveContextStore(), 'register');

    const res = await node.sendInteractive(TEST_CHAT, BASE_PARAMS);

    expect(registerSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, messageId: 'om_card_3' });
  });

  it('does not register when there is no messageId even if action prompts are present', async () => {
    // Mirrors the REST API guard `if (resolvedPrompts && result.messageId)`.
    const sendInteractive = vi.fn().mockResolvedValue({
      actionPrompts: { approve: '[user] approved' },
    });
    const node = makeNode(sendInteractive);
    const registerSpy = vi.spyOn(node.getInteractiveContextStore(), 'register');

    const res = await node.sendInteractive(TEST_CHAT, BASE_PARAMS);

    expect(registerSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, messageId: undefined });
  });

  it('throws when the channel does not support sendInteractive', async () => {
    const node = new TestableDisclaudeService();
    const handlers = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChannelApiHandlers;
    const channel = { ownsChatId: (id: string) => id === TEST_CHAT } as unknown as IChannel;
    node.registerChannelHandlers('nosend', handlers, channel);

    await expect(node.sendInteractive(TEST_CHAT, BASE_PARAMS)).rejects.toThrow(
      'sendInteractive not supported by this channel',
    );
  });

  it('propagates channel handler errors without registering', async () => {
    const sendInteractive = vi.fn().mockRejectedValue(new Error('card send failed'));
    const node = makeNode(sendInteractive);
    const registerSpy = vi.spyOn(node.getInteractiveContextStore(), 'register');

    await expect(node.sendInteractive(TEST_CHAT, BASE_PARAMS)).rejects.toThrow('card send failed');
    expect(registerSpy).not.toHaveBeenCalled();
  });
});
