import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { privateSdkSettings } from './private-settings.js';

describe('privateSdkSettings', () => {
  it('routes API-key settings into a 0600 private file', () => {
    const { options, cleanup } = privateSdkSettings({
      settings: { env: { ANTHROPIC_API_KEY: 'selected-key' } },
    });
    try {
      expect(typeof options.settings).toBe('string');
      expect(JSON.parse(readFileSync(options.settings as string, 'utf8'))).toEqual({
        env: { ANTHROPIC_API_KEY: 'selected-key' },
      });
      expect(statSync(options.settings as string).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
    }
  });

  it('routes modelOverrides into the private file without an API key (Issue #5410)', () => {
    const { options, cleanup } = privateSdkSettings({
      settings: { modelOverrides: { 'claude-opus-5': 'kimi-k3' } },
    });
    try {
      expect(typeof options.settings).toBe('string');
      expect(JSON.parse(readFileSync(options.settings as string, 'utf8'))).toEqual({
        modelOverrides: { 'claude-opus-5': 'kimi-k3' },
      });
      expect(statSync(options.settings as string).mode & 0o777).toBe(0o600);
      cleanup();
      expect(() => readFileSync(options.settings as string, 'utf8')).toThrow();
    } finally {
      cleanup();
    }
  });

  it('keeps unrelated inline settings untouched', () => {
    const { options, cleanup } = privateSdkSettings({
      settings: { teammateMode: 'in-process' },
    });
    expect(options.settings).toEqual({ teammateMode: 'in-process' });
    cleanup();
  });

  it('leaves options without settings alone', () => {
    const { options, cleanup } = privateSdkSettings({ model: 'kimi-k3' });
    expect(options).toEqual({ model: 'kimi-k3' });
    cleanup();
  });
});
