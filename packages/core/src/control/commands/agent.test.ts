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

  it('reports the fresh-session boundary and the per-chat persistence after switching', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'use', preset: 'fast' } }, context());
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('pi / glm-fast');
    expect(result.message).toContain('context is not migrated');
    expect(result.message).toContain('saved for this chat');
    expect(result.message).toContain('survives service restarts');
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
  it('forwards the actor with the switch so the choice is saved for the chat (#5476)', async () => {
    const switchPreset = vi.fn((): { ok: true; active: { name: string; agentBackend: string; model: string }; sessionBoundary: 'new-session' } =>
      ({ ok: true, active: { name: 'fast', agentBackend: 'pi', model: 'glm-fast' }, sessionBoundary: 'new-session' }));
    const ctx = context({ switchAgentPreset: switchPreset });
    const result = await handleAgent({
      type: 'agent', chatId: 'a', actorId: 'ou_user', threadRootId: 'om_topic',
      data: { subcommand: 'use', preset: 'fast' },
    }, ctx);
    expect(result.success).toBe(true);
    expect(switchPreset).toHaveBeenCalledWith('a', 'fast', 'om_topic', 'ou_user');
  });

  it('documents the selection precedence chain on /agent current (#5476)', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'current' } }, context());
    expect(result.success).toBe(true);
    expect(result.message).toContain('/agent use (this session)');
    expect(result.message).toContain("the chat's saved /agent use choice");
    expect(result.message).toContain('per-app default');
    expect(result.message).toContain('global default');
  });

  it('shows thinking and origin on /agent current when the active profile carries them (#4913)', async () => {
    const result = await handleAgent(
      { type: 'agent', chatId: 'a', data: { subcommand: 'current' } },
      context({
        getActiveAgentPreset: () => ({
          name: 'researcher', agentBackend: 'codex', model: 'gpt-5.2-codex',
          thinking: 'high', origin: 'creation',
        }),
      })
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('thinking: high');
    expect(result.message).toContain('source: group creation binding');
  });

  it('renders identically when thinking/origin are absent (legacy presets)', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'current' } }, context());
    expect(result.success).toBe(true);
    expect(result.message).not.toContain('thinking:');
    expect(result.message).not.toContain('source:');
  });
});
