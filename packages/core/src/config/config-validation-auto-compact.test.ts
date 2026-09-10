import { describe, expect, it } from 'vitest';
import { validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('agent.autoCompactWindow validation', () => {
  it.each([0, 64_000, 100_000])('accepts %s', (autoCompactWindow) => {
    expect(validateConfig({ agent: { autoCompactWindow } } as DisclaudeConfig)).toBe(true);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])('rejects %s', (autoCompactWindow) => {
    expect(validateConfig({ agent: { autoCompactWindow } } as DisclaudeConfig)).toBe(false);
  });
});
