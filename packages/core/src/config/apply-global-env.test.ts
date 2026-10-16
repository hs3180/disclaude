import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGlobalEnv } from './index.js';
import { setLoadedConfig } from './loader.js';
import type { LoadedConfig } from './types.js';

const key = '__DISCLAUDE_TEST_PROTECT_KEY__';
const configuration = (): LoadedConfig => ({ _fromFile: true,
  agents: { default: { backend: 'codex', llm: 'daily' } },
  llms: { daily: { model: 'gpt-6-luna' } }, env: { [key]: 'file-value' } });

describe('applyGlobalEnv with an owned configuration', () => {
  beforeEach(() => {vi.stubEnv(key, undefined); setLoadedConfig(configuration());});
  afterEach(() => {setLoadedConfig(null); vi.unstubAllEnvs();});

  it('applies configured variables without consulting user configuration', () => {
    applyGlobalEnv();
    expect(process.env[key]).toBe('file-value');
  });
  it('is idempotent', () => {
    applyGlobalEnv(); applyGlobalEnv();
    expect(process.env[key]).toBe('file-value');
  });
  it.each(['inherited-value', ''])('preserves an inherited value, including blank (%s)', value => {
    vi.stubEnv(key, value); applyGlobalEnv();
    expect(process.env[key]).toBe(value);
  });
  it('does not add variables when the selected config has no env section', () => {
    const config = configuration(); delete config.env; setLoadedConfig(config);
    applyGlobalEnv();
    expect(process.env[key]).toBeUndefined();
  });
  it('rejects config-local channel credentials before injecting any env values', () => {
    const config = configuration();
    config.channels = { rest: { authToken: `$${key}` } };
    setLoadedConfig(config);
    expect(() => applyGlobalEnv()).toThrow('channels.rest.authToken');
    expect(process.env[key]).toBeUndefined();
  });
});
