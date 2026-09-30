import { describe, expect, it, vi } from 'vitest';
import { isCodexModel, validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('Codex backend compatibility (Issue #4637)', () => {
  it('accepts gpt-5 Codex model identifiers and rejects provider models', () => {
    expect(isCodexModel('gpt-5')).toBe(false);
    expect(isCodexModel('gpt-5.1-codex')).toBe(true);
    expect(isCodexModel('gpt-5-codex-mini')).toBe(true);
    expect(isCodexModel('gpt-6-codex')).toBe(true);
    expect(isCodexModel('gpt-6.1')).toBe(true);
    expect(isCodexModel('gpt-10-codex-mini')).toBe(true);
    expect(isCodexModel('gpt-4.1')).toBe(false);
    expect(isCodexModel('gpt-6')).toBe(false);
    expect(isCodexModel('claude-sonnet-4-20250514')).toBe(false);
    expect(isCodexModel('glm-5')).toBe(false);
  });

  it('rejects a non-Codex model at config-load time', () => {
    expect(validateConfig({ agent: { agentBackend: 'codex', model: 'claude-sonnet-4' } } as DisclaudeConfig)).toBe(false);
  });

  it('keeps legacy provider fields valid but warns that Codex ignores them', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(validateConfig({
      agent: { agentBackend: 'codex', provider: 'glm', model: 'gpt-5.1' },
      glm: { apiKey: 'secret', model: 'glm-5' },
    } as DisclaudeConfig)).toBe(true);
    spy.mockRestore();
  });

  it('validates the Codex reasoning-effort vocabulary and accepts current extended levels', () => {
    for (const reasoningEffort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(validateConfig({ agent: {
        agentBackend: 'codex', codex: { reasoningEffort },
      } } as DisclaudeConfig)).toBe(true);
    }
    expect(validateConfig({ agent: {
      agentBackend: 'codex', codex: { reasoningEffort: 'turbo' },
    } } as unknown as DisclaudeConfig)).toBe(false);
  });

  it('validates the selected model and reasoning effort environment overrides', () => {
    vi.stubEnv('CODEX_MODEL', 'claude-sonnet-4');
    expect(validateConfig({ agent: { agentBackend: 'codex' } } as DisclaudeConfig)).toBe(false);
    vi.stubEnv('CODEX_MODEL', 'gpt-5.6-luna');
    vi.stubEnv('CODEX_REASONING_EFFORT', 'turbo');
    expect(validateConfig({ agent: { agentBackend: 'codex' } } as DisclaudeConfig)).toBe(false);
    vi.unstubAllEnvs();
  });

  it('accepts configured environment fallbacks when process overrides are blank', () => {
    vi.stubEnv('CODEX_MODEL', '');
    vi.stubEnv('CODEX_REASONING_EFFORT', '');
    expect(validateConfig({
      env: { CODEX_MODEL: 'gpt-5.6-luna', CODEX_REASONING_EFFORT: 'high' },
      agent: { agentBackend: 'codex' },
    } as DisclaudeConfig)).toBe(true);
    vi.unstubAllEnvs();
  });
});
