/**
 * Validation + resolution of the `github` feedback config section
 * (Issue #5400, PR A).
 *
 * Follows the channel-credentials contract: public identifiers may be
 * literals, the private key must be a whole `$VARIABLE` reference resolved
 * from the service environment, never a literal in the YAML. The resolved
 * PEM is registered as a consumed secret so log redaction and
 * sanitizeDiagnosticText strip it everywhere.
 */
import { credentialEnvName } from './env-reference.js';
import { registerConsumedSecretValue } from './channel-credentials.js';
const PRIVATE_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';
/** Structural validation; returns one message per problem. */
export function githubFeedbackErrors(config) {
    const errors = [];
    const { github } = config;
    if (!github) {
        return errors;
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github.repository ?? '')) {
        errors.push('github.repository must be an "owner/name" repository identifier');
    }
    for (const [field, value] of [
        ['appId', github.appId],
        ['installationId', github.installationId],
    ]) {
        if (!/^\d+$/.test(value ?? '')) {
            errors.push(`github.${field} must be the GitHub App's numeric ${field === 'appId' ? 'app' : 'installation'} ID`);
        }
    }
    const name = credentialEnvName(github.privateKey);
    if (typeof github.privateKey !== 'string' || !name) {
        errors.push(`github.privateKey must be a whole $VARIABLE or \${VARIABLE} reference (e.g. $${PRIVATE_KEY_ENV}); move the PEM outside the general config`);
    }
    else if (Object.hasOwn(config.env ?? {}, name)) {
        errors.push(`github.privateKey references env.${name} in the same config; supply it through the service environment or a restricted external file`);
    }
    return errors;
}
/**
 * Resolve the configured target, or `undefined` when the section is absent
 * (reporting stays disabled). Throws when the section is present but invalid
 * or its environment variable is missing — a half-configured reporter must
 * fail loudly at startup, not silently at click time.
 */
export function resolveGitHubIssueTarget(config) {
    const { github } = config;
    if (!github) {
        return undefined;
    }
    const errors = githubFeedbackErrors(config);
    if (errors.length) {
        throw new Error(errors.join('; '));
    }
    const { repository, appId, installationId } = github;
    const keyName = credentialEnvName(github.privateKey);
    // Redundant with githubFeedbackErrors, but keeps the return type honest.
    if (!repository || !appId || !installationId || !keyName) {
        throw new Error('github feedback configuration is incomplete');
    }
    const raw = process.env[keyName];
    if (!raw?.trim()) {
        throw new Error(`github.privateKey: environment variable ${keyName} is missing or empty; supply it outside the general config`);
    }
    // Accept both literal and `\n`-escaped PEM content from the environment.
    const privateKey = raw.replace(/\\n/g, '\n');
    if (!privateKey.includes('-----BEGIN')) {
        throw new Error(`github.privateKey: environment variable ${keyName} does not contain a PEM private key`);
    }
    registerConsumedSecretValue(privateKey);
    return { repository, appId, installationId, privateKey };
}
