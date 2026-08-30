/**
 * Tests for validateConfig() — agent.codexSandbox validation (Issue #4631,
 * S4 of #4627). codexSandbox is the explicit codex exec sandbox override,
 * only meaningful with agentBackend: 'codex'; an invalid value must fail at
 * config-load time with the same UX as the agentBackend check (#4388).
 */
import { describe, it, expect } from 'vitest';
import { validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('validateConfig — agent.codexSandbox (Issue #4631)', () => {
  it('accepts the three codex sandbox levels', () => {
    expect(
      validateConfig({ agent: { codexSandbox: 'read-only' } } as DisclaudeConfig),
    ).toBe(true);
    expect(
      validateConfig({ agent: { codexSandbox: 'workspace-write' } } as DisclaudeConfig),
    ).toBe(true);
    expect(
      validateConfig({ agent: { codexSandbox: 'danger-full-access' } } as DisclaudeConfig),
    ).toBe(true);
  });

  it('accepts undefined (level derived from permissionMode at runtime)', () => {
    expect(validateConfig({ agent: {} } as DisclaudeConfig)).toBe(true);
    expect(validateConfig({} as DisclaudeConfig)).toBe(true);
  });

  it('rejects unknown or case-mangled values', () => {
    expect(
      validateConfig({ agent: { codexSandbox: 'full-access' } } as unknown as DisclaudeConfig),
    ).toBe(false);
    // Case-sensitive — codex config keys are kebab-case, "ReadOnly" is invalid
    expect(
      validateConfig({ agent: { codexSandbox: 'ReadOnly' } } as unknown as DisclaudeConfig),
    ).toBe(false);
  });

  it('composes with agentBackend: codex', () => {
    expect(
      validateConfig({
        agent: { agentBackend: 'codex', codexSandbox: 'workspace-write' },
      } as DisclaudeConfig),
    ).toBe(true);
  });
});
