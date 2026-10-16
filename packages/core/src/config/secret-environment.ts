/** Host-only provenance for an explicitly loaded external secret file.
 * Keep this entry point free of Config, logging and other initialization.
 */
const externalNames = new Set<string>();

export function registerExternalSecretEnvironmentNames(names: Iterable<string>): void {
  for (const name of names) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {externalNames.add(name);}
  }
}

/** Names only: secret values stay in the service environment. */
export function externalSecretEnvironmentNames(): readonly string[] {
  return [...externalNames];
}
