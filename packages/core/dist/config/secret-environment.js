/** Host-only provenance for an explicitly loaded external secret file.
 * Keep this entry point free of Config, logging and other initialization.
 */
const externalNames = new Set();
export function registerExternalSecretEnvironmentNames(names) {
    for (const name of names) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            externalNames.add(name);
        }
    }
}
/** Names only: secret values stay in the service environment. */
export function externalSecretEnvironmentNames() {
    return [...externalNames];
}
