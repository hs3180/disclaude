import { credentialEnvName } from './env-reference.js';
import type { DisclaudeConfig } from './types.js';
import { externalSecretEnvironmentNames } from './secret-environment.js';

/** Public IDs may be literals; secrets always reference host-owned environment values. */
export const CHANNEL_CREDENTIAL_FIELDS = {
  feishu: { appId: false, appSecret: true, verificationToken: true, encryptKey: true },
  ruliu: { appKey: false, appSecret: true, checkToken: true, encodingAESKey: true },
  rest: { authToken: true },
} as const;
type Channel = keyof typeof CHANNEL_CREDENTIAL_FIELDS;
const privateNames = new Set<string>();
const consumedSecrets = new Set<string>();
const modelSecretNames = new Set<string>();

/** API and per-LLM references share log redaction, without becoming channel-only env. */
export function registerModelSecretNames(names: Iterable<string>): void {
  for (const name of names) {
    modelSecretNames.add(name);
  }
}

/** Register a consumed secret value from a non-channel component (e.g. the GitHub App PEM, Issue #5400) for redaction. */
export function registerConsumedSecretValue(value: string): void {
  if (value.trim()) {
    consumedSecrets.add(value);
  }
}

export function knownSecretValues(): string[] {
  return [
    ...consumedSecrets,
    ...[...privateNames, ...modelSecretNames, ...externalSecretEnvironmentNames()].map(
      (name) => process.env[name] ?? ''
    ),
  ].filter(Boolean);
}

/** Validate named Feishu apps without resolving their secrets. */
export function feishuAppErrors(config: DisclaudeConfig): string[] {
  const feishu = config.channels?.feishu;
  if (feishu?.apps === undefined) {
    return [];
  }
  const errors: string[] = [];
  const apps = feishu.apps as unknown;
  if (!apps || typeof apps !== 'object' || Array.isArray(apps) || Object.keys(apps).length === 0) {
    return ['channels.feishu.apps must be a non-empty map of named apps'];
  }
  if (feishu.appId !== undefined || feishu.appSecret !== undefined) {
    errors.push('channels.feishu.appId/appSecret cannot be combined with channels.feishu.apps');
  }
  const normalizedNames = new Map<string, string>();
  for (const [name, raw] of Object.entries(apps)) {
    const path = `channels.feishu.apps.${name}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      errors.push(`${path}: app names must be non-empty and contain only letters, digits, _ or -`);
    }
    const normalized = name.toLowerCase();
    const previous = normalizedNames.get(normalized);
    if (previous) {
      errors.push(`${path}: duplicate app name (also ${previous})`);
    }
    normalizedNames.set(normalized, name);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${path} must be a mapping`);
      continue;
    }
    const app = raw as Record<string, unknown>;
    for (const [field, secret] of [
      ['appId', false],
      ['appSecret', true],
    ] as const) {
      const value = app[field];
      const envName = credentialEnvName(value);
      if (envName && secret) {
        privateNames.add(envName);
      }
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        (!envName && (secret || value.startsWith('$')))
      ) {
        errors.push(
          `${path}.${field} must be ${secret ? 'a whole $VARIABLE or ${VARIABLE} reference' : 'a public identifier or whole $VARIABLE / ${VARIABLE} reference'}`
        );
      } else if (envName && secret && Object.hasOwn(config.env ?? {}, envName)) {
        errors.push(
          `${path}.${field} references env.${envName} in the same config; supply it through the service environment`
        );
      }
    }
    if (app.agent !== undefined && (typeof app.agent !== 'string' || !app.agent.trim())) {
      errors.push(`${path}.agent must be a non-empty agents preset name`);
    } else if (typeof app.agent === 'string' && !Object.hasOwn(config.agents ?? {}, app.agent)) {
      errors.push(`${path}.agent references unknown agents preset: ${app.agent}`);
    }
  }
  return errors;
}

export function feishuAppAgentDefaults(config: DisclaudeConfig): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.channels?.feishu?.apps ?? {})
      .map(([name, app]) => [name, typeof app.agent === 'string' ? app.agent : undefined] as const)
      .filter(
        (entry): entry is readonly [string, string] =>
          typeof entry[1] === 'string' && entry[1].trim() !== ''
      )
  );
}

/** Resolve one named app's credential independently from every other app. */
export function resolveFeishuAppCredential(
  config: DisclaudeConfig,
  appName: string,
  field: 'appId' | 'appSecret'
): string {
  const errors = feishuAppErrors(config);
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
  const path = `channels.feishu.apps.${appName}.${field}`;
  const value = config.channels?.feishu?.apps?.[appName]?.[field];
  if (value === undefined) {
    throw new Error(`${path} is not configured`);
  }
  const name = credentialEnvName(value);
  if (!name) {
    return value;
  }
  const secret = process.env[name];
  if (!secret?.trim()) {
    throw new Error(`${path}: environment variable ${name} is missing or empty`);
  }
  if (field === 'appSecret') {
    consumedSecrets.add(secret);
  }
  return secret;
}

