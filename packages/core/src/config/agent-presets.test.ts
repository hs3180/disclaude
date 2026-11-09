import { describe, expect, it } from 'vitest';
import {
  backendLlmCompatibility,
  composeSessionPreset,
  isValidModelForBackend,
  resolveAgentPreset,
  switchableBackendsFor,
  validateAgentPresets,
} from './agent-presets.js';
import type { AgentPreset } from './types.js';

describe('validateAgentPresets', () => {
  it.each(['codex', 'dsh'])('requires a model for named %s presets', (agentBackend) => {
    for (const model of [undefined, '', '   ']) {
      expect(validateAgentPresets({ daily: { agentBackend, model } })).toEqual({
        ok: false, errors: ['agents.daily.model must be a non-empty string'],
      });
    }
  });
  it.each(['0', '1', '01', '4294967294'])('rejects numeric preset name %s', (name) => {
    expect(
      validateAgentPresets({ [name]: { agentBackend: 'claude', model: 'claude-sonnet' } })
    ).toMatchObject({ ok: false, errors: [expect.stringContaining('must not be numeric')] });
  });
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
      errors: ['agents.default.model must be a Codex/ChatGPT model identifier'],
    });
  });

  it('checks identifier shape without pinning a model generation', () => {
    expect(
      validateAgentPresets({ default: { agentBackend: 'codex', model: 'gpt-4.1' } })
    ).toMatchObject({ ok: true });
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
          'agents.default.agentBackend must be one of: claude, pi, codex, dsh, miniswe',
          'agents.default.model must be a non-empty string',
        ])
      );
    }
  });
});

describe('resolveAgentPreset', () => {
  it('returns a structured error for an empty map', () => {
    expect(resolveAgentPreset({})).toEqual({
      ok: false,
      error: 'agents must contain at least one named preset',
    });
  });

  it('does not silently reorder numeric preset names', () => {
    const preset = { agentBackend: 'claude' as const, model: 'claude-sonnet' };
    expect(resolveAgentPreset({ '2': preset, '1': preset })).toEqual({
      ok: false,
      error: 'agents preset names must not be numeric',
    });
  });
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

describe('orthogonal dimension switching helpers (Issue #5255)', () => {
  const anthropicBinding = { apiProtocol: 'anthropic' as const };
  const openaiBinding = { apiProtocol: 'openai' as const, apiBaseUrl: 'https://glm.example/v1' };

  describe('backendLlmCompatibility', () => {
    it('accepts claude only with an anthropic-protocol llm', () => {
      expect(backendLlmCompatibility('claude', anthropicBinding)).toEqual({ ok: true });
      expect(backendLlmCompatibility('claude', openaiBinding)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('anthropic-protocol'),
      });
    });

    it('lets pi serve any api protocol but requires a binding', () => {
      expect(backendLlmCompatibility('pi', anthropicBinding)).toEqual({ ok: true });
      expect(backendLlmCompatibility('pi', openaiBinding)).toEqual({ ok: true });
      expect(backendLlmCompatibility('pi', {})).toMatchObject({
        ok: false,
        reason: expect.stringContaining('api connection'),
      });
    });

    it('additionally requires an explicit baseUrl for dsh', () => {
      expect(backendLlmCompatibility('dsh', openaiBinding)).toEqual({ ok: true });
      expect(backendLlmCompatibility('dsh', { apiProtocol: 'openai' as const })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('baseUrl'),
      });
    });

    it('serves codex over an OpenAI-protocol api binding or its own ChatGPT login', () => {
      expect(backendLlmCompatibility('codex', {})).toEqual({ ok: true });
      // #5338: an llm api binding (OpenAI-protocol Responses endpoint) may serve codex.
      expect(backendLlmCompatibility('codex', openaiBinding)).toEqual({ ok: true });
      expect(backendLlmCompatibility('codex', anthropicBinding)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('OpenAI-compatible'),
      });
    });

    it('requires a full llm api connection for miniswe', () => {
      // #5006: endpoint/model/credentials live on the bound llm api.
      expect(backendLlmCompatibility('miniswe', openaiBinding)).toEqual({ ok: true });
      expect(backendLlmCompatibility('miniswe', { apiProtocol: 'openai' as const })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('miniswe'),
      });
    });
  });

  it('switchableBackendsFor lists every backend the binding can serve', () => {
    expect(switchableBackendsFor({ ...anthropicBinding, apiBaseUrl: 'http://127.0.0.1:9' })).toEqual(['claude', 'pi', 'dsh', 'miniswe']);
    expect(switchableBackendsFor(openaiBinding)).toEqual(['pi', 'codex', 'dsh', 'miniswe']);
    // without a baseUrl only the protocol-bound backends remain
    expect(switchableBackendsFor(anthropicBinding)).toEqual(['claude', 'pi']);
    // A codex-style singleton has no api binding to carry along.
    expect(switchableBackendsFor({})).toEqual(['codex']);
  });

  describe('isValidModelForBackend', () => {
    it('keeps the Codex/ChatGPT identifier shape for codex', () => {
      expect(isValidModelForBackend('codex', 'gpt-5.6')).toBe(true);
      expect(isValidModelForBackend('codex', ' gpt-6-luna ')).toBe(true);
      expect(isValidModelForBackend('codex', 'gpt-5')).toBe(false);
      expect(isValidModelForBackend('codex', 'claude-sonnet-4')).toBe(false);
    });

    it('passes provider-side identifiers through for the api-driven backends', () => {
      expect(isValidModelForBackend('claude', 'claude-sonnet-4')).toBe(true);
      expect(isValidModelForBackend('pi', 'glm-5.3')).toBe(true);
      expect(isValidModelForBackend('dsh', 'dsh-model')).toBe(true);
      expect(isValidModelForBackend('pi', '  ')).toBe(false);
    });
  });

  describe('composeSessionPreset', () => {
    const base: AgentPreset = {
      agentBackend: 'claude',
      llm: 'direct',
      model: 'claude-sonnet',
      apiKey: 'key',
      apiProtocol: 'anthropic',
      apiBaseUrl: 'http://127.0.0.1:2',
      reasoningEffort: 'high',
      modelOverrides: { high: 'claude-opus-4' },
    };

    it('returns the base unchanged without overrides', () => {
      expect(composeSessionPreset(base)).toBe(base);
      expect(composeSessionPreset(base, {})).toBe(base);
    });

    it('switches only the backend dimension and keeps the llm binding', () => {
      const composed = composeSessionPreset(base, { backendOverride: 'pi' });
      expect(composed).toEqual({
        ...base,
        agentBackend: 'pi',
        // claude-only model metadata must not leak onto another runtime
        modelOverrides: undefined,
      } as AgentPreset);
      expect(composed.model).toBe('claude-sonnet');
    });

    it('keeps claude model metadata when the override stays on claude', () => {
      expect(composeSessionPreset(base, { backendOverride: 'claude' }).modelOverrides).toBe(base.modelOverrides);
    });

    it('switches only the model dimension', () => {
      const composed = composeSessionPreset(base, { modelOverride: 'claude-haiku-4' });
      expect(composed.agentBackend).toBe('claude');
      expect(composed.model).toBe('claude-haiku-4');
      expect(composed.modelOverrides).toBe(base.modelOverrides);
      expect(composed.apiKey).toBe('key');
    });

    it('composes both dimensions independently', () => {
      const composed = composeSessionPreset(base, { backendOverride: 'codex', modelOverride: 'gpt-5.6' });
      expect(composed).toMatchObject({ agentBackend: 'codex', model: 'gpt-5.6', llm: 'direct' });
    });
  });
});
