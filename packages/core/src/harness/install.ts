/**
 * Idempotent harness runtime installs for `disclaude harness install`
 * (Issue #5169).
 *
 * Install always produces an explicit plan first (action, target versions,
 * package manager, exact command, what will be written). Execution is separate
 * so --dry-run and confirmation can show the plan without touching anything.
 * Re-running against an already-correct install skips with the installed
 * version as the reason; a differing version upgrades; a package that is
 * installed but whose binary is not on PATH repairs into the active prefix.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  harnessCatalog,
  nodeSatisfiesPi,
  PI_RUNTIME_PACKAGES,
  resolveHarnessVersion,
  type ResolvedVersion,
} from './registry.js';
import {
  bundledClaudeRuntime,
  corePackageDir,
  findOnPath,
  npmGlobalPackages,
  npmGlobalPrefix,
  resolveNodeModules,
} from './detect.js';
import type { HarnessId, ProcessRunner, RunnerResult } from './types.js';

export type InstallAction = 'install' | 'upgrade' | 'repair' | 'skip';
export type InstallStatus =
  | 'installed'
  | 'upgraded'
  | 'repaired'
  | 'skipped'
  | 'aborted'
  | 'dry-run'
  | 'failed';

export interface InstallPlanTarget {
  name: string;
  /** Version the plan installs. */
  version: string;
  /** Currently installed version, when known. */
  current?: string;
}

export interface InstallPlan {
  harness: HarnessId;
  action: InstallAction;
  reason: string;
  /** Source worktree (pnpm) vs prebuilt install (npm) layout. */
  sourceTree: boolean;
  packageManager: 'npm' | 'pnpm';
  /** Exact command line the plan would run. */
  command: string;
  program: string;
  args: string[];
  cwd: string;
  targets: InstallPlanTarget[];
  version: ResolvedVersion;
  /** Filesystem locations the install writes. */
  writes: string[];
  permissionNote: string;
  notes: string[];
}

export interface PlanOptions {
  runner: ProcessRunner;
  env: Record<string, string | undefined>;
  /** Disclaude install root (prebuilt) or source checkout root. */
  installRoot: string;
  /** Defaults to the running @disclaude/core package directory. */
  coreDir?: string;
  flagVersion?: string;
  registry?: string;
}