export function channelCredentialErrors(config: DisclaudeConfig): string[] {
  const errors: string[] = feishuAppErrors(config);
  for (const [channel, fields] of Object.entries(CHANNEL_CREDENTIAL_FIELDS)) {
    const entry = config.channels?.[channel];
    if (!entry) {
      continue;
    }
    // Diagnose raw legacy YAML without retaining the removed field in the API.
    if (channel === 'feishu' && Object.hasOwn(entry, 'appSecretEnv')) {
      errors.push(
        'channels.feishu.appSecretEnv is obsolete; migrate to appSecret: $VARIABLE and an external secret environment file (docs/channel-credentials.md)'
      );
    }
    for (const [field, secret] of Object.entries(fields)) {
      const value = entry[field];
      if (value === undefined) {
        continue;
      }
      const path = `channels.${channel}.${field}`;
      const name = credentialEnvName(value);
      if (secret && name) {
        privateNames.add(name);
      }
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        (!name && (secret || value.startsWith('$')))
      ) {
        errors.push(
          `${path} must be ${secret ? 'a whole $VARIABLE or ${VARIABLE} reference; move its value outside the general config' : 'a public identifier or whole $VARIABLE / ${VARIABLE} reference'}`
        );
      } else if (name && secret && Object.hasOwn(config.env ?? {}, name)) {
        errors.push(
          `${path} references env.${name} in the same config; remove that secret and supply it through the service environment or a restricted external file`
        );
      }
    }
  }
  return errors;
}

/** Resolve only for a component that is starting; dormant imports need no secrets. */
export function resolveChannelCredential(
  config: DisclaudeConfig,
  channel: Channel,
  field: string,
  required = false
): string {
  const errors = channelCredentialErrors(config);
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
  const path = `channels.${channel}.${field}`;
  if (!Object.hasOwn(CHANNEL_CREDENTIAL_FIELDS[channel], field)) {
    throw new Error(`${path} is not a credential field`);
  }
  const value = config.channels?.[channel]?.[field];
  if (value === undefined) {
    if (required) {
      throw new Error(
        `${path} is required; configure a public identifier or external credential reference`
      );
    }
    return '';
  }
  const name = credentialEnvName(value);
  if (!name) {
    return value as string;
  }
  const secret = process.env[name];
  if (!secret?.trim()) {
    throw new Error(
      `${path}: environment variable ${name} is missing or empty; supply it outside the general config`
    );
  }
  if ((CHANNEL_CREDENTIAL_FIELDS[channel] as Record<string, boolean>)[field]) {
    consumedSecrets.add(secret);
  }
  return secret;
}

/** Applied after JSON serialization, including strings/stacks, in every log mode. */
export function redactChannelSecrets(serialized: string): string {
  const secretNames = new Set([
    ...privateNames,
    ...modelSecretNames,
    ...externalSecretEnvironmentNames(),
  ]);
  const values = knownSecretValues().sort((a, b) => b.length - a.length);
  const sensitive =
    /^(?:api[_-]?key|app[_-]?secret|auth[_-]?token|checkToken|encodingAESKey|encryptKey|verificationToken|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token|authorization|cookie|set-cookie)$/i;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return (
      JSON.stringify(parsed, (key, value: unknown) => {
        if (sensitive.test(key) || secretNames.has(key)) {
          return '[REDACTED]';
        }
        if (typeof value !== 'string') {
          return value;
        }
        let text = value;
        for (const secret of values) {
          for (const form of [secret, encodeURIComponent(secret)]) {
            text = text.split(form).join('[REDACTED]');
          }
        }
        return text;
      }) + (serialized.endsWith('\n') ? '\n' : '')
    );
  } catch {
    // A malformed diagnostic must not bypass the credential boundary.
    return '{"level":50,"msg":"Malformed log entry omitted"}\n';
  }
}

/** Final child-environment boundary shared by every harness. Keep channel auth in the service. */
export function withoutChannelCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of privateNames) {
    delete result[name];
  }
  for (const name of [
    'FEISHU_APP_SECRET',
    'RULIU_APP_SECRET',
    'RULIU_CHECK_TOKEN',
    'RULIU_ENCODING_AES_KEY',
    'REST_CHANNEL_AUTH_TOKEN',
    'DISCLAUDE_SECRET_ENV_FILE',
  ]) {
    delete result[name];
  }
  return result;
}
