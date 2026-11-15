/**
 * Shared contracts for the `disclaude harness` install/check CLI (Issue #5169).
 *
 * Harness runtimes install through two different mechanisms and the CLI must
 * not blur them: Claude/Codex/DSH ship CLI binaries that the service spawns by
 * name, so they belong in the npm global prefix on PATH; the pi runtime is a
 * pair of optional Node modules the service resolves through production Node
 * module resolution (docs/pi-backend.md). Everything here is injectable so
 * install/upgrade/skip/failure paths are testable without a real npm install.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
/** Error thrown when a runner cannot even start a command (e.g. ENOENT). */
export class RunnerLaunchError extends Error {
    command;
    constructor(command, cause) {
        super(`Failed to execute ${command}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.command = command;
        this.name = 'RunnerLaunchError';
    }
}
/** Credential-shaped environment names never forwarded to package managers. */
const SECRET_ENV_PATTERN = /(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;
/**
 * Remove credential-shaped variables from an environment before handing it to
 * npm/pnpm. Harness installs use only public registry packages; no API key,
 * token or password ever needs to flow through this CLI, so none is passed on.
 * Registry mirrors are not secrets and survive (NPM_CONFIG_REGISTRY et al.).
 */
export function sanitizeChildEnv(env = process.env) {
    const sanitized = {};
    for (const [name, value] of Object.entries(env)) {
        if (!SECRET_ENV_PATTERN.test(name)) {
            sanitized[name] = value;
        }
    }
    return sanitized;
}
/**
 * Default runner: `execFile` with a hard timeout and output cap. Non-zero exit
 * codes are returned (not thrown) so probes can parse stdout regardless;
 * launch failures (command missing) throw {@link RunnerLaunchError}. The
 * exec function is injectable so tests drive fake package managers.
 */
export function createDefaultRunner(env = process.env, execFile = promisify(execFileCallback)) {
    return {
        async run(command, args, options = {}) {
            try {
                const { stdout, stderr } = (await execFile(command, args, {
                    cwd: options.cwd,
                    timeout: options.timeoutMs ?? 120_000,
                    maxBuffer: 16 * 1024 * 1024,
                    encoding: 'utf8',
                    env: sanitizeChildEnv(env),
                }));
                return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
            }
            catch (error) {
                const failure = error;
                if (failure.code === 'ENOENT') {
                    throw new RunnerLaunchError(command, error);
                }
                return {
                    code: typeof failure.code === 'number' ? failure.code : 1,
                    stdout: failure.stdout ?? '',
                    stderr: failure.stderr || failure.message || '',
                };
            }
        },
    };
}
