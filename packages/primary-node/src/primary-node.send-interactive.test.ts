/**
 * Tests for PrimaryNode.sendInteractive — the REST-parity counterpart of the
 * IPC sendInteractive handler (Issue #4279, part 5).
 *
 * The HTTP layer (http-api-server.test.ts) mocks the handler, so it cannot
 * verify the *non-trivial* part of this slice: that the public method delegates
 * to the channel's sendInteractive AND mirrors the IPC handler by registering
 * the resolved action prompts via InteractiveContextStore.register so button
 * clicks resolve. These tests exercise that registration path directly.
 *
 * Canonical reference: packages/core/src/ipc/unix-socket-server.ts sendInteractive case.
 */

import { describe, it, expect, vi } from 'vitest';
import { PrimaryNode } from './primary-node.js';
import type { ChannelApiHandlers, IChannel } from '@disclaude/core';

const TEST_CHAT = 'oc_interactive_test';

/** Subclass to expose the protected InteractiveContextStore for spy wiring. */
class TestablePrimaryNode extends PrimaryNode {
  getInteractiveContextStore() {
    return this.interactiveContextStore;
  }
}

/**
 * Build a PrimaryNode whose TEST_CHAT routes to handlers with the given
 * sendInteractive mock. Returns the node and the mock so each test can wire
 * its own channel return value.
 */
function makeNode(sendInteractive: ReturnType<typeof vi.fn>): TestablePrimaryNode {
  const node = new TestablePrimaryNode();
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

describe('PrimaryNode.sendInteractive (Issue #4279 — registration path)', () => {
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
    expect(registerSpy).toHaveBeenCalledWith('om_card_1', TEST_CHAT, resolvedPrompts);
    // Mirrors the IPC handler: success is true whenever the channel resolves.
    expect(res).toEqual({ success: true, messageId: 'om_card_1' });
  });

  it('falls back to params.actionPrompts when the channel result omits them', async () => {
    const sendInteractive = vi.fn().mockResolvedValue({ messageId: 'om_card_2' });
    const node = makeNode(sendInteractive);
    const registerSpy = vi.spyOn(node.getInteractiveContextStore(), 'register');
    const paramsPrompts = { approve: '[user] approved', reject: '[user] rejected' };

    await node.sendInteractive(TEST_CHAT, { ...BASE_PARAMS, actionPrompts: paramsPrompts });

    expect(registerSpy).toHaveBeenCalledWith('om_card_2', TEST_CHAT, paramsPrompts);
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
    // Mirrors the IPC guard `if (resolvedPrompts && result.messageId)`.
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
    const node = new TestablePrimaryNode();
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
