/**
 * `disclaude harness` CLI (Issue #5169): one idempotent entry point to list,
 * install and doctor the agent harness runtimes (claude / pi / codex / dsh).
 *
 * Output contract matches the other unified-CLI commands: one JSON object per
 * invocation on stdout (`{ok, command, data}` or `{ok:false, error}`), nonzero
 * exit on failure. Installs always produce an explicit plan; without --yes the
 * plan (targets, versions, package manager, writes) is shown for confirmation
 * on stderr before anything runs, and --dry-run prints the plan only. The CLI
 * never reads or writes API keys, tokens or login sessions.
 */

import { resolve as resolvePath } from 'node:path';
import {
  HARNESS_IDS,
  harnessCatalog,
  harnessVersionEnvKey,
  resolveHarnessId,
  resolveHarnessVersion,
} from './registry.js';
import {
  bundledClaudeRuntime,
  corePackageDir,
  findOnPath,
  npmGlobalPackages,
  npmGlobalPrefix,
  resolveNodeModules,
  type BundledClaudeRuntime,
} from './detect.js';
import {
  planHarnessInstall,
  runHarnessInstall,
  type InstallExecution,
  type InstallPlan,
} from './install.js';
import { doctorHarness, type HarnessDoctorReport } from './doctor.js';
import { createDefaultRunner, type HarnessId, type ProcessRunner } from './types.js';

const HELP = `disclaude harness - install and check agent harness runtimes

Usage:
  disclaude harness list
  disclaude harness install <claude|pi|codex|dsh> [--version V] [--registry URL] [--dry-run] [--yes]
  disclaude harness doctor [claude|pi|codex|dsh]

Commands:
  list     Supported harnesses: install target, expected version and where it is
           pinned, current install state, and auth next steps.
  install  Idempotent install. claude/codex/dsh CLI binaries go into the npm
           global prefix (PATH); the pi runtime installs as optional Node
           modules under production Node module resolution. An already-correct
           install is skipped with its version; a differing version upgrades;
           a package whose binary fell off PATH is repaired.
  doctor   Verify discoverability the way the service resolves each harness:
           PATH binaries for codex/dsh, module resolution and Node >= 22.19.0
           for pi, and the pinned agent SDK for the claude service runtime.

Options:
  --version V       Pin a specific harness version (overrides the repo pin).
  --registry URL    npm/pnpm registry mirror, e.g. for offline installs.
  --dry-run         Print the plan (targets, versions, package manager,
                    command, writes/permissions) without installing.
  --yes             Skip the interactive confirmation.
  --help, -h        Show this help.

Version defaults and overrides: --version, or environment
DISCLAUDE_HARNESS_<CLAUDE|PI|CODEX|DSH>_VERSION (the legacy
DISCLAUDE_BACKEND_<ID>_VERSION spelling is still honored). Defaults: claude
follows the Claude Code version bundled in this disclaude's pinned agent SDK;
pi follows docs/pi-backend.md; codex/dsh follow the Dockerfile.service build
pins.

Compatibility: 'disclaude backend ...' still works as a deprecated alias of
'disclaude harness ...'. Pre-existing configuration keeps its spelling: the
agent.agentBackend config key and docs file names such as docs/pi-backend.md
are unchanged by this command family.

This CLI never reads or writes API keys, tokens or login sessions; harnesses
that need independent authentication (codex login, standalone claude) get an
explicit next step instead.`;

class UsageError extends Error {}

interface ParsedInstallArgs {
  harness: string;
  flagVersion?: string;
  registry?: string;
  dryRun: boolean;
  yes: boolean;
}

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+\-]*$/;

function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const parsed: ParsedInstallArgs = { harness: '', dryRun: false, yes: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const valueFlag = /^--(version|registry)(?:=(.*))?$/.exec(arg);
    if (valueFlag) {
      const [, key, inline] = valueFlag as unknown as [
        string,
        'version' | 'registry',
        string | undefined,
      ];
      const value = inline !== undefined ? inline : args[++index];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new UsageError(`Expected a value for --${key}`);
      }
      if (key === 'version') {
        if (!VERSION_PATTERN.test(value)) {
          throw new UsageError(`Invalid --version value: ${value}`);
        }
        parsed.flagVersion = value;
      } else {
        if (!/^https?:\/\//.test(value)) {
          throw new UsageError(`Invalid --registry URL: ${value}`);
        }
        parsed.registry = value;
      }
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new UsageError(`Unknown install option: ${arg}`);
    }
    if (!parsed.harness) {
      parsed.harness = arg;
      continue;
    }
    throw new UsageError(`Unexpected install argument: ${arg}`);
  }
  if (!parsed.harness) {
    throw new UsageError('Expected a harness: claude | pi | codex | dsh');
  }
  return parsed;
}

