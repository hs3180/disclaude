import { describe, expect, it, vi } from 'vitest';
import { handleAgent } from './agent.js';
import type { ControlHandlerContext } from '../types.js';

function context(overrides: Partial<ControlHandlerContext['agentPool']> = {}): ControlHandlerContext {
  return {
    agentPool: {
      reset: vi.fn(), stop: vi.fn(),
      listAgentPresets: () => [
        { name: 'default', agentBackend: 'claude', model: 'claude-sonnet' },
        { name: 'fast', agentBackend: 'pi', model: 'glm-fast' },
      ],
      getActiveAgentPreset: () => ({ name: 'default', agentBackend: 'claude', model: 'claude-sonnet' }),
      switchAgentPreset: () => ({ ok: true, active: { name: 'fast', agentBackend: 'pi', model: 'glm-fast' }, sessionBoundary: 'new-session' }),
      ...overrides,
    },
    debugGroups: { getDebugGroup: () => null, setDebugGroup: vi.fn(), clearDebugGroup: () => null },
  };
}

describe('/agent', () => {
  it('lists configured presets and marks the active one', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'list' } }, context());
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('→ **default** — claude / claude-sonnet');
    expect(result.message).toContain('**fast** — pi / glm-fast');
  });

  it('reports the fresh-session and process-lifetime boundaries after switching', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'use', preset: 'fast' } }, context());
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('pi / glm-fast');
    expect(result.message).toContain('context is not migrated');
    expect(result.message).toContain('service restarts');
  });

  it('gives an executable next step after a failed switch without claiming the selection changed', async () => {
    const result = await handleAgent(
      { type: 'agent', chatId: 'a', data: { subcommand: 'use', preset: 'missing' } },
      context({ switchAgentPreset: () => ({ ok: false, error: 'Unknown agent preset: missing' }) })
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown agent preset: missing');
    expect(result.message).toContain('current selection is unchanged');
    expect(result.message).toContain('`/agent list`');
    expect(result.message).toContain('`/agent use <name>`');
    expect(result.message).not.toContain('✅');
  });

  it('keeps recovery guidance within the actor and topic permissions', async () => {
    const ctx = context({ switchAgentPreset: () => ({ ok: false, error: 'Unknown agent preset: missing' }) });
    ctx.isCommandAllowed = vi.fn(command => command.data?.subcommand !== 'list');
    const result = await handleAgent({
      type: 'agent', chatId: 'a', actorId: 'restricted-user', threadRootId: 'topic', chatType: 'topic',
      data: { subcommand: 'use', preset: 'missing' },
    }, ctx);
    expect(ctx.isCommandAllowed).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent', chatId: 'a', actorId: 'restricted-user', threadRootId: 'topic', chatType: 'topic',
      data: { subcommand: 'list' },
    }));
    expect(result.success).toBe(false);
    expect(result.message).toContain('service maintainer');
    expect(result.message).not.toMatch(/\/agent|claude-sonnet|glm-fast/);
  });
  it('requires an explicitly configured admin actor for binding queries and records denials', async () => {
    const ctx = context({
      getAgentBinding: vi.fn(() => ({ chatId: 'target', presetName: 'fast', updatedBy: 'ou_admin', updatedAt: '2026-11-05T00:00:00Z' })),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    ctx.logger = logger as never;
    const result = await handleAgent({
      type: 'agent', chatId: 'admin-chat', actorId: 'ou_other', data: { subcommand: 'binding', targetChatId: 'target' },
    }, ctx);
    expect(result.success).toBe(false);
    expect(result.message).toContain('messaging.admin.actorIds');
    expect(ctx.agentPool.getAgentBinding).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      audit: 'agent-binding', action: 'binding', allowed: false, outcome: 'denied', actorId: 'ou_other', targetChatId: 'target',
    }), expect.any(String));
  });

  it('binds, queries and clears durable chat bindings with an actor audit', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const setBinding = vi.fn((): { ok: true; binding: { chatId: string; presetName: string; updatedBy: string; updatedAt: string } } => ({ ok: true, binding: { chatId: 'target', presetName: 'fast', updatedBy: 'ou_admin', updatedAt: '2026-11-05T00:00:00Z' } }));
    const clearBinding = vi.fn((): { ok: true; binding: { chatId: string; presetName: string; updatedBy: string; updatedAt: string } } => ({ ok: true, binding: { chatId: 'target', presetName: 'fast', updatedBy: 'ou_admin', updatedAt: '2026-11-05T00:00:00Z' } }));
    const ctx = context({
      setAgentBinding: setBinding,
      clearAgentBinding: clearBinding,
      getAgentBinding: vi.fn(() => ({ chatId: 'target', presetName: 'fast', updatedBy: 'ou_admin', updatedAt: '2026-11-05T00:00:00Z' })),
    });
    ctx.agentBindingAdmin = { isAdminActor: actorId => actorId === 'ou_admin' };
    ctx.logger = logger as never;
    const bind = await handleAgent({
      type: 'agent', chatId: 'admin-chat', actorId: 'ou_admin', data: { subcommand: 'bind', targetChatId: 'target', preset: 'fast' },
    }, ctx);
    expect(bind.success).toBe(true);
    expect(bind.message).toContain('next message');
    expect(setBinding).toHaveBeenCalledWith('target', 'fast', 'ou_admin');
    const query = await handleAgent({ type: 'agent', chatId: 'admin-chat', actorId: 'ou_admin', data: { subcommand: 'binding', targetChatId: 'target' } }, ctx);
    expect(query.message).toContain('**fast**');
    const clear = await handleAgent({ type: 'agent', chatId: 'admin-chat', actorId: 'ou_admin', data: { subcommand: 'unbind', targetChatId: 'target' } }, ctx);
    expect(clear.success).toBe(true);
    expect(clearBinding).toHaveBeenCalledWith('target');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      audit: 'agent-binding', action: 'bind', allowed: true, outcome: 'applied', targetChatId: 'target', presetName: 'fast',
    }), expect.any(String));
  });
});
