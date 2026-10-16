import { apiCredentialEnvName, credentialEnvName } from './env-reference.js';
import { registerModelSecretNames } from './channel-credentials.js';
import type { DisclaudeConfig } from './types.js';

/** Names supplement explicit references; values are never guessed or inspected. */
export const isSecretVariable = (name: string): boolean =>
  /(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|SECRET|TOKEN|PASSWORD|PASS|AUTHORIZATION|COOKIE|COOKIES|CREDENTIALS?|BEARER)(?:$|_)/i.test(name) || name === 'PGPASSWORD';

export function hasUrlCredential(value: unknown): boolean {
  if (typeof value !== 'string') {return false;}
  try {
    const url = new URL(value);
    return !!url.username || !!url.password || [...url.searchParams.keys()].some(key => /key|token|secret|password|credential|authorization|cookie/i.test(key));
  } catch {return false;}
}

export function modelSecretReferences(config: DisclaudeConfig): Set<string> {
  const names = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
  registerModelSecretNames(['DISCLAUDE_API_TOKEN']);
  // Host tool credentials require explicit per-LLM projection as well. The
  // service's channel-control bearer is intentionally supplied to every agent.
  for (const name of Object.keys(process.env)) {
    if ((isSecretVariable(name) || hasUrlCredential(process.env[name])) && name !== 'DISCLAUDE_API_TOKEN') {names.add(name);}
  }
  for (const llm of Object.values(config.llms ?? {})) {
    if (!llm || typeof llm !== 'object') {continue;}
    if (llm.api && typeof llm.api === 'object') {
      const name = apiCredentialEnvName(llm.api);
      if (name) {names.add(name);}
    }
    for (const [key, value] of Object.entries(llm.env ?? {})) {
      const name = credentialEnvName(value);
      if (name) {names.add(name);}
      if (isSecretVariable(key)) {names.add(key);}
    }
  }
  registerModelSecretNames(names);
  return names;
}

export function secretConfigurationErrors(config: DisclaudeConfig): string[] {
  const names = modelSecretReferences(config);
  const errors: string[] = [];
  for (const key of Object.keys(config.env ?? {})) {
    if (isSecretVariable(key) || names.has(key) || hasUrlCredential(config.env?.[key])) {
      errors.push(`env.${key} is sensitive; remove it from YAML and supply it through the service environment or an external secret environment file (DISCLAUDE_SECRET_ENV_FILE)`);
    }
  }
  for (const [llmName, llm] of Object.entries(config.llms ?? {})) {
    if (!llm || typeof llm !== 'object') {continue;}
    for (const [key, value] of Object.entries(llm.env ?? {})) {
      if ((isSecretVariable(key) || names.has(key) || hasUrlCredential(value)) && !credentialEnvName(value)) {
        errors.push(`llms.${llmName}.env.${key} must be a whole $VARIABLE or \u0024{VARIABLE} reference to an external secret`);
      }
    }
  }
  return errors;
}

/** Resolve host-owned references; missing values fail preflight only when selected. */
export function resolveLlmEnvironment(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) {return undefined;}
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    const reference = credentialEnvName(value);
    return [key, reference ? (process.env[reference] ?? '') : value];
  }));
}
