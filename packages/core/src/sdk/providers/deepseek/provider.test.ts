import { describe, expect, it } from 'vitest';
import { DeepSeekHarnessProvider } from './provider.js';

describe('DeepSeekHarnessProvider (Issue #4741)', () => {
  it('reports missing credentials before the transport starts', () => {
    const provider = new DeepSeekHarnessProvider({ env: {} });

    expect(provider.validateConfig()).toBe(false);
    expect(provider.getInfo()).toMatchObject({
      name: 'deepseek',
      available: false,
      unavailableReason: expect.stringContaining('DEEPSEEK_API_KEY'),
    });
  });

  it('accepts an API key and an existing isolated DSH_HOME', () => {
    const provider = new DeepSeekHarnessProvider({
      env: { DEEPSEEK_API_KEY: 'test-key' },
      dshHome: process.cwd(),
    });

    expect(provider.validateConfig()).toBe(true);
    expect(provider.getInfo()).toMatchObject({
      name: 'deepseek',
      version: '0.0.0-harness-preview',
      available: true,
    });
  });

  it('does not pretend that the unimplemented transport is usable', () => {
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key' });

    expect(() => provider.queryStream((async function* () {})() as never, {} as never)).toThrow(
      /stdio transport is not enabled yet/
    );
  });

  it('becomes unavailable after disposal', () => {
    const provider = new DeepSeekHarnessProvider({ apiKey: 'test-key' });

    provider.dispose();

    expect(provider.validateConfig()).toBe(false);
  });
});
