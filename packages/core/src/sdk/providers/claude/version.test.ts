import { describe, expect, it } from 'vitest';
import { bundledClaudeCodeVersion, lacksModelOverrides } from './version.js';

describe('bundled Claude Code version', () => {
  it('resolves the pinned SDK manifest', () => {
    expect(bundledClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([
    ['2.1.199', true],
    ['2.1.104', true],
    ['2.0.999', true],
    ['1.9.9', true],
    ['2.1.200', false],
    ['2.1.263', false],
    ['2.2.0', false],
    ['3.0.0', false],
    ['unknown', false],
    ['2.x', false],
  ])('gates modelOverrides on %s as %s', (version, expected) => {
    expect(lacksModelOverrides(version)).toBe(expected);
  });
});
