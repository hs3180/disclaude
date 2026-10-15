import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelCredentialErrors, resolveChannelCredential, withoutChannelCredentials, redactChannelSecrets } from './channel-credentials.js';
import type { DisclaudeConfig } from './types.js';

afterEach(() => vi.unstubAllEnvs());
describe('external channel credentials', () => {
  it.each(['$OWNED_CHANNEL_SECRET', '${OWNED_CHANNEL_SECRET}'])('resolves a whole reference (%s) without rewriting general config', reference => {
    vi.stubEnv('OWNED_CHANNEL_SECRET', 'synthetic-channel-canary');
    const config: DisclaudeConfig = { channels: { feishu: { appId: 'public-app-id', appSecret: reference } } };
    const original = JSON.stringify(config);
    expect(resolveChannelCredential(config, 'feishu', 'appId')).toBe('public-app-id');
    expect(resolveChannelCredential(config, 'feishu', 'appSecret')).toBe('synthetic-channel-canary');
    expect(JSON.stringify(config)).toBe(original);
    expect(original).not.toContain('synthetic-channel-canary');
  });

  it('applies the same syntax to every supported channel secret and public ID reference', () => {
    vi.stubEnv('OWNED_CHANNEL_ID', 'public-id'); vi.stubEnv('OWNED_CHANNEL_SECRET', 'synthetic-channel-canary');
    const config: DisclaudeConfig = { channels: {
      feishu: { appId: '$OWNED_CHANNEL_ID', appSecret: '$OWNED_CHANNEL_SECRET' },
      ruliu: { appKey: '$OWNED_CHANNEL_ID', appSecret: '$OWNED_CHANNEL_SECRET', checkToken: '${OWNED_CHANNEL_SECRET}', encodingAESKey: '$OWNED_CHANNEL_SECRET' },
      rest: { authToken: '$OWNED_CHANNEL_SECRET' },
    } };
    expect(channelCredentialErrors(config)).toEqual([]);
    for (const field of ['appSecret', 'checkToken', 'encodingAESKey']) {expect(resolveChannelCredential(config, 'ruliu', field)).toBe('synthetic-channel-canary');}
    expect(resolveChannelCredential(config, 'rest', 'authToken')).toBe('synthetic-channel-canary');
    expect(resolveChannelCredential(config, 'feishu', 'appId')).toBe('public-id');
  });

  it('rejects literals, shell syntax, interpolation, obsolete aliases and config-local secrets without echoing them', () => {
    for (const appSecret of ['literal-private-canary', '', '$MISSING/path', 'prefix-${KEY}', '$(print-private)', '${KEY:-private-fallback}']) {
      const errors = channelCredentialErrors({ channels: { feishu: { appSecret } } });
      expect(errors[0]).toContain('channels.feishu.appSecret');
      if (appSecret.length > 2) {expect(JSON.stringify(errors)).not.toContain(appSecret);}
    }
    expect(channelCredentialErrors({ channels: { feishu: { appSecretEnv: 'OWNED_CHANNEL_SECRET' } } })[0]).toContain('migrate');
    const config: DisclaudeConfig = { env: { OWNED_CHANNEL_SECRET: 'yaml-private-canary' }, channels: { rest: { authToken: '$OWNED_CHANNEL_SECRET' } } };
    vi.stubEnv('OWNED_CHANNEL_SECRET', 'external-canary');
    expect(() => resolveChannelCredential(config, 'rest', 'authToken')).toThrow('channels.rest.authToken');
    expect(JSON.stringify(channelCredentialErrors(config))).not.toContain('yaml-private-canary');
  });

  it('reports missing and blank references by field path without using config env fallback', () => {
    for (const value of [undefined, '', '   ']) {
      vi.stubEnv('OWNED_MISSING_SECRET', value);
      const config: DisclaudeConfig = { channels: { feishu: { appSecret: '$OWNED_MISSING_SECRET' } } };
      expect(() => resolveChannelCredential(config, 'feishu', 'appSecret')).toThrow('channels.feishu.appSecret: environment variable OWNED_MISSING_SECRET is missing or empty');
    }
  });

  it('strips channel authority from all harness environments and redacts serialized diagnostic strings', () => {
    vi.stubEnv('OWNED_PRIVATE_CHANNEL', 'synthetic-quoted-"channel-canary');
    const config: DisclaudeConfig = { channels: { rest: { authToken: '$OWNED_PRIVATE_CHANNEL' } } };
    const value = resolveChannelCredential(config, 'rest', 'authToken');
    expect(withoutChannelCredentials({ OWNED_PRIVATE_CHANNEL: value, MODEL_KEY: 'model-value',
      DISCLAUDE_SECRET_ENV_FILE: '/private/file', DISCLAUDE_API_TOKEN: 'proxy-token' })).toEqual({ MODEL_KEY: 'model-value', DISCLAUDE_API_TOKEN: 'proxy-token' });
    expect(withoutChannelCredentials({ OWNED_PRIVATE_CHANNEL: value })).not.toHaveProperty('OWNED_PRIVATE_CHANNEL');
    const logged = redactChannelSecrets(JSON.stringify({ err: { message: `failed ${value}`, config: { key: value } } }));
    expect(() => JSON.parse(logged)).not.toThrow();
    expect(logged).not.toContain('channel-canary');
    expect(logged).toContain('[REDACTED]');
  });

  it('redacts nested auth fields and short secrets without corrupting JSON booleans', () => {
    vi.stubEnv('OWNED_SHORT_SECRET', 'true');
    resolveChannelCredential({ channels: { rest: { authToken: '$OWNED_SHORT_SECRET' } } }, 'rest', 'authToken');
    const log = JSON.parse(redactChannelSecrets(JSON.stringify({ ok: true, message: 'value=true', nested: { headers: { authorization: 'Bearer unknown-derived-token' } } })));
    expect(log.ok).toBe(true);
    expect(log.message).toBe('value=[REDACTED]');
    expect(log.nested.headers.authorization).toBe('[REDACTED]');
  });
});
