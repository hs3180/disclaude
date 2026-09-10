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
