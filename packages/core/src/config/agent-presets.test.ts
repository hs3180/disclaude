import { describe, expect, it } from 'vitest';
import { resolveAgentPreset, validateAgentPresets } from './agent-presets.js';

describe('validateAgentPresets', () => {
  it('accepts the reserved default name and returns its effective preset', () => {
    const result = validateAgentPresets({
      default: { agentBackend: 'claude', model: 'claude-sonnet' },
      codex: { agentBackend: 'codex', model: 'gpt-5.6' },
    });
    expect(result).toEqual({
      ok: true,
      name: 'default',
      preset: { agentBackend: 'claude', model: 'claude-sonnet' },
    });
  });

  it('rejects a model that is incompatible with the selected backend', () => {
    const result = validateAgentPresets({
      default: { agentBackend: 'codex', model: 'claude-sonnet-4' },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'agents.default.model must be a Codex/ChatGPT model (expected gpt-5.x or newer)',
      ],
    });
  });

  it('accepts current and future Codex model generations', () => {
    expect(
      validateAgentPresets({ default: { agentBackend: 'codex', model: 'gpt-6-codex' } })
    ).toMatchObject({ ok: true });
    expect(
      validateAgentPresets({ default: { agentBackend: 'codex', model: 'gpt-10.1-codex' } })
    ).toMatchObject({ ok: true });
  });

  it('accepts one explicit default marker on a non-reserved name', () => {
    const result = validateAgentPresets({
      fast: { agentBackend: 'pi', model: 'glm-5', default: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe('fast');
    }
  });

  it('uses declaration order when no default is marked', () => {
    expect(
      validateAgentPresets({
        codex: { agentBackend: 'codex', model: 'gpt-5.6' },
        claude: { agentBackend: 'claude', model: 'claude-sonnet' },
      })
    ).toMatchObject({ ok: true, name: 'codex' });
  });

  it('rejects duplicate and conflicting defaults', () => {
    expect(
      validateAgentPresets({
        default: { agentBackend: 'claude', model: 'claude-sonnet' },
        fast: { agentBackend: 'pi', model: 'glm-5', default: true },
      })
    ).toMatchObject({ ok: false });
  });

  it('rejects unknown backends and empty models', () => {
    const result = validateAgentPresets({ default: { agentBackend: 'mistral', model: '' } });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          'agents.default.agentBackend must be one of: claude, pi, codex, deepseek',
          'agents.default.model must be a non-empty string',
        ])
      );
    }
  });
});

describe('resolveAgentPreset', () => {
  const agents = {
    default: { agentBackend: 'pi' as const, model: 'pi-default' },
    codex: { agentBackend: 'codex' as const, model: 'gpt-5' },
  };

  it('resolves the reserved default when no name is requested', () => {
    expect(resolveAgentPreset(agents)).toEqual({
      name: 'default',
      preset: agents.default,
      ok: true,
    });
  });

  it('resolves a named preset and trims user input', () => {
    expect(resolveAgentPreset(agents, ' codex ')).toEqual({
      name: 'codex',
      preset: agents.codex,
      ok: true,
    });
  });

  it('returns an actionable error for an unknown preset', () => {
    expect(resolveAgentPreset(agents, 'missing')).toEqual({
      ok: false,
      error: 'Unknown agent preset: missing',
    });
  });

  it('rejects an ambiguous default map instead of choosing silently', () => {
    expect(
      resolveAgentPreset({
        default: agents.default,
        fallback: { ...agents.codex, default: true },
      })
    ).toEqual({ ok: false, error: 'Unable to resolve default agent preset (found 2)' });
  });

  it('stably resolves the first preset when no default is marked', () => {
    const unmarked = {
      fast: { agentBackend: 'pi' as const, model: 'glm-5' },
      careful: { agentBackend: 'claude' as const, model: 'claude-sonnet' },
    };
    expect(resolveAgentPreset(unmarked)).toEqual({
      ok: true,
      name: 'fast',
      preset: unmarked.fast,
    });
  });
});
