/**
 * Tests for validateConfig() — agent.agentBackend validation (Issue #4388).
 *
 * agentBackend selects the agent SDK runtime (claude-code vs pi.dev) and is
 * orthogonal to the model-layer `provider`. validateConfig must accept the
 * known backends (and undefined = default 'claude') and reject anything else
 * at config-load time, so an invalid value never reaches the boot wiring.
 */
import { describe, it, expect } from 'vitest';
import { validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('validateConfig — agent.agentBackend (Issue #4388)', () => {
  it('accepts "claude", "pi" and "codex"', () => {
    expect(validateConfig({ agent: { agentBackend: 'claude' } } as DisclaudeConfig)).toBe(true);
    expect(validateConfig({ agent: { agentBackend: 'pi' } } as DisclaudeConfig)).toBe(true);
    // 'codex' registered in #4629 (S1 of #4627) — Codex CLI backend.
    expect(validateConfig({ agent: { agentBackend: 'codex' } } as DisclaudeConfig)).toBe(true);
  });

  it('accepts undefined (default backend)', () => {
    expect(validateConfig({ agent: {} } as DisclaudeConfig)).toBe(true);
    expect(validateConfig({} as DisclaudeConfig)).toBe(true);
  });

  it('rejects an unknown backend value', () => {
    expect(
      validateConfig({ agent: { agentBackend: 'mistral' } } as unknown as DisclaudeConfig),
    ).toBe(false);
    // Case-sensitive — "Claude" / "PI" are NOT valid
    expect(
      validateConfig({ agent: { agentBackend: 'Claude' } } as unknown as DisclaudeConfig),
    ).toBe(false);
    expect(
      validateConfig({ agent: { agentBackend: 'PI' } } as unknown as DisclaudeConfig),
    ).toBe(false);
    // Also case-sensitive for the codex backend (#4629)
    expect(
      validateConfig({ agent: { agentBackend: 'Codex' } } as unknown as DisclaudeConfig),
    ).toBe(false);
  });
});
