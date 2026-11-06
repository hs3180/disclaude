import { credentialEnvName } from './env-reference.js';
import type { DisclaudeConfig } from './types.js';
import { channelDeclarationErrors, resolveChannelDeclarations } from './channel-declarations.js';
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

/**
 * One credential field's shape check, shared by legacy sections and named
 * declarations. Registers secret environment names for redaction as a side
 * effect; call sites word the diagnostics.
 */
function credentialFieldIssue(
  value: unknown,
  secret: boolean,
  config: DisclaudeConfig
): { kind: 'shape' } | { kind: 'env-collision'; name: string } | undefined {
  const name = credentialEnvName(typeof value === 'string' ? value : undefined);
  if (secret && name) {
    privateNames.add(name);
  }
  if (typeof value !== 'string' || !value.trim() || (!name && (secret || value.startsWith('$')))) {
    return { kind: 'shape' };
  }
  if (name && secret && Object.hasOwn(config.env ?? {}, name)) {
    return { kind: 'env-collision', name };
  }
  return undefined;
}

/**
 * Credential rules for named Feishu channel declarations
 * (`channels.<name>: { type: feishu, appId, appSecret }`).
 */
function feishuDeclarationCredentialErrors(config: DisclaudeConfig): string[] {
  const declarations = resolveChannelDeclarations(config).filter(
    (declaration) => declaration.type === 'feishu'
  );
  if (!declarations.length) {
    return [];
  }
  const errors: string[] = [];
  const legacyFeishu = config.channels?.feishu;
  if (legacyFeishu?.appId !== undefined || legacyFeishu?.appSecret !== undefined) {
    errors.push(
      'channels.feishu.appId/appSecret cannot be combined with named feishu channel declarations; declare every Feishu app as its own channel'
    );
  }
  for (const { name, config: declaration } of declarations) {
    if (declaration.enabled === false) {
      continue;
    }
    for (const [field, secret] of [
      ['appId', false],
      ['appSecret', true],
    ] as const) {
      const path = `channels.${name}.${field}`;
      if (declaration[field] === undefined) {
        errors.push(`${path} is required for a feishu channel declaration`);
        continue;
      }
      const issue = credentialFieldIssue(declaration[field], secret, config);
      if (!issue) {
        continue;
      }
      errors.push(
        issue.kind === 'env-collision'
          ? `${path} references env.${issue.name} in the same config; supply it through the service environment`
          : `${path} must be ${
              secret
                ? 'a whole $VARIABLE or ${VARIABLE} reference'
                : 'a public identifier or whole $VARIABLE / ${VARIABLE} reference'
            }`
      );
    }
  }
  return errors;
}

/** Resolve one named feishu channel's credential independently from every other channel. */
export function resolveFeishuChannelCredential(
  config: DisclaudeConfig,
  channelName: string,
  field: 'appId' | 'appSecret'
): string {
  const errors = channelCredentialErrors(config);
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
  const path = `channels.${channelName}.${field}`;
  const declaration = resolveChannelDeclarations(config).find(
    (entry) => entry.name === channelName && entry.type === 'feishu'
  );
  const value = declaration?.config[field];
  if (typeof value !== 'string' || !value.trim()) {
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
  const errors: string[] = [
    ...channelDeclarationErrors(config),
    ...feishuDeclarationCredentialErrors(config),
  ];
  for (const [channel, fields] of Object.entries(CHANNEL_CREDENTIAL_FIELDS)) {
    const entry = config.channels?.[channel];
    if (!entry) {
      continue;
    }
    // Diagnose raw legacy YAML without retaining the removed field in the API.
    if (channel === 'feishu') {
      if (Object.hasOwn(entry, 'appSecretEnv')) {
        errors.push(
          'channels.feishu.appSecretEnv is obsolete; migrate to appSecret: $VARIABLE and an external secret environment file (docs/channel-credentials.md)'
        );
      }
      if (Object.hasOwn(entry, 'apps')) {
        errors.push(
          'channels.feishu.apps is obsolete; declare each app as its own named channel with type: feishu (see disclaude.config.example.yaml)'
        );
      }
    }
    for (const [field, secret] of Object.entries(fields)) {
      const value = entry[field];
      if (value === undefined) {
        continue;
      }
      const path = `channels.${channel}.${field}`;
      const issue = credentialFieldIssue(value, secret, config);
      if (!issue) {
        continue;
      }
      errors.push(
        issue.kind === 'env-collision'
          ? `${path} references env.${issue.name} in the same config; remove that secret and supply it through the service environment or a restricted external file`
          : `${path} must be ${
              secret
                ? 'a whole $VARIABLE or ${VARIABLE} reference; move its value outside the general config'
                : 'a public identifier or whole $VARIABLE / ${VARIABLE} reference'
            }`
      );
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
