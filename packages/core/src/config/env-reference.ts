/** Credential references are whole values, never shell expressions or interpolation. */
export function credentialEnvName(reference: unknown): string | undefined {
  if (typeof reference !== 'string') {
    return undefined;
  }
  const match = /^(?:\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(reference);
  return match?.[1] ?? match?.[2];
}

export function apiCredentialEnvName(api: {
  protocol: string;
  apiKey?: string;
}): string | undefined {
  return credentialEnvName(
    api.apiKey ?? (api.protocol === 'openai' ? '$OPENAI_API_KEY' : '$ANTHROPIC_API_KEY')
  );
}
