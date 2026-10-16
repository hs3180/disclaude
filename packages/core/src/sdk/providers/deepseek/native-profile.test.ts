import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDshNativeProfileOverlay,
  DSH_API_CREDENTIAL_ENV,
  dshApiProvider,
} from './native-profile.js';

describe('DSH bound LLM API overlay', () => {
  it.each([undefined, 'llm-pi-ai'])('mounts or reuses the native compaction components (%s)', adapter => {
    const api = { protocol: 'openai' as const, baseUrl: 'https://selected.example/v1', model: 'selected' };
    const overlay = createDshNativeProfileOverlay(api, [], adapter, {
      auto: true, source: 'configured', contextWindow: 60_000, thresholdRatio: 0.8,
    });
    try {
      const patch = JSON.parse(readFileSync(overlay.path, 'utf8'));
      const inserted = patch.find((entry: { insert?: unknown[] }) => entry.insert).insert;
      const all = [...patch.filter((entry: { id?: string }) => entry.id), ...inserted];
      expect(all.filter(entry => /compaction-basic$/.test(entry.id))).toHaveLength(1);
      expect(all.filter(entry => /token-meter$/.test(entry.id))).toHaveLength(1);
      expect(all.find(entry => /compaction-basic$/.test(entry.id)).config).toMatchObject({ auto: true, thresholdRatio: 0.8 });
      const route = all.find(entry => entry.config?.providers).config.providers[dshApiProvider(api)];
      expect(route.models[0].contextWindow).toBe(60_000);
    } finally { overlay.dispose(); }
  });

  it('augments the pinned standard SDK adapter instead of registering it twice', () => {
    const overlay = createDshNativeProfileOverlay(
      { protocol: 'openai', baseUrl: 'https://api.example', model: 'model' },
      [],
      'llm-pi-ai'
    );
    try {
      const patch = JSON.parse(readFileSync(overlay.path, 'utf8'));
      expect(patch.some((entry: { id?: string }) => entry.id === 'llm-pi-ai')).toBe(true);
      expect(patch.find((entry: { insert?: unknown[] }) => entry.insert).insert).toHaveLength(1);
    } finally {
      overlay.dispose();
    }
  });

  it('inspects native !!js metadata without evaluating expressions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-test-'));
    const file = join(dir, 'cordis.yml');
    writeFileSync(
      file,
      '- id: existing-api\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    value: !!js process.exit(99)\n'
    );
    const overlay = createDshNativeProfileOverlay(
      { protocol: 'openai', baseUrl: 'https://api.example', model: 'model' },
      [file]
    );
    try {
      expect(
        JSON.parse(readFileSync(overlay.path, 'utf8')).some(
          (entry: { id?: string }) => entry.id === 'existing-api'
        )
      ).toBe(true);
    } finally {
      overlay.dispose();
      rmSync(dir, { recursive: true });
    }
  });

  it('keeps protocol, endpoint and model routes distinct across persisted sessions', () => {
    const selected = {
      protocol: 'openai' as const,
      baseUrl: 'https://api.example/v1',
      model: 'test-model',
    };
    const route = dshApiProvider(selected);
    expect(dshApiProvider({ ...selected })).toBe(route);
    for (const api of [
      { ...selected, protocol: 'anthropic' as const },
      { ...selected, baseUrl: 'https://other.example/v1' },
      { ...selected, model: 'other-model' },
    ]) {
      expect(dshApiProvider(api)).not.toBe(route);
    }
  });
  it.each(['openai', 'anthropic'] as const)(
    'registers the selected %s connection with a credential reference only',
    (protocol) => {
      const overlay = createDshNativeProfileOverlay({
        protocol,
        baseUrl: 'https://api.example/v1',
        model: 'test-model',
      });
      try {
        const patch = JSON.parse(readFileSync(overlay.path, 'utf8'));
        const plugins = patch.find((entry: { insert?: unknown[] }) => entry.insert).insert;
        expect(
          plugins[0].config.providers[
            dshApiProvider({ protocol, baseUrl: 'https://api.example/v1', model: 'test-model' })
          ]
        ).toEqual({
          api: protocol === 'openai' ? 'openai-completions' : 'anthropic-messages',
          baseURL: 'https://api.example/v1',
          apiKeyEnv: DSH_API_CREDENTIAL_ENV,
          models: [{ id: 'test-model', name: 'test-model', input: ['text'] }],
        });
        expect(statSync(overlay.path).mode & 0o777).toBe(0o600);
        expect(patch[0]).toEqual({ id: 'sdk-jsonrpc-server', disabled: true });
      } finally {
        overlay.dispose();
      }
    }
  );

  it('augments an existing adapter without copying its private configuration or changing the profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-test-'));
    const file = join(dir, 'cordis.patch.yml');
    const original = JSON.stringify([
      {
        insert: [
          {
            id: 'existing-api',
            name: '@deepseek-ai/dsh-llm-pi-ai',
            config: { privateValue: 'private-test-value' },
          },
        ],
      },
    ]);
    writeFileSync(file, original);
    const overlay = createDshNativeProfileOverlay(
      { protocol: 'openai', baseUrl: 'https://selected.example/v1', model: 'selected' },
      [file]
    );
    try {
      const text = readFileSync(overlay.path, 'utf8');
      const patch = JSON.parse(text);
      expect(patch.find((entry: { id?: string }) => entry.id === 'existing-api')).toMatchObject({
        disabled: false,
        config: {
          providers: {
            [dshApiProvider({
              protocol: 'openai',
              baseUrl: 'https://selected.example/v1',
              model: 'selected',
            })]: { baseURL: 'https://selected.example/v1' },
          },
        },
      });
      expect(patch.find((entry: { insert?: unknown[] }) => entry.insert).insert).toHaveLength(1);
      expect(text).not.toContain('private-test-value');
      expect(readFileSync(file, 'utf8')).toBe(original);
    } finally {
      overlay.dispose();
      rmSync(dir, { recursive: true });
    }
  });

  it('does not include private YAML content in parsing errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-test-'));
    const file = join(dir, 'cordis.patch.yml');
    writeFileSync(file, '[private-test-value');
    try {
      expect(() =>
        createDshNativeProfileOverlay(
          { protocol: 'openai', baseUrl: 'https://api.example', model: 'model' },
          [file]
        )
      ).toThrow('Cannot read the selected DSH profile composition');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
