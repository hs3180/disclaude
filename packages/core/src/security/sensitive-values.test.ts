import { describe, expect, it } from 'vitest';
import { protectSensitiveValues, redactDeclaredSensitive, SensitiveOutputFilter } from './sensitive-values.js';

describe('harness-declared sensitive values', () => {
  it('does not infer sensitivity from names or token-shaped content', () => {
    const input = { password: 'public-example', text: 'ghs_publicexample123' };
    expect(redactDeclaredSensitive(input)).toEqual(input);
    const release = protectSensitiveValues(['opaque value chosen by the harness']);
    try {
      expect(redactDeclaredSensitive({ arbitrary: 'prefix opaque value chosen by the harness suffix' }))
        .toEqual({ arbitrary: 'prefix [REDACTED] suffix' });
    } finally {release();}
  });
  it('preserves overlapping declaration owners and hides nested errors without mutation', () => {
    const one = protectSensitiveValues(['declared-secret']);
    const two = protectSensitiveValues(['declared-secret']);
    const input = new Error('failed: declared-secret', { cause: { value: 'declared-secret' } });
    one(); one();
    expect(JSON.stringify(redactDeclaredSensitive(input))).not.toContain('declared-secret');
    expect(input.message).toContain('declared-secret');
    two();
    expect(redactDeclaredSensitive('declared-secret')).toBe('declared-secret');
  });
  it('does not reinterpret replacement markers as sensitive source text', () => {
    const release = protectSensitiveValues(['secret', 'REDACTED']);
    try {expect(redactDeclaredSensitive('secret REDACTED')).toBe('[REDACTED] [REDACTED]');}
    finally {release();}
  });
  it('protects exact declared values across every chunk boundary, including newlines', () => {
    const secret = 'opaque\\credential\nvalue';
    const input = `before ${secret} after`;
    for (let split = 0; split <= input.length; split++) {
      const output: string[] = [];
      const filter = new SensitiveOutputFilter([secret], text => output.push(text));
      filter.write(input.slice(0, split)); filter.write(input.slice(split)); filter.finish(); filter.finish();
      expect(output.join('')).toBe('before [REDACTED] after');
    }
  });
  it('leaves undeclared output intact and prefers the full overlapping declaration', () => {
    const output: string[] = [];
    const filter = new SensitiveOutputFilter(['alpha', 'alphabet'], text => output.push(text));
    filter.write('alphabet public-token'); filter.finish();
    expect(output.join('')).toBe('[REDACTED] public-token');
  });
});