function parseDoctorArgs(args: string[]): { harness?: string } {
  if (args.length > 1) {
    throw new UsageError('doctor takes at most one harness name');
  }
  const [first] = args;
  if (first !== undefined && first.startsWith('--')) {
    throw new UsageError(`Unknown doctor option: ${first}`);
  }
  return first === undefined ? {} : { harness: first };
}

export interface HarnessCliOptions {
  /** Disclaude install root or source checkout root. */
  installRoot: string;
  /** @disclaude/core package directory; defaults to the running package. */
  coreDir?: string;
  env?: Record<string, string | undefined>;
  runner?: ProcessRunner;
  /** Injectable Node version for doctor tests. */
  nodeVersion?: string;
  /** Confirmation callback; defaults to a TTY prompt (non-TTY refuses). */
  confirm?: (plan: InstallPlan) => Promise<boolean>;
  /** Output sink for the single JSON line; defaults to console.log. */
  write?: (line: string) => void;
}

export interface HarnessListEntry {
  id: HarnessId;
  label: string;
  aliases: string[];
  installTarget: string;
  packages: Array<{
    name: string;
    expectedVersion: string;
    versionSource: string;
    overridden: boolean;
  }>;
  binaries: string[];
  current: {
    state: 'installed' | 'not-installed' | 'partial' | 'unknown';
    versions: Record<string, string | undefined>;
    detail: string;
  };
  serviceRuntime?: BundledClaudeRuntime;
  auth: { independent: boolean; nextStep: string };
  docs: string;
  versionEnvKey: string;
}

async function listHarnesses(
  options: Required<Pick<HarnessCliOptions, 'runner' | 'env' | 'installRoot'>> & { coreDir: string }
): Promise<HarnessListEntry[]> {
  const globals = await npmGlobalPackages(options.runner);
  const globalPrefix = await npmGlobalPrefix(options.runner);
  const claudeBundled = bundledClaudeRuntime(options.coreDir);
  return HARNESS_IDS.map((id) => {
    const entry = harnessCatalog(id);
    const version = resolveHarnessVersion(id, {
      env: options.env,
      claudeBundledVersion: claudeBundled.claudeCodeVersion,
    });
    let current: HarnessListEntry['current'];
    if (entry.installTarget === 'node-modules') {
      const resolved = resolveNodeModules(options.coreDir, entry.packages);
      const installedCount = entry.packages.filter((name) => resolved[name]?.resolved).length;
      current = {
        state:
          installedCount === 0
            ? 'not-installed'
            : installedCount === entry.packages.length
              ? 'installed'
              : 'partial',
        versions: Object.fromEntries(entry.packages.map((name) => [name, resolved[name]?.version])),
        detail: entry.packages
          .map((name) =>
            resolved[name]?.resolved
              ? `${name}@${resolved[name]?.version ?? '?'} resolves from ${options.coreDir}`
              : `${name} does not resolve`
          )
          .join('; '),
      };
    } else {
      const [pkg] = entry.packages;
      const installed = globals[pkg];
      const [binary] = entry.binaries;
      const binaryPath = findOnPath(binary, options.env);
      current = {
        state: installed ? 'installed' : 'not-installed',
        versions: installed ? { [pkg]: installed } : {},
        detail: installed
          ? `${pkg}@${installed} in the npm global prefix${globalPrefix ? ` (${globalPrefix})` : ''}; \`${entry.binaries[0]}\` ${binaryPath ? `on PATH at ${binaryPath}` : 'NOT on PATH'}`
          : `${pkg} is not in the npm global prefix; \`${entry.binaries[0]}\` ${binaryPath ? `still discoverable at ${binaryPath} (installed outside npm)` : 'not on PATH'}`,
      };
    }
    return {
      id,
      label: entry.label,
      aliases: entry.aliases,
      installTarget: entry.installTarget,
      packages: entry.packages.map((name) => ({
        name,
        expectedVersion: version.value,
        versionSource: version.source,
        overridden: version.overridden !== false,
      })),
      binaries: entry.binaries,
      current,
      ...(id === 'claude' ? { serviceRuntime: claudeBundled } : {}),
      auth: entry.auth,
      docs: entry.docs,
      versionEnvKey: harnessVersionEnvKey(id),
    };
  });
}