const quote = (value: string): string => (/^[^'\s]+$/.test(value) ? value : `'${value}'`);

function planClaudeNote(claudeBundled: {
  sdkVersion?: string;
  claudeCodeVersion?: string;
}): string {
  const versions = [
    claudeBundled.sdkVersion ? `agent SDK ${claudeBundled.sdkVersion}` : '',
    claudeBundled.claudeCodeVersion ? `bundled Claude Code ${claudeBundled.claudeCodeVersion}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    `The disclaude service spawns the Claude Code CLI bundled inside its pinned @anthropic-ai/claude-agent-sdk dependency${versions ? ` (${versions})` : ''}; ` +
    'the standalone `claude` binary installed here serves interactive use and is pinned to match that bundled version.'
  );
}

/** Compute the full install plan for one harness without changing anything. */
export async function planHarnessInstall(
  id: HarnessId,
  options: PlanOptions
): Promise<InstallPlan> {
  const entry = harnessCatalog(id);
  const coreDir = options.coreDir ?? corePackageDir();
  const claudeBundled = id === 'claude' ? bundledClaudeRuntime(coreDir) : undefined;
  const version = resolveHarnessVersion(id, {
    flagVersion: options.flagVersion,
    env: options.env,
    claudeBundledVersion: claudeBundled?.claudeCodeVersion,
  });
  const registryArgs = options.registry ? ['--registry', options.registry] : [];
  const notes: string[] = [];

  if (entry.installTarget === 'path-cli') {
    const [pkg] = entry.packages;
    const [binary] = entry.binaries;
    const installed = (await npmGlobalPackages(options.runner))[pkg];
    const binaryPath = findOnPath(binary, options.env);
    const globalPrefix = await npmGlobalPrefix(options.runner);
    let action: InstallAction;
    let reason: string;
    if (!installed) {
      action = 'install';
      reason = `${pkg} is not present in the npm global prefix`;
    } else if (installed === version.value) {
      if (binaryPath) {
        action = 'skip';
        reason = `${pkg}@${installed} already installed and \`${binary}\` is discoverable on PATH (${binaryPath})`;
      } else {
        action = 'repair';
        reason = `${pkg}@${installed} is installed but \`${binary}\` is not on PATH; reinstalling into the active npm global prefix`;
      }
    } else {
      action = 'upgrade';
      reason = `${pkg} ${installed} is installed, target is ${version.value}`;
    }
    const targets: InstallPlanTarget[] = [
      { name: pkg, version: version.value, current: installed },
    ];
    const args = ['install', '-g', `${pkg}@${version.value}`, ...registryArgs];
    if (id === 'claude' && claudeBundled) {
      notes.push(planClaudeNote(claudeBundled));
    }
    if (action === 'skip') {
      return {
        harness: id,
        action,
        reason,
        sourceTree: false,
        packageManager: 'npm' as const,
        command: '(nothing to run)',
        program: '',
        args: [],
        cwd: options.installRoot,
        targets,
        version,
        writes: [],
        permissionNote:
          'No changes; the installed runtime already matches the target version and is discoverable.',
        notes,
      };
    }
    return {
      harness: id,
      action,
      reason,
      sourceTree: false,
      packageManager: 'npm',
      command: ['npm', ...args].map(quote).join(' '),
      program: 'npm',
      args,
      cwd: options.installRoot,
      targets,
      version,
      writes: [
        globalPrefix
          ? `npm global prefix: ${globalPrefix}`
          : 'npm global prefix (npm prefix -g unavailable)',
      ],
      permissionNote:
        'Writes the package into the npm global prefix; depending on your npm setup that directory may require elevated permissions. No project dependencies or lockfiles are touched.',
      notes,
    };
  }

  // pi: optional Node modules under production module resolution.
  const sourceTree = existsSync(join(options.installRoot, 'pnpm-workspace.yaml'));
  const resolved = resolveNodeModules(coreDir, PI_RUNTIME_PACKAGES);
  const versions = PI_RUNTIME_PACKAGES.map((name) => resolved[name]?.version);
  const allResolved = PI_RUNTIME_PACKAGES.every((name) => resolved[name]?.resolved);
  const allAtTarget = allResolved && versions.every((found) => found === version.value);
  const specs = PI_RUNTIME_PACKAGES.map((name) => `${name}@${version.value}`);
  const targets: InstallPlanTarget[] = PI_RUNTIME_PACKAGES.map((name, index) => ({
    name,
    version: version.value,
    current: resolved[name]?.resolved ? versions[index] : undefined,
  }));
  notes.push(
    `Pi runtime packages require Node.js >= 22.19.0 (docs/pi-backend.md); this host runs ${process.version}.`
  );
  if (!nodeSatisfiesPi(process.version)) {
    notes.push(
      `WARNING: current Node ${process.version} is below the pi minimum; upgrade Node before using the pi harness.`
    );
  }
  if (allAtTarget) {
    return {
      harness: id,
      action: 'skip',
      reason: `runtime packages already resolve at ${version.value} from ${coreDir}`,
      sourceTree,
      packageManager: sourceTree ? 'pnpm' : 'npm',
      command: '(nothing to run)',
      program: '',
      args: [],
      cwd: options.installRoot,
      targets,
      version,
      writes: [],
      permissionNote: 'No changes; the installed runtime already matches the target version.',
      notes,
    };
  }
  if (sourceTree) {
    const args = [
      'pnpm',
      '--filter',
      '@disclaude/core',
      'add',
      '--save-optional',
      '--save-exact',
      ...specs,
      ...registryArgs,
    ];
    return {
      harness: id,
      action: allResolved ? 'upgrade' : 'install',
      reason: allResolved
        ? `runtime packages resolve at ${versions.join(', ')}; target is ${version.value} (source worktrees pin the runtime through core optionalDependencies)`
        : `runtime packages are not resolvable from ${coreDir}; source worktrees declare them as core optionalDependencies (docs/pi-backend.md)`,
      sourceTree: true,
      packageManager: 'pnpm',
      command: ['corepack', ...args].map(quote).join(' '),
      program: 'corepack',
      args,
      cwd: options.installRoot,
      targets,
      version,
      writes: [
        `${join(options.installRoot, 'packages', 'core', 'package.json')} (optionalDependencies)`,
        join(options.installRoot, 'pnpm-lock.yaml'),
      ],
      permissionNote:
        'Updates @disclaude/core optionalDependencies and the shared pnpm lockfile — the documented source-worktree workflow (docs/pi-backend.md). The change is explicit and version-controlled.',
      notes,
    };
  }
  const args = ['install', '--no-save', '--package-lock=false', ...specs, ...registryArgs];
  return {
    harness: id,
    action: allResolved ? 'upgrade' : 'install',
    reason: allResolved
      ? `runtime packages resolve at ${versions.join(', ')}; target is ${version.value}`
      : `runtime packages are not resolvable from ${coreDir} (production resolution walks up from packages/core)`,
    sourceTree: false,
    packageManager: 'npm',
    command: ['npm', ...args].map(quote).join(' '),
    program: 'npm',
    args,
    cwd: options.installRoot,
    targets,
    version,
    writes: [`${join(options.installRoot, 'node_modules')} (optional runtime packages only)`],
    permissionNote:
      'Installs the optional runtime packages into the disclaude install root with --no-save --package-lock=false; package.json and every lockfile stay untouched.',
    notes,
  };
}

