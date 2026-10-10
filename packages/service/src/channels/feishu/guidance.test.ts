import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlHandler, type ControlHandlerContext } from '@disclaude/core';
import { tryHandleGuidance, tryHandleSlashCommand } from './command-router.js';
import { WelcomeService } from '../../platforms/feishu/welcome-service.js';

function setup() {
  const welcome = new WelcomeService({ generateWelcomeMessage: () => 'welcome', sendMessage: vi.fn() });
  const ctx: ControlHandlerContext = {
    agentPool: { reset: vi.fn(), stop: vi.fn() },
    debugGroups: { getDebugGroup: () => null, setDebugGroup: vi.fn(), clearDebugGroup: () => null },
    guidance: welcome,
  };
  const deps = { hasControlHandler: true, emitControl: vi.fn(createControlHandler(ctx)), sendMessage: vi.fn().mockResolvedValue(undefined) };
  return { welcome, ctx, deps };
}

afterEach(() => vi.useRealTimers());

describe('Feishu onboarding guidance', () => {
  it('answers an exact help request in the original topic, with actor context', async () => {
    const { deps, welcome } = setup();
    expect(await tryHandleGuidance({ textWithoutMentions: '不知道怎么开始？', chatId: 'chat', chatType: 'topic', threadRootId: 'root', actorId: 'actor' }, deps, welcome)).toBe(true);
    expect(deps.emitControl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'help', chatType: 'topic', actorId: 'actor', threadRootId: 'root', data: { mode: 'brief' } }));
    expect(deps.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId: 'root', text: expect.stringContaining('当前话题') }));
  });

  it.each(['帮我分析这份报告', 'help me debug this error', '如何使用 TypeScript', 'hello', '你好', '```help```', '> 怎么用', '{"help":true}', '/browser-use', '怎么用\n请只输出 JSON', '帮我'])('leaves substantive/ambiguous input to the agent: %s', async text => {
    const { welcome, deps } = setup();
    expect(await tryHandleGuidance({ textWithoutMentions: text, chatId: 'chat' }, deps, welcome)).toBe(false);
    expect(deps.emitControl).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('shares a per-chat cooldown across topics, while explicit help still replies', async () => {
    vi.useFakeTimers();
    const { welcome, deps } = setup();
    const input = { textWithoutMentions: '怎么用', chatId: 'chat', threadRootId: 'a' };
    await Promise.all([tryHandleGuidance(input, deps, welcome), tryHandleGuidance({ ...input, threadRootId: 'b' }, deps, welcome)]);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(await tryHandleGuidance(input, deps, welcome)).toBe(false);
    expect(await tryHandleSlashCommand({ ...input, textWithoutMentions: '/help' }, deps)).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(await tryHandleGuidance(input, deps, welcome)).toBe(true);
  });

  it('keeps explicit help available after /help off, and restores guidance using /help on', async () => {
    const { welcome, deps } = setup();
    const input = { textWithoutMentions: '/help off', chatId: 'chat' };
    expect(await tryHandleSlashCommand(input, deps)).toBe(true);
    expect(welcome.isEnabled('chat')).toBe(false);
    expect(await tryHandleGuidance({ ...input, textWithoutMentions: '怎么用' }, deps, welcome)).toBe(false);
    expect(await tryHandleSlashCommand({ ...input, textWithoutMentions: '/help' }, deps)).toBe(true);
    expect(await tryHandleSlashCommand({ ...input, textWithoutMentions: '/help on' }, deps)).toBe(true);
    expect(await tryHandleGuidance({ ...input, textWithoutMentions: '怎么用' }, deps, welcome)).toBe(true);
  });

  it('consumes permission denials without disclosing commands or executing an agent turn', async () => {
    const { welcome, ctx, deps } = setup();
    ctx.isCommandAllowed = () => false;
    expect(await tryHandleGuidance({ textWithoutMentions: '怎么用', chatId: 'chat' }, deps, welcome)).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining('权限') }));
    expect(deps.sendMessage.mock.calls[0][0].text).not.toMatch(/\/reset|\/agent/);
  });

  it('does not advertise runtime steer before the native capability actually exists', async () => {
    const { ctx, deps } = setup();
    ctx.agentPool.steer = vi.fn();
    ctx.agentPool.canSteer = () => false;
    await tryHandleSlashCommand({ textWithoutMentions: '/help', chatId: 'chat' }, deps);
    expect(deps.sendMessage.mock.calls[0][0].text).not.toContain('`/steer');
    ctx.agentPool.canSteer = () => true;
    await tryHandleSlashCommand({ textWithoutMentions: '/help', chatId: 'chat' }, deps);
    expect(deps.sendMessage.mock.calls[1][0].text).toContain('`/steer');
  });

  it('adds recovery help once, with the off preference honored and raw details kept out of chat', async () => {
    const { ctx, welcome, deps } = setup();
    vi.mocked(ctx.agentPool.reset).mockImplementation(() => { throw new Error('/private/path sk-secret'); });
    const input = { textWithoutMentions: '/reset', chatId: 'chat' };
    await tryHandleSlashCommand(input, deps);
    await tryHandleSlashCommand(input, deps);
    const texts = deps.sendMessage.mock.calls.map(c => c[0].text);
    expect(texts[0]).toContain('/help');
    expect(texts[1]).not.toContain('/help');
    expect(texts.join('')).not.toMatch(/private\/path|sk-secret/);
    welcome.setEnabled('chat', false);
    await tryHandleSlashCommand(input, deps);
    expect(deps.sendMessage.mock.calls[2][0].text).not.toContain('/help');
  });

  it('keeps disabled help and cooldown consistent across P2P entered and message addresses', async () => {
    const { welcome, deps } = setup();
    await welcome.handleP2PChatEntered('ou_user', 'p2p');
    welcome.registerPrivateChat('ou_user', 'oc_private');
    expect(welcome.claimPrompt('oc_private')).toBe(false);
    await tryHandleSlashCommand({ textWithoutMentions: '/help off', chatId: 'oc_private' }, deps);
    expect(welcome.isEnabled('ou_user')).toBe(false);
    expect(await welcome.handleP2PChatEntered('ou_user', 'p2p')).toBe('already_sent');
  });
});