function createDefaultConfirm(): (plan: InstallPlan) => Promise<boolean> {
  return async (plan) => {
    const { stdin } = process;
    if (!stdin.isTTY) {
      return false;
    }
    const summary = [
      `[${plan.action}] ${plan.reason}`,
      `command: ${plan.command}`,
      `package manager: ${plan.packageManager} (cwd ${plan.cwd})`,
      `targets: ${plan.targets.map((target) => `${target.name}@${target.version}${target.current ? ` (current ${target.current})` : ''}`).join(', ')}`,
      `writes: ${plan.writes.join('; ') || 'nothing'}`,
      plan.permissionNote,
      'Proceed? [y/N] ',
    ].join('\n');
    const { createInterface } = await import('node:readline');
    const readline = createInterface({ input: stdin, output: process.stderr });
    try {
      const answer = await new Promise<string>((resolve) => {
        readline.question(summary, resolve);
      });
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      readline.close();
    }
  };
}

/** Run the `disclaude harness` CLI; returns the process exit code. */
export async function runHarnessCli(args: string[], options: HarnessCliOptions): Promise<number> {
  const write = options.write ?? ((line: string) => console.log(line));
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultRunner(env);
  const coreDir = options.coreDir ?? corePackageDir();
  const installRoot = resolvePath(options.installRoot);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    write(HELP);
    return 0;
  }
  const [command] = args;
  try {
    switch (command) {
      case 'list': {
        if (args.length > 1) {
          throw new UsageError(`Unexpected list argument: ${args[1]}`);
        }
        const harnesses = await listHarnesses({ runner, env, installRoot, coreDir });
        write(JSON.stringify({ ok: true, command, data: { harnesses } }));
        return 0;
      }
      case 'install': {
        const parsed = parseInstallArgs(args.slice(1));
        const id = resolveHarnessId(parsed.harness);
        if (!id) {
          throw new UsageError(
            `Unknown harness: ${parsed.harness}. Supported: ${HARNESS_IDS.join(', ')} (alias: deepseek → dsh).`
          );
        }
        const plan = await planHarnessInstall(id, {
          runner,
          env,
          installRoot,
          coreDir,
          flagVersion: parsed.flagVersion,
          registry: parsed.registry,
        });
        const execution: InstallExecution = await runHarnessInstall(plan, {
          runner,
          dryRun: parsed.dryRun,
          assumeYes: parsed.yes,
          confirm: options.confirm ?? createDefaultConfirm(),
        });
        if (execution.status === 'failed') {
          write(
            JSON.stringify({
              ok: false,
              command,
              error: { message: execution.failure, plan, process: execution.process },
            })
          );
          return 1;
        }
        if (execution.status === 'aborted') {
          write(
            JSON.stringify({
              ok: true,
              command,
              data: {
                ...execution,
                hint: 'Not confirmed: re-run with --yes (non-interactive) or answer the prompt; --dry-run previews the plan.',
              },
            })
          );
          return 0;
        }
        write(JSON.stringify({ ok: true, command, data: execution }));
        return 0;
      }
      case 'doctor': {
        const parsed = parseDoctorArgs(args.slice(1));
        const ids: HarnessId[] = [];
        if (parsed.harness !== undefined) {
          const id = resolveHarnessId(parsed.harness);
          if (!id) {
            throw new UsageError(
              `Unknown harness: ${parsed.harness}. Supported: ${HARNESS_IDS.join(', ')} (alias: deepseek → dsh).`
            );
          }
          ids.push(id);
        } else {
          ids.push(...HARNESS_IDS);
        }
        const reports: HarnessDoctorReport[] = [];
        for (const id of ids) {
          reports.push(
            await doctorHarness(id, {
              runner,
              env,
              coreDir,
              installRoot,
              nodeVersion: options.nodeVersion,
            })
          );
        }
        const allOk = reports.every((report) => report.ok);
        write(JSON.stringify({ ok: allOk, command, data: { harnesses: reports } }));
        return allOk ? 0 : 1;
      }
      default:
        throw new UsageError(`Unknown harness command: ${command}. Use list, install or doctor.`);
    }
  } catch (error) {
    write(
      JSON.stringify({
        ok: false,
        command:
          command === 'list' || command === 'install' || command === 'doctor' ? command : undefined,
        error: { message: error instanceof Error ? error.message : String(error) },
      })
    );
    return 1;
  }
}
