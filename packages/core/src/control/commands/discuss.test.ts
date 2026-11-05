/**
 * Tests for /discuss (Issue #5412 / T-086): side-discussion quick entry.
 *
 * Covers the three rings the task requires — entry parsing, venue routing
 * (选路), and conclusion flow-back delegation — plus registry gating so the
 * command only appears where the channel hook is wired.
 */

import { describe, expect, it, vi } from 'vitest';
import { handleDiscuss, parseDiscussArgs, chooseSideVenue, delegatedGroupBundle } from './discuss.js';
import { commandRegistry, getAvailableCommands } from './index.js';
import { createControlCommand } from '../normalize.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';

function makeContext(overrides: Partial<ControlHandlerContext> = {}): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn() },
    debugGroups: { getDebugGroup: () => null, setDebugGroup: vi.fn(), clearDebugGroup: () => null },
    ...overrides,
  };
}

function discussCommand(args: string[], extra: Partial<ControlCommand<'discuss'>> = {}): ControlCommand<'discuss'> {
  return createControlCommand('discuss', 'oc_main', { args }, {
    actorId: 'ou_alice',
    chatType: 'group',
    sourceMessageId: 'om_cmd',
    ...extra,
  });
}

describe('parseDiscussArgs', () => {
  it('parses an open request with the question text', () => {
    expect(parseDiscussArgs(['追查', '登录失败的原因'])).toEqual({ kind: 'open', question: '追查 登录失败的原因' });
  });

  it('splits leading scope flags off the question', () => {
    expect(parseDiscussArgs(['--group', '旁白方案'])).toEqual({ kind: 'open', question: '旁白方案', scope: 'group' });
    expect(parseDiscussArgs(['--private', '敏感问题'])).toEqual({ kind: 'open', question: '敏感问题', scope: 'private' });
  });

  it('parses done with an explicit side id and with anchor-only resolution', () => {
    expect(parseDiscussArgs(['done', 'side-3', '结论', '如下'])).toEqual({ kind: 'done', id: 'side-3', summary: '结论 如下' });
    expect(parseDiscussArgs(['done', '结论', '不带', 'id'])).toEqual({ kind: 'done', summary: '结论 不带 id' });
  });

  it('rejects empty input, bare flags, and done without a summary', () => {
    expect(parseDiscussArgs(undefined)).toEqual({ kind: 'usage' });
    expect(parseDiscussArgs(['--group'])).toEqual({ kind: 'usage' });
    expect(parseDiscussArgs(['done'])).toEqual({ kind: 'usage' });
    expect(parseDiscussArgs(['done', 'side-3'])).toEqual({ kind: 'usage' });
  });

  it('parses status only without extra words', () => {
    expect(parseDiscussArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseDiscussArgs(['status', 'now'])).toEqual({ kind: 'open', question: 'status now' });
  });
});

describe('chooseSideVenue (选路判据)', () => {
  it('routes topic-group commands to a new native topic', () => {
    const decision = chooseSideVenue({ chatType: 'topic' });
    expect(decision.venue).toBe('topic-thread');
    expect(decision.reason).toContain('话题群');
  });

  it('anchors p2p/group side threads on the trigger message when replying', () => {
    const decision = chooseSideVenue({ chatType: 'group', triggerMessageId: 'om_trigger', commandMessageId: 'om_cmd' });
    expect(decision).toMatchObject({ venue: 'message-thread', anchorMessageId: 'om_trigger' });
    expect(decision.reason).toContain('触发消息');
  });

  it('falls back to the command message anchor when not replying', () => {
    const decision = chooseSideVenue({ chatType: 'p2p', commandMessageId: 'om_cmd' });
    expect(decision).toMatchObject({ venue: 'message-thread', anchorMessageId: 'om_cmd' });
  });

  it('honors explicit group and private scopes regardless of chat type', () => {
    expect(chooseSideVenue({ chatType: 'p2p', scope: 'group' }).venue).toBe('delegated-group');
    expect(chooseSideVenue({ chatType: 'topic', scope: 'private' }).venue).toBe('p2p');
  });

  it('degrades to the group path when the channel lacks native threads', () => {
    const decision = chooseSideVenue({ chatType: 'group', supportsThread: false });
    expect(decision.venue).toBe('delegated-group');
    expect(decision.reason).toContain('不支持');
  });
});

