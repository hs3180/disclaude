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

  it('offers the card picker first when a failed typed switch meets a channel with the native card', async () => {
    const ctx = context({ switchAgentPreset: () => ({ ok: false, error: 'Unknown agent preset: missing' }) });
    ctx.agentConfigUi = { openConfigCard: vi.fn() };
    const result = await handleAgent(
      { type: 'agent', chatId: 'a', actorId: 'ou_actor', data: { subcommand: 'use', preset: 'missing' } }, ctx);
    expect(result.success).toBe(false);
    // The card is the zero-recall recovery (no preset names to remember)…
    expect(result.message).toContain('`/agent config`');
    expect((result.message ?? '').indexOf('`/agent config`')).toBeLessThan((result.message ?? '').indexOf('`/agent list`'));
    // …and the command path remains as the alternative.
    expect(result.message).toContain('`/agent use <name>`');
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

  it('points at the native card from the current-profile report when the channel has one', async () => {
    const ctx = context();
    ctx.agentConfigUi = { openConfigCard: vi.fn() };
    const withCard = await handleAgent({ type: 'agent', chatId: 'a' }, ctx);
    expect(withCard.success).toBe(true);
    expect(withCard.message).toContain('`/agent config`');
    const withoutCard = await handleAgent({ type: 'agent', chatId: 'a' }, context());
    expect(withoutCard.message).not.toContain('`/agent config`');
  });

  describe('config (Issue #4914 native card)', () => {
    it('delegates to the channel hook with the command coordinates', async () => {
      const openConfigCard = vi.fn().mockResolvedValue({ ok: true });
      const ctx = context();
      ctx.agentConfigUi = { openConfigCard };
      const result = await handleAgent({
        type: 'agent', chatId: 'oc_1', actorId: 'ou_actor', threadRootId: 'om_topic',
        data: { subcommand: 'config' },
      }, ctx);
      expect(openConfigCard).toHaveBeenCalledExactlyOnceWith({
        chatId: 'oc_1', threadRootId: 'om_topic', actorId: 'ou_actor',
      });
      expect(result).toMatchObject({ success: true });
      expect(result.message).toContain('harness / model / thinking');
    });

    it('falls back to text-only guidance when the channel has no card hook', async () => {
      const result = await handleAgent(
        { type: 'agent', chatId: 'a', actorId: 'ou_actor', data: { subcommand: 'config' } },
        context()
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('`/agent list`');
      expect(result.message).toContain('`/agent use <name>`');
    });

    it('refuses to open a card without an identifiable actor', async () => {
      const openConfigCard = vi.fn();
      const ctx = context();
      ctx.agentConfigUi = { openConfigCard };
      const result = await handleAgent(
        { type: 'agent', chatId: 'a', data: { subcommand: 'config' } }, ctx);
      expect(openConfigCard).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.message).toContain('无法识别操作者');
    });

    it('surfaces a delivery failure with the text command as recovery', async () => {
      const ctx = context();
      ctx.agentConfigUi = { openConfigCard: vi.fn().mockResolvedValue({ ok: false, error: 'configuration card was not delivered' }) };
      const result = await handleAgent(
        { type: 'agent', chatId: 'a', actorId: 'ou_actor', data: { subcommand: 'config' } }, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('configuration card was not delivered');
      expect(result.message).toContain('`/agent use <name>`');
    });

    it('recovers from a hook exception without losing the text path', async () => {
      const ctx = context();
      ctx.agentConfigUi = { openConfigCard: vi.fn().mockRejectedValue(new Error('boom')) };
      const result = await handleAgent(
        { type: 'agent', chatId: 'a', actorId: 'ou_actor', data: { subcommand: 'config' } }, ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('`/agent list`');
      expect(result.error).toBe('boom');
    });
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
    // Issue #5255 combination: the session tier also covers the orthogonal
    // backend/model switches; the saved-choice/per-app/global chain is intact.
    expect(result.message).toContain("this session's switches (/agent use, backend, model)");
    expect(result.message).toContain("the chat's saved /agent use choice");
    expect(result.message).toContain('per-app default');
    expect(result.message).toContain('global default');
  });
});

describe('/agent orthogonal dimension switches (Issue #5255)', () => {
  it('switches the backend dimension and reports it as an override on the preset', async () => {
    const switchAgentBackend = vi.fn().mockReturnValue({
      ok: true,
      active: { name: 'default', agentBackend: 'pi', model: 'claude-sonnet', backendOverride: 'pi' },
      sessionBoundary: 'new-session',
    });
    const result = await handleAgent(
      { type: 'agent', chatId: 'a', data: { subcommand: 'backend', preset: 'pi', value: 'pi' } },
      context({ switchAgentBackend })
    );
    expect(switchAgentBackend).toHaveBeenCalledExactlyOnceWith('a', 'pi', undefined);
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('✅ Active agent: **default** — pi / claude-sonnet');
    expect(result.message).toContain('backend=pi');
    expect(result.message).toContain('context is not migrated');
    expect(result.message).toContain('service restarts');
  });

  it('switches the model dimension and shows both diverging dimensions', async () => {
    const switchAgentModel = vi.fn().mockReturnValue({
      ok: true,
      active: { name: 'default', agentBackend: 'pi', model: 'glm-5.3', backendOverride: 'pi', modelOverride: 'glm-5.3' },
      sessionBoundary: 'new-session',
    });
    const result = await handleAgent(
      { type: 'agent', chatId: 'a', threadRootId: 'topic', data: { subcommand: 'model', preset: 'glm-5.3', value: 'glm-5.3' } },
      context({ switchAgentModel })
    );
    expect(switchAgentModel).toHaveBeenCalledExactlyOnceWith('a', 'glm-5.3', 'topic');
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('backend=pi, model=glm-5.3');
  });

  it('answers an incompatible switch with the dimension options instead of a dead end', async () => {
    const result = await handleAgent(
      { type: 'agent', chatId: 'a', data: { subcommand: 'backend', preset: 'claude', value: 'claude' } },
      context({
        switchAgentBackend: () => ({
          ok: false,
          error: 'Cannot switch the backend to claude: the claude backend requires an anthropic-protocol llm provider.',
          options: ['pi'],
        }),
      })
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('anthropic-protocol');
    expect(result.message).toContain('Available backends: pi.');
    expect(result.message).toContain('current selection is unchanged');
    expect(result.message).not.toContain('✅');
  });

  it('lists usable models after a rejected model switch', async () => {
    const result = await handleAgent(
      { type: 'agent', chatId: 'a', data: { subcommand: 'model', preset: 'claude-sonnet', value: 'claude-sonnet' } },
      context({
        switchAgentModel: () => ({
          ok: false,
          error: 'Model "claude-sonnet" is not a valid codex model identifier.',
          options: ['gpt-5.6'],
        }),
      })
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('Available models: gpt-5.6.');
  });

  it('keeps both dimensions set by /agent use beside the single-dimension subcommands', async () => {
    const switchAgentPreset = vi.fn().mockReturnValue({
      ok: true,
      active: { name: 'fast', agentBackend: 'pi', model: 'glm-flash' },
      sessionBoundary: 'new-session',
    });
    const ctx = context({ switchAgentPreset });
    const use = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'use', preset: 'fast' } }, ctx);
    expect(use).toMatchObject({ success: true });
    expect(use.message).toContain('pi / glm-flash');
    expect(use.message).not.toContain('Overrides on top of the preset');
    // T-068 coexistence: `use` keeps its single-token argument surface while
    // backend/model dispatch independently on the same command.
    expect(ctx.agentPool.switchAgentPreset).toHaveBeenCalledExactlyOnceWith('a', 'fast', undefined, undefined);
  });

  it('degrades with a clear message when a dimension switcher is not wired', async () => {
    const missing = await handleAgent(
      { type: 'agent', chatId: 'a', data: { subcommand: 'backend', preset: 'pi', value: 'pi' } },
      context({ switchAgentBackend: undefined })
    );
    expect(missing).toMatchObject({ success: false });
    expect(missing.message).toContain('Switching the backend dimension is not available on this node.');
    const missingModel = await handleAgent(
      { type: 'agent', chatId: 'a', data: { subcommand: 'model', preset: 'x', value: 'x' } },
      context({ switchAgentModel: undefined })
    );
    expect(missingModel.message).toContain('Switching the model dimension is not available on this node.');
  });

  it('shows usage when a dimension is given without a value', async () => {
    const backend = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'backend' } }, context());
    expect(backend).toMatchObject({ success: false });
    expect(backend.message).toContain('Usage: `/agent backend <claude|pi|codex|dsh>`');
    const model = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'model' } }, context());
    expect(model.message).toContain('Usage: `/agent model <model-id>`');
  });

  it('surfaces both dimensions on /agent current', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'current' } }, context({
      getActiveAgentPreset: () => ({
        name: 'default', agentBackend: 'pi', model: 'glm-5.3',
        backendOverride: 'pi', modelOverride: 'glm-5.3',
      }),
    }));
    expect(result).toMatchObject({ success: true });
    expect(result.message).toContain('🤖 Active agent: **default** — pi / glm-5.3');
    expect(result.message).toContain('Overrides on top of the preset: backend=pi, model=glm-5.3.');
    expect(result.message).toContain('`/agent backend <name>`');
    expect(result.message).toContain('`/agent model <id>`');
  });

  it('keeps every subcommand in the usage line for unknown input', async () => {
    const result = await handleAgent({ type: 'agent', chatId: 'a', data: { subcommand: 'bogus' } }, context());
    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain('`/agent [current|list|use <preset>|backend <name>|model <id>|config]`');
  });
});
