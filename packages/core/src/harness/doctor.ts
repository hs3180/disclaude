/**
 * `disclaude harness doctor` (Issue #5169): verify each harness runtime is
 * discoverable exactly the way the service resolves it at query time.
 *
 * Checks never read or write credentials — harnesses that own their
 * authentication (codex OAuth, standalone claude login) only get an explicit
 * next-step instruction, because verifying a session would mean touching the
 * very secrets this CLI promises to leave alone.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  harnessCatalog,
  CLAUDE_AGENT_SDK_PACKAGE,
  nodeSatisfiesPi,
  PI_MIN_NODE,
  PI_RUNTIME_PACKAGES,
  resolveHarnessVersion,
} from './registry.js';
import {
  bundledClaudeRuntime,
  findOnPath,
  npmGlobalPackages,
  resolveNodeModules,
} from './detect.js';
import type { HarnessId, ProcessRunner } from './types.js';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface HarnessDoctorReport {
  harness: HarnessId;
  /** True when no required check failed (warn/info do not fail a harness). */
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  runner: ProcessRunner;
  env: Record<string, string | undefined>;
  coreDir: string;
  installRoot: string;
  /** Injectable for tests; defaults to the running Node. */
  nodeVersion?: string;
}

function checkPathCli(id: HarnessId, binary: string, found: string | undefined): DoctorCheck {
  if (found) {
    return {
      name: 'cli-on-path',
      status: 'pass',
      detail: `\`${binary}\` is discoverable on PATH at ${found}; the service spawns \`${binary}\` by name for this harness`,
    };
  }
  return {
    name: 'cli-on-path',
    status: 'fail',
    detail: `\`${binary}\` is not discoverable on PATH; the service spawns \`${binary}\` by name for this harness`,
    hint: `Preview with \`disclaude harness install ${id} --dry-run\`, then install without --dry-run and re-run this doctor.`,
  };
}

/** Doctor one harness; probes are offline and side-effect free. */
export async function doctorHarness(
  id: HarnessId,
  options: DoctorOptions
): Promise<HarnessDoctorReport> {
  const entry = harnessCatalog(id);
  const checks: DoctorCheck[] = [];
  const nodeVersion = options.nodeVersion ?? process.version;

  if (id === 'claude') {
    const bundled = bundledClaudeRuntime(options.coreDir);
    checks.push(
      bundled.resolvable
        ? {
            name: 'bundled-sdk-runtime',
            status: 'pass',
            detail:
              `${CLAUDE_AGENT_SDK_PACKAGE}${bundled.sdkVersion ? ` ${bundled.sdkVersion}` : ''} resolves from ${options.coreDir}` +
              `${bundled.claudeCodeVersion ? ` and bundles Claude Code ${bundled.claudeCodeVersion}` : ''}; the service spawns this bundled CLI`,
          }
        : {
            name: 'bundled-sdk-runtime',
            status: 'fail',
            detail: `${CLAUDE_AGENT_SDK_PACKAGE} does not resolve from ${options.coreDir}; the claude harness cannot start`,
            hint: 'Reinstall this disclaude distribution; the runtime ships as its pinned dependency, not as a separate download.',
          }
    );
    const cli = findOnPath('claude', options.env);
    checks.push({
      name: 'standalone-cli',
      status: 'info',
      detail: cli
        ? `\`claude\` is on PATH at ${cli} (standalone CLI for interactive use; the service itself uses the bundled runtime)`
        : '`claude` is not on PATH. That is optional for the service (it uses the bundled runtime); install it for interactive use with `disclaude harness install claude`.',
    });
  } else if (id === 'pi') {
    const satisfies = nodeSatisfiesPi(nodeVersion);
    checks.push({
      name: 'node-version',
      status: satisfies ? 'pass' : 'fail',
      detail: satisfies
        ? `Node ${nodeVersion} satisfies the pi minimum (>= ${PI_MIN_NODE.join('.')})`
        : `Node ${nodeVersion} is below the pi minimum (>= ${PI_MIN_NODE.join('.')})`,
      hint: satisfies
        ? undefined
        : 'Upgrade Node before installing or running the pi runtime (docs/pi-backend.md).',
    });
    const expected = resolveHarnessVersion('pi', { env: options.env });
    const resolved = resolveNodeModules(options.coreDir, PI_RUNTIME_PACKAGES);
    const missing = PI_RUNTIME_PACKAGES.filter((name) => !resolved[name]?.resolved);
    const mismatched = PI_RUNTIME_PACKAGES.filter(
      (name) => resolved[name]?.resolved && resolved[name].version !== expected.value
    );
    if (missing.length === 0 && mismatched.length === 0) {
      checks.push({
        name: 'runtime-packages',
        status: 'pass',
        detail: PI_RUNTIME_PACKAGES.map(
          (name) => `${name}@${resolved[name]?.version} resolves from ${options.coreDir}`
        ).join('; '),
      });
    } else if (missing.length > 0) {
      checks.push({
        name: 'runtime-packages',
        status: 'fail',
        detail: `${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not resolve from ${options.coreDir} (production Node module resolution)`,
        hint: piInstallHint(options, expected.value),
      });
    } else {
      checks.push({
        name: 'runtime-packages',
        status: 'warn',
        detail: PI_RUNTIME_PACKAGES.map(
          (name) =>
            `${name}@${resolved[name]?.version ?? '?'} resolves (expected ${expected.value})`
        ).join('; '),
        hint: 'The resolvable version differs from the repo pin: discoverable but unvalidated. Reinstall with `disclaude harness install pi` to pin the expected version.',
      });
    }
  } else {
    // codex / dsh: the PATH CLI is the service's spawn target and is required.
    const [binary] = entry.binaries;
    checks.push(checkPathCli(id, binary, findOnPath(binary, options.env)));
    const globals = await npmGlobalPackages(options.runner);
    const installed = globals[entry.packages[0]];
    const expected = resolveHarnessVersion(id, { env: options.env });
    checks.push({
      name: 'npm-global-package',
      status: 'info',
      detail: installed
        ? `${entry.packages[0]}@${installed} in the npm global prefix (repo pin: ${expected.value}, ${expected.source})`
        : `${entry.packages[0]} is not in the npm global prefix (repo pin: ${expected.value}, ${expected.source})`,
    });
  }

  checks.push({ name: 'auth', status: 'info', detail: entry.auth.nextStep });
  return { harness: id, ok: !checks.some((check) => check.status === 'fail'), checks };
}

function piInstallHint(options: DoctorOptions, version: string): string {
  const specs = PI_RUNTIME_PACKAGES.map((name) => `${name}@${version}`).join(' ');
  if (existsSync(join(options.installRoot, 'pnpm-workspace.yaml'))) {
    return `Source worktree: run \`disclaude harness install pi\` or \`corepack pnpm --filter @disclaude/core add --save-optional --save-exact ${specs}\` (docs/pi-backend.md).`;
  }
  return `Run \`disclaude harness install pi\` (installs ${specs} into this install's node_modules).`;
}
