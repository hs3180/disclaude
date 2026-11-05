/**
 * Shared contracts for the `disclaude backend` install/check CLI (Issue #5169).
 *
 * Backend runtimes install through two different mechanisms and the CLI must
 * not blur them: Claude/Codex/DSH ship CLI binaries that the service spawns by
 * name, so they belong in the npm global prefix on PATH; the pi runtime is a
 * pair of optional Node modules the service resolves through production Node
 * module resolution (docs/pi-backend.md). Everything here is injectable so
 * install/upgrade/skip/failure paths are testable without a real npm install.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

/** Result of one child-process execution by a {@link ProcessRunner}. */
export interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Error thrown when a runner cannot even start a command (e.g. ENOENT). */
export class RunnerLaunchError extends Error {
  constructor(
    readonly command: string,
    cause: unknown
  ) {
    super(
      `Failed to execute ${command}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'RunnerLaunchError';
  }
}

/**
 * Executes one command directly (no shell). Implementations must never log
 * environment values: child environments may carry operator secrets even
 * though {@link sanitizeChildEnv} strips credential-shaped variables.
 */
export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number }
  ): Promise<RunnerResult>;
}

/** Agent backend ids accepted by `disclaude backend` (config `backend:` values). */
export type BackendId = 'claude' | 'pi' | 'codex' | 'dsh';

/** Where a backend runtime must be discoverable after installation. */
export type InstallTarget = 'path-cli' | 'node-modules';

/** Credential-shaped environment names never forwarded to package managers. */
const SECRET_ENV_PATTERN = /(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i;

/**
 * Remove credential-shaped variables from an environment before handing it to
 * npm/pnpm. Backend installs use only public registry packages; no API key,
 * token or password ever needs to flow through this CLI, so none is passed on.
 * Registry mirrors are not secrets and survive (NPM_CONFIG_REGISTRY et al.).
 */
export function sanitizeChildEnv(
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV_PATTERN.test(name)) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

/** Promisified execFile shape used by {@link createDefaultRunner}. */
export type ExecFile = typeof execFileCallback.__promisify__;

/**
 * Default runner: `execFile` with a hard timeout and output cap. Non-zero exit
 * codes are returned (not thrown) so probes can parse stdout regardless;
 * launch failures (command missing) throw {@link RunnerLaunchError}. The
 * exec function is injectable so tests drive fake package managers.
 */
export function createDefaultRunner(
  env: Record<string, string | undefined> = process.env,
  execFile: ExecFile = promisify(execFileCallback)
): ProcessRunner {
  return {
    async run(
      command: string,
      args: string[],
      options: { cwd?: string; timeoutMs?: number } = {}
    ): Promise<RunnerResult> {
      try {
        const { stdout, stderr } = (await execFile(command, args, {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 120_000,
          maxBuffer: 16 * 1024 * 1024,
          encoding: 'utf8',
          env: sanitizeChildEnv(env),
        })) as { stdout?: string; stderr?: string };
        return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
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
