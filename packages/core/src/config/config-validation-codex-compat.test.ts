import { describe, expect, it, vi } from 'vitest';
import { isCodexModel, validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('Codex backend compatibility (Issue #4637)', () => {
  it('accepts gpt-5 Codex model identifiers and rejects provider models', () => {
    expect(isCodexModel('gpt-5')).toBe(true);
    expect(isCodexModel('gpt-5.1-codex')).toBe(true);
    expect(isCodexModel('gpt-5-codex-mini')).toBe(true);
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
});
