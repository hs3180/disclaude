import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePiModel } from './production-runtime.js';

afterEach(() => vi.unstubAllEnvs());
describe('pi model and credential isolation', () => {
  it('uses each query endpoint/model/key without mutating process state', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-key');
    const first = resolvePiModel({
      settingSources: [],
      model: 'model-a',
      env: {
        ANTHROPIC_API_KEY: 'key-a',
        ANTHROPIC_BASE_URL: 'https://example.com/anthropic',
      },
    });
    const second = resolvePiModel({
      settingSources: [],
      model: 'model-b',
      env: {
        ANTHROPIC_API_KEY: 'key-b',
        ANTHROPIC_BASE_URL: 'https://example.org',
      },
    });
    expect(first.apiKey).toBe('key-a');
    expect(first.model).toMatchObject({
      id: 'model-a',
      api: 'anthropic-messages',
      baseUrl: 'https://example.com/anthropic',
    });
    expect(second.apiKey).toBe('key-b');
    expect(second.model.id).toBe('model-b');
    expect(process.env.ANTHROPIC_API_KEY).toBe('host-key');
  });
  it('requests an output budget large enough for reasoning plus an answer', () => {
    // Regression guard for the 2026-09-22 truncation: at maxTokens 4096 a
    // reasoning-heavy turn (`deepseek-flash` always emits a `thinking` block)
    // spent the whole budget on reasoning and returned no text block, so the
    // user got no reply. Asserted as a floor rather than an exact value so a
    // future raise stays free — see resolvePiModel's JSDoc for how pi-ai clamps
    // this against contextWindow.
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-key');
    const { model } = resolvePiModel({
      settingSources: [],
      model: 'deepseek-flash',
      env: { ANTHROPIC_API_KEY: 'key', ANTHROPIC_BASE_URL: 'https://example.com' },
    });
    expect(model.maxTokens).toBeGreaterThanOrEqual(8192);
    expect(model.contextWindow).toBeGreaterThan(model.maxTokens as number);
  });
  it('rejects missing configuration and non-HTTP endpoints', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(() => resolvePiModel({ settingSources: [], model: 'm' })).toThrow('ANTHROPIC_API_KEY');
    expect(() =>
      resolvePiModel({
        settingSources: [],
        model: 'm',
        env: {
          ANTHROPIC_API_KEY: 'k',
          ANTHROPIC_BASE_URL: 'file:///tmp/model',
        },
      })
    ).toThrow('HTTP(S)');
  });
});
