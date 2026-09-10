import { describe, expect, it } from 'vitest';
import { validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('validateConfig — named agent presets (S01)', () => {
  it('accepts a valid agents map', () => {
    expect(validateConfig({
      agents: {
        default: { agentBackend: 'claude', model: 'claude-sonnet' },
        codex: { agentBackend: 'codex', model: 'gpt-5.6' },
      },
    })).toBe(true);
  });

  it('keeps legacy single-agent configuration valid', () => {
    expect(validateConfig({ agent: { agentBackend: 'pi', model: 'glm-5' } } as DisclaudeConfig)).toBe(true);
    expect(validateConfig({} as DisclaudeConfig)).toBe(true);
  });

  it('accepts an unmarked map and rejects multiple defaults', () => {
    expect(validateConfig({ agents: {
      codex: { agentBackend: 'codex', model: 'gpt-5.6' },
    } })).toBe(true);
    expect(validateConfig({ agents: {
      default: { agentBackend: 'claude', model: 'claude-sonnet' },
      fast: { agentBackend: 'pi', model: 'glm-5', default: true },
    } })).toBe(false);
  });
});
