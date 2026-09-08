import { describe, expect, it } from 'vitest';
import { validateAgentPresets } from './agent-presets.js';

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

  it('accepts one explicit default marker on a non-reserved name', () => {
    const result = validateAgentPresets({
      fast: { agentBackend: 'pi', model: 'glm-5', default: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe('fast');
    }
  });

  it('rejects missing, duplicate, and conflicting defaults', () => {
    expect(
      validateAgentPresets({ codex: { agentBackend: 'codex', model: 'gpt-5.6' } })
    ).toMatchObject({ ok: false });
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
          'agents.default.agentBackend must be one of: claude, pi, codex',
          'agents.default.model must be a non-empty string',
        ])
      );
    }
  });
});