export interface InstallExecution {
  status: InstallStatus;
  plan: InstallPlan;
  executed: boolean;
  /** Confirmation refusal reason for aborted runs. */
  abortReason?: string;
  /** Child process outcome for executed runs. */
  process?: { code: number; stdoutTail: string; stderrTail: string };
  /** Human-readable failure detail when status is 'failed'. */
  failure?: string;
}

export interface ExecuteOptions {
  runner: ProcessRunner;
  dryRun?: boolean;
  /** Skips confirmation when true (--yes). */
  assumeYes?: boolean;
  /** Returns whether to proceed; the plan is shown for an informed choice. */
  confirm?: (plan: InstallPlan) => Promise<boolean>;
}

const ACTION_STATUS: Record<
  Exclude<InstallAction, 'skip'>,
  Exclude<InstallStatus, 'skipped' | 'aborted' | 'dry-run' | 'failed'>
> = {
  install: 'installed',
  upgrade: 'upgraded',
  repair: 'repaired',
};

/** Execute (or skip/dry-run/abort) a plan produced by {@link planHarnessInstall}. */
export async function runHarnessInstall(
  plan: InstallPlan,
  options: ExecuteOptions
): Promise<InstallExecution> {
  if (plan.action === 'skip') {
    return { status: 'skipped', plan, executed: false };
  }
  if (options.dryRun) {
    return { status: 'dry-run', plan, executed: false };
  }
  if (!options.assumeYes && options.confirm && !(await options.confirm(plan))) {
    return { status: 'aborted', plan, executed: false, abortReason: 'not confirmed' };
  }
  const result: RunnerResult = await options.runner.run(plan.program, plan.args, {
    cwd: plan.cwd,
    timeoutMs: 600_000,
  });
  const tail = (text: string): string => (text.length > 2_000 ? text.slice(-2_000) : text);
  const execution: InstallExecution = {
    status: result.code === 0 ? ACTION_STATUS[plan.action] : 'failed',
    plan,
    executed: result.code === 0,
    process: {
      code: result.code,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    },
  };
  if (result.code !== 0) {
    execution.failure = `${plan.program} exited with code ${result.code}`;
  }
  return execution;
}