describe('handleDiscuss', () => {
  it('answers usage for an empty question', async () => {
    const response = await handleDiscuss(discussCommand([]), makeContext());
    expect(response.success).toBe(false);
    expect(response.message).toContain('/discuss <问题>');
  });

  it('delegates open to the channel hook with venue and anchors', async () => {
    const open = vi.fn<NonNullable<ControlHandlerContext['sideDiscussions']>['open']>()
      .mockResolvedValue({ ok: true, message: '已开支线 side-1' });
    const context = makeContext({
      sideDiscussions: { open, conclude: vi.fn(), list: vi.fn().mockResolvedValue([]) },
    });
    const command = createControlCommand('discuss', 'oc_main', { args: ['追查问题'], parentId: 'om_trigger' }, {
      actorId: 'ou_alice', chatType: 'group', sourceMessageId: 'om_cmd',
    });
    const response = await handleDiscuss(command, context);
    expect(response.success).toBe(true);
    expect(response.message).toContain('side-1');
    expect(open).toHaveBeenCalledWith({
      chatId: 'oc_main', question: '追查问题', venue: 'message-thread',
      anchorMessageId: 'om_trigger', triggerMessageId: 'om_trigger', commandMessageId: 'om_cmd',
      chatType: 'group', actorId: 'ou_alice',
    });
  });

  it('degrades --group to a delegation bundle without calling the hook', async () => {
    const open = vi.fn();
    const context = makeContext({ sideDiscussions: { open, conclude: vi.fn(), list: vi.fn().mockResolvedValue([]) } });
    const command = createControlCommand('discuss', 'oc_main', { args: ['--group', '旁白方案'], parentId: 'om_trigger' }, {
      actorId: 'ou_alice', chatType: 'group', sourceMessageId: 'om_cmd', threadRootId: 'om_root',
    });
    const response = await handleDiscuss(command, context);
    expect(response.success).toBe(true);
    expect(response.message).toContain('start-discussion');
    expect(response.message).toContain('om_trigger');
    expect(response.message).toContain('oc_main');
    expect(open).not.toHaveBeenCalled();
  });

  it('builds the delegation bundle from the decision reason', () => {
    const bundle = delegatedGroupBundle({
      chatId: 'oc_main', question: '旁白方案', reason: '需要独立群或多人参与',
      triggerMessageId: 'om_trigger', commandMessageId: 'om_cmd',
    });
    expect(bundle).toContain('判据：需要独立群或多人参与');
    expect(bundle).toContain('来源会话：oc_main');
    expect(bundle).toContain('触发消息：om_trigger');
    expect(delegatedGroupBundle({ chatId: 'oc_main', question: 'q', reason: 'r', commandMessageId: 'om_cmd' }))
      .toContain('（无，按当前对话上下文取背景）');
  });

  it('delegates done to conclude with id or thread anchor', async () => {
    const conclude = vi.fn<NonNullable<ControlHandlerContext['sideDiscussions']>['conclude']>()
      .mockResolvedValue({ ok: true, message: '已回流' });
    const context = makeContext({ sideDiscussions: { open: vi.fn(), conclude, list: vi.fn().mockResolvedValue([]) } });
    const command = createControlCommand('discuss', 'oc_main', { args: ['done', 'side-2', '结论如下'] }, {
      actorId: 'ou_alice', chatType: 'group', sourceMessageId: 'om_done', threadRootId: 'om_side_root',
    });
    const response = await handleDiscuss(command, context);
    expect(response.success).toBe(true);
    expect(conclude).toHaveBeenCalledWith({
      chatId: 'oc_main', id: 'side-2', summary: '结论如下', threadRootId: 'om_side_root', actorId: 'ou_alice',
    });
  });

  it('reports hook failures as command failures', async () => {
    const context = makeContext({ sideDiscussions: { open: vi.fn(), conclude: vi.fn().mockResolvedValue({ ok: false, error: '未匹配到支线记录' }), list: vi.fn().mockResolvedValue([]) } });
    const response = await handleDiscuss(discussCommand(['done', '无匹配']), context);
    expect(response.success).toBe(false);
    expect(response.message).toContain('未匹配到支线记录');
  });

  it('requires the hook for every sub-path and formats status', async () => {
    const noHook = makeContext();
    await expect(handleDiscuss(discussCommand(['问题']), noHook)).resolves.toMatchObject({ success: false });
    await expect(handleDiscuss(discussCommand(['done', '结论']), noHook)).resolves.toMatchObject({ success: false });
    await expect(handleDiscuss(discussCommand(['status']), noHook)).resolves.toMatchObject({ success: false });

    const list = vi.fn().mockResolvedValue([
      { id: 'side-1', title: '追查登录失败', venue: 'message-thread' as const, anchorMessageId: 'om_trigger', createdAt: '2026-11-06T00:00:00.000Z', status: 'open' as const },
      { id: 'side-2', title: '旁白方案', venue: 'delegated-group' as const, createdAt: '2026-11-06T01:00:00.000Z', status: 'concluded' as const },
    ]);
    const context = makeContext({ sideDiscussions: { open: vi.fn(), conclude: vi.fn(), list } });
    const response = await handleDiscuss(discussCommand(['status']), context);
    expect(response.success).toBe(true);
    expect(response.message).toContain('side-1');
    expect(response.message).toContain('进行中');
    expect(response.message).toContain('已回流');
    expect(list).toHaveBeenCalledWith('oc_main');
  });

  it('never pauses the main line: open and done touch no agentPool method', async () => {
    const open = vi.fn<NonNullable<ControlHandlerContext['sideDiscussions']>['open']>()
      .mockResolvedValue({ ok: true, message: '已开支线 side-1' });
    const context = makeContext({
      agentPool: { reset: vi.fn(), stop: vi.fn(), resetThread: vi.fn(), stopThread: vi.fn(), steer: vi.fn() },
      sideDiscussions: { open, conclude: vi.fn().mockResolvedValue({ ok: true, message: '已回流' }), list: vi.fn().mockResolvedValue([]) },
    });
    await handleDiscuss(discussCommand(['追查问题']), context);
    await handleDiscuss(discussCommand(['done', 'side-1', '结论']), context);
    expect(context.agentPool.reset).not.toHaveBeenCalled();
    expect(context.agentPool.stop).not.toHaveBeenCalled();
    expect(context.agentPool.resetThread).not.toHaveBeenCalled();
    expect(context.agentPool.stopThread).not.toHaveBeenCalled();
    expect(context.agentPool.steer).not.toHaveBeenCalled();
  });

  it('caps question and summary lengths', async () => {
    const context = makeContext({ sideDiscussions: { open: vi.fn(), conclude: vi.fn(), list: vi.fn().mockResolvedValue([]) } });
    const long = 'x'.repeat(501);
    await expect(handleDiscuss(discussCommand([long]), context)).resolves.toMatchObject({ success: false, message: expect.stringContaining('过长') });
    await expect(handleDiscuss(discussCommand(['done', 'y'.repeat(4001)]), context)).resolves.toMatchObject({ success: false, message: expect.stringContaining('过长') });
  });
});

describe('command registry', () => {
  it('registers /discuss gated on the sideDiscussions hook', () => {
    const definition = commandRegistry.find(entry => entry.type === 'discuss');
    expect(definition?.description).toContain('支线');
    const command = createControlCommand('discuss', 'oc_main', { args: ['问题'] }, { chatType: 'group' });
    expect(getAvailableCommands(makeContext(), command).map(entry => entry.type)).not.toContain('discuss');
    const wired = makeContext({ sideDiscussions: { open: vi.fn(), conclude: vi.fn(), list: vi.fn() } });
    expect(getAvailableCommands(wired, command).map(entry => entry.type)).toContain('discuss');
  });
});
