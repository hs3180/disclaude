import { afterEach, describe, expect, it, vi } from 'vitest';
import { secretConfigurationErrors } from './secret-references.js';
import { resolveConfiguredAgents, validateResolvedAgent } from './resolved-agents.js';
import { buildSdkEnv } from '../utils/sdk.js';
import { redactChannelSecrets } from './channel-credentials.js';
import { sanitizeDiagnosticText } from '../utils/diagnostic-text.js';
import { applyGlobalEnv } from './index.js';
import { setLoadedConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';
import { registerExternalSecretEnvironmentNames } from './secret-environment.js';

afterEach(() => { vi.unstubAllEnvs(); setLoadedConfig(null); });
const config = (): DisclaudeConfig => ({
  agents: { daily: { backend: 'codex', llm: 'native', default: true }, a: { backend: 'claude', llm: 'a' }, b: { backend: 'claude', llm: 'b' } },
  llms: { native: { model: 'gpt-6-luna' }, a: { model: 'a', api: { protocol: 'anthropic', baseUrl: 'https://a.example', apiKey: '$OPAQUE_A' } }, b: { model: 'b', api: { protocol: 'anthropic', baseUrl: 'https://b.example', apiKey: '$OPAQUE_B' } } },
});

describe('persistent external secrets', () => {
  it('masks and redacts opaque unused external-file sources, granting only selected mappings', () => {
    vi.stubEnv('OPAQUE_FILE_SOURCE', 'synthetic-opaque-file-canary');
    vi.stubEnv('OPAQUE_FILE_OVERRIDE', 'synthetic-opaque-inherited-canary');
    registerExternalSecretEnvironmentNames(['OPAQUE_FILE_SOURCE', 'OPAQUE_FILE_OVERRIDE']);
    const value = config();
    value.llms!.native.env = { TOOL_DATA: '$OPAQUE_FILE_SOURCE' };
    const result = resolveConfiguredAgents(value);
    expect(result.ok).toBe(true);
    if (!result.ok) {return;}
    for (const name of ['daily', 'a', 'b']) {
      const preset = result.presets[name];
      const env = buildSdkEnv(preset.apiKey, preset.apiBaseUrl, {}, false, undefined,
        { protocol: preset.apiProtocol, credentialEnvKeys: preset.credentialEnvKeys, selectedEnv: preset.env });
      expect(env.OPAQUE_FILE_SOURCE).toBeUndefined();
      expect(env.OPAQUE_FILE_OVERRIDE).toBeUndefined();
      expect(env.TOOL_DATA).toBe(name === 'daily' ? 'synthetic-opaque-file-canary' : undefined);
    }
    const log = redactChannelSecrets(JSON.stringify({ OPAQUE_FILE_SOURCE: 'synthetic-opaque-file-canary',
      msg: 'synthetic-opaque-file-canary synthetic-opaque-inherited-canary' }));
    const diagnostic = sanitizeDiagnosticText('synthetic-opaque-file-canary synthetic-opaque-inherited-canary');
    for (const canary of ['synthetic-opaque-file-canary', 'synthetic-opaque-inherited-canary']) {
      expect(log).not.toContain(canary);
      expect(diagnostic).not.toContain(canary);
    }
    expect(buildSdkEnv('', undefined, {}, false).OPAQUE_FILE_OVERRIDE).toBeUndefined();
  });

  it.each(['CUSTOM_TOKEN', 'JUPYTERLAB_PASS', 'SERVICE_PASSWORD', 'OPAQUE_A', 'AUTHORIZATION', 'COOKIE', 'CREDENTIALS', 'PGPASSWORD'])('rejects YAML env.%s, even when an inherited value would override it', key => {
    vi.stubEnv(key, 'external-value');
    const value = config(); value.env = { [key]: 'private-canary-not-to-print' };
    const errors = secretConfigurationErrors(value);
    expect(errors.join(' ')).toContain(`env.${key}`);
    expect(errors.join(' ')).not.toContain('private-canary-not-to-print');
    setLoadedConfig({ ...value, _fromFile: true });
    expect(() => applyGlobalEnv()).toThrow(`env.${key}`);
  });

  it('isolates two same-backend API bindings and native tool secrets, preserving public settings', () => {
    vi.stubEnv('OPAQUE_A', 'synthetic-private-a'); vi.stubEnv('OPAQUE_B', 'synthetic-private-b');
    vi.stubEnv('HOST_PASSWORD', 'synthetic-host-password'); vi.stubEnv('SELECTED_TOOL', 'synthetic-tool-value');
    vi.stubEnv('DISCLAUDE_API_TOKEN', 'owned-channel-control');
    const value = config();
    value.llms!.a.env = { TOOL_TOKEN: '$SELECTED_TOOL', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small-model' };
    const resolved = resolveConfiguredAgents(value); expect(resolved.ok).toBe(true);
    if (!resolved.ok) { throw new Error(resolved.errors.join('; ')); }
    for (const name of ['a', 'b', 'daily']) {
      const preset = resolved.presets[name];
      const env = buildSdkEnv(preset.apiKey, preset.apiBaseUrl, {}, false, undefined,
        { protocol: preset.apiProtocol, credentialEnvKeys: preset.credentialEnvKeys, selectedEnv: preset.env });
      expect(env.OPAQUE_A).toBeUndefined(); expect(env.OPAQUE_B).toBeUndefined(); expect(env.HOST_PASSWORD).toBeUndefined(); expect(env.SELECTED_TOOL).toBeUndefined();
      expect(env.DISCLAUDE_API_TOKEN).toBe('owned-channel-control');
      expect(env.TOOL_TOKEN).toBe(name === 'a' ? 'synthetic-tool-value' : undefined);
      expect(env.ANTHROPIC_API_KEY).toBe(name === 'daily' ? undefined : `synthetic-private-${name}`);
      expect(env.ANTHROPIC_BASE_URL).toBe(name === 'daily' ? undefined : `https://${name}.example`);
      if (name === 'a') {expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('small-model');}
    }
  });

  it('keeps dormant credentials optional and reports selected missing/blank native references by path only', () => {
    vi.stubEnv('OPAQUE_A', 'synthetic-api-key'); vi.stubEnv('NATIVE_TOOL_SECRET', '');
    const value = config(); value.llms!.a.env = { TOOL_TOKEN: '${NATIVE_TOOL_SECRET}' };
    const result = resolveConfiguredAgents(value); expect(result.ok).toBe(true);
    if (!result.ok) {return;}
    expect(validateResolvedAgent(result.presets.daily)).toBeUndefined();
    expect(validateResolvedAgent(result.presets.a)).toContain('llms.a.env.TOOL_TOKEN (NATIVE_TOOL_SECRET)');
    expect(validateResolvedAgent(result.presets.b)).toContain('credential');
  });

  it('projects explicitly selected native account auth while masking it from other agents', () => {
    vi.stubEnv('CODEX_PRIVATE', 'synthetic-native-canary');
    const value = config(); value.llms!.native.env = { OPENAI_API_KEY: '$CODEX_PRIVATE', OPENAI_BASE_URL: 'https://native.example' };
    const result = resolveConfiguredAgents(value); expect(result.ok).toBe(true);
    if (!result.ok) {return;}
    const selected = result.presets.daily;
    const env = buildSdkEnv(selected.apiKey, selected.apiBaseUrl, {}, false, undefined,
      { protocol: selected.apiProtocol, selectedEnv: selected.env, credentialEnvKeys: selected.credentialEnvKeys });
    expect(env.OPENAI_API_KEY).toBe('synthetic-native-canary');
    expect(env.OPENAI_BASE_URL).toBe('https://native.example');
    expect(env.CODEX_PRIVATE).toBeUndefined();
    const other = result.presets.a;
    expect(buildSdkEnv(other.apiKey, other.apiBaseUrl, {}, false, undefined,
      { protocol: other.apiProtocol, selectedEnv: other.env, credentialEnvKeys: other.credentialEnvKeys }).OPENAI_API_KEY).toBeUndefined();
  });

  it('rejects embedded URL credentials under opaque environment names without reflecting them', () => {
    const value = config(); value.env = { DATABASE_URL: 'postgres://user:synthetic-url-canary@db.example/data' };
    expect(secretConfigurationErrors(value).join(' ')).toContain('env.DATABASE_URL');
    expect(secretConfigurationErrors(value).join(' ')).not.toContain('synthetic-url-canary');
    delete value.env; value.llms!.a.env = { ENDPOINT: 'https://example.test?api_key=synthetic-url-canary' };
    expect(secretConfigurationErrors(value).join(' ')).toContain('llms.a.env.ENDPOINT');
  });

  it.each(['api_key', 'token', 'password', 'access_token'])('rejects credential-bearing API endpoint query %s', name => {
    const value = config(); value.llms!.a.api!.baseUrl = `https://example.test/v1?${name}=synthetic-endpoint-canary`;
    const result = resolveConfiguredAgents(value);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('llms.a.api.baseUrl');
    expect(JSON.stringify(result)).not.toContain('synthetic-endpoint-canary');
  });

  it('rejects literal native secrets and registers opaque references for logs and user diagnostics', () => {
    const value = config(); value.llms!.a.env = { TOOL_TOKEN: 'private-canary-not-to-print' };
    expect(secretConfigurationErrors(value).join(' ')).toContain('llms.a.env.TOOL_TOKEN');
    expect(secretConfigurationErrors(value).join(' ')).not.toContain('private-canary-not-to-print');
    vi.stubEnv('OPAQUE_A', 'opaque-secret-canary');
    resolveConfiguredAgents(config());
    const log = redactChannelSecrets(JSON.stringify({ msg: 'failed opaque-secret-canary', err: { stack: 'opaque-secret-canary' }, OPAQUE_A: 'opaque-secret-canary' }));
    expect(log).not.toContain('opaque-secret-canary');
    expect(sanitizeDiagnosticText('failed: opaque-secret-canary')).not.toContain('opaque-secret-canary');
    expect(JSON.stringify(config())).not.toContain('opaque-secret-canary');
    vi.stubEnv('OPAQUE_A', 'abc');
    expect(sanitizeDiagnosticText('rejected: abc')).not.toContain('abc');
  });
});
