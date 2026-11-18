/**
 * Install planning and execution tests (Issue #5169). All package-manager
 * traffic goes through a scripted fake runner; filesystem probes run against
 * temporary fixture trees. Nothing here installs a real package.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planHarnessInstall, runHarnessInstall, type InstallPlan } from './install.js';
import type { ProcessRunner, RunnerResult } from './types.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'disclaude-harness-install-'));
  directories.push(directory);
  return directory;
}

/** Stub package manager: scripted replies in call order, full call log. */
class ScriptedRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd?: string; timeoutMs?: number }> = [];
  private nextIndex = 0;

  constructor(private readonly replies: Array<Partial<RunnerResult>> = []) {}

  run(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number } = {}
  ): Promise<RunnerResult> {
    this.calls.push({ command, args, cwd: options.cwd, timeoutMs: options.timeoutMs });
    const reply = this.replies[this.nextIndex++] ?? { code: 0, stdout: '', stderr: '' };
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...reply });
  }
}

function npmGlobals(packages: Record<string, string>, prefix = '/usr/local/lib'): ScriptedRunner {
  return new ScriptedRunner([
    {
      stdout: JSON.stringify({
        dependencies: Object.fromEntries(
          Object.entries(packages).map(([name, version]) => [name, { version }])
        ),
      }),
    },
    { stdout: `${prefix}\n` },
  ]);
}

/** Core fixture; extra packages materialize under root/node_modules. */
function coreFixture(root: string): string {
  const core = join(root, 'packages', 'core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, 'package.json'), '{"name":"@disclaude/core","version":"0.6.7"}');
  return core;
}

function materializePackage(root: string, name: string, version: string): void {
  const packageDir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'index.js'), 'module.exports = {};\n');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js' })
  );
}

function pathWithBinary(binary: string): { root: string; env: { PATH: string } } {
  const root = tempDirectory();
  writeFileSync(join(root, binary), '#!/bin/sh\n', { mode: 0o755 });
  return { root, env: { PATH: `/nonexistent:${root}` } };
}

const PLAN_OPTIONS = {
  installRoot: '/opt/disclaude',
};

describe('path-cli install plans (claude / codex / dsh)', () => {
  it('plans a fresh npm -g install for a missing package', async () => {
    const runner = npmGlobals({});
    const plan = await planHarnessInstall('codex', {
      runner,
      env: { PATH: '/nonexistent' },
      ...PLAN_OPTIONS,
    });
    expect(plan.action).toBe('install');
    expect(plan.reason).toContain('not present in the npm global prefix');
    expect(plan.program).toBe('npm');
    expect(plan.args).toEqual(['install', '-g', '@openai/codex@0.154.0']);
    expect(plan.command).toBe('npm install -g @openai/codex@0.154.0');
    expect(plan.version).toMatchObject({
      value: '0.154.0',
      source: expect.stringContaining('Dockerfile.service'),
      overridden: false,
    });
    expect(plan.targets).toEqual([{ name: '@openai/codex', version: '0.154.0' }]);
    expect(plan.writes).toEqual(['npm global prefix: /usr/local/lib']);
    expect(plan.permissionNote).toContain('global prefix');
  });

  it('skips idempotently when the target version is installed and on PATH', async () => {
    const { env } = pathWithBinary('codex');
    const runner = npmGlobals({ '@openai/codex': '0.154.0' });
    const plan = await planHarnessInstall('codex', { runner, env, ...PLAN_OPTIONS });
    expect(plan.action).toBe('skip');
    expect(plan.reason).toContain('@openai/codex@0.154.0');
    expect(plan.reason).toContain('discoverable on PATH');
    expect(plan.args).toEqual([]);
  });

  it('plans an upgrade from an older installed version', async () => {
    const { env } = pathWithBinary('codex');
    const runner = npmGlobals({ '@openai/codex': '0.151.0' });
    const plan = await planHarnessInstall('codex', { runner, env, ...PLAN_OPTIONS });
    expect(plan.action).toBe('upgrade');
    expect(plan.reason).toBe('@openai/codex 0.151.0 is installed, target is 0.154.0');
    expect(plan.targets).toEqual([
      { name: '@openai/codex', version: '0.154.0', current: '0.151.0' },
    ]);
  });

  it('plans a repair when the package is installed but its binary is off PATH', async () => {
    const runner = npmGlobals({ '@deepseek-ai/dsh': '0.1.2-rc.1' });
    const plan = await planHarnessInstall('dsh', {
      runner,
      env: { PATH: '/nonexistent' },
      ...PLAN_OPTIONS,
    });
    expect(plan.action).toBe('repair');
    expect(plan.reason).toContain('`dsh` is not on PATH');
    expect(plan.args).toEqual(['install', '-g', '@deepseek-ai/dsh@0.1.2-rc.1']);
  });

  it('applies --version and environment overrides with explicit sources', async () => {
    const runner = npmGlobals({});
    const flagged = await planHarnessInstall('codex', {
      runner,
      env: { PATH: '/nonexistent', DISCLAUDE_HARNESS_CODEX_VERSION: '0.160.0' },
      flagVersion: '0.199.0',
      ...PLAN_OPTIONS,
    });
    expect(flagged.args).toEqual(['install', '-g', '@openai/codex@0.199.0']);
    expect(flagged.version.overridden).toBe('flag');

    const fromEnv = await planHarnessInstall('codex', {
      runner,
      env: { PATH: '/nonexistent', DISCLAUDE_HARNESS_CODEX_VERSION: '0.160.0' },
      ...PLAN_OPTIONS,
    });
    expect(fromEnv.args).toEqual(['install', '-g', '@openai/codex@0.160.0']);
    expect(fromEnv.version.source).toBe('environment DISCLAUDE_HARNESS_CODEX_VERSION');
    expect(fromEnv.version.overridden).toBe('env');
  });

  it('ignores the removed DISCLAUDE_BACKEND_<ID>_VERSION legacy spelling', async () => {
    // Maintenance review on #5709: no legacy key aliasing is kept; the repo pin
    // wins when only the removed spelling is set.
    const runner = npmGlobals({});
    const plan = await planHarnessInstall('codex', {
      runner,
      env: { PATH: '/nonexistent', DISCLAUDE_BACKEND_CODEX_VERSION: '0.160.0' },
      ...PLAN_OPTIONS,
    });
    expect(plan.args).toEqual(['install', '-g', '@openai/codex@0.154.0']);
  });

  it('passes a registry mirror through to npm', async () => {
    const runner = npmGlobals({});
    const plan = await planHarnessInstall('codex', {
      runner,
      env: { PATH: '/nonexistent' },
      registry: 'https://mirror.example.com',
      ...PLAN_OPTIONS,
    });
    expect(plan.args.slice(-2)).toEqual(['--registry', 'https://mirror.example.com']);
  });

  it('pins the claude standalone CLI to the bundled SDK Claude Code version', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    materializePackage(root, '@anthropic-ai/claude-agent-sdk', '0.3.263');
    const sdkManifest = join(
      root,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json'
    );
    writeFileSync(
      sdkManifest,
      JSON.stringify({
        name: '@anthropic-ai/claude-agent-sdk',
        version: '0.3.263',
        main: 'index.js',
        claudeCodeVersion: '2.1.263',
      })
    );
    const { env } = pathWithBinary('claude');
    const runner = npmGlobals({ '@anthropic-ai/claude-code': '2.1.263' });
    const plan = await planHarnessInstall('claude', {
      runner,
      env,
      installRoot: root,
      coreDir: core,
    });
    expect(plan.action).toBe('skip');
    expect(plan.version.value).toBe('2.1.263');
    expect(plan.version.source).toContain('claude-agent-sdk');
    expect(plan.notes.join(' ')).toContain('bundled');

    const installing = await planHarnessInstall('claude', {
      runner: npmGlobals({}),
      env: { PATH: '/nonexistent' },
      installRoot: root,
      coreDir: core,
    });
    expect(installing.args).toEqual(['install', '-g', '@anthropic-ai/claude-code@2.1.263']);
  });
});

describe('pi runtime plans (production Node module resolution)', () => {
  it('installs both runtime packages without touching package.json or a lockfile', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    const plan = await planHarnessInstall('pi', {
      runner: new ScriptedRunner(),
      env: {},
      installRoot: root,
      coreDir: core,
    });
    expect(plan.action).toBe('install');
    expect(plan.sourceTree).toBe(false);
    expect(plan.packageManager).toBe('npm');
    expect(plan.args).toEqual([
      'install',
      '--no-save',
      '--package-lock=false',
      '@earendil-works/pi-agent-core@0.83.0',
      '@earendil-works/pi-ai@0.83.0',
    ]);
    expect(plan.cwd).toBe(root);
    expect(plan.writes).toEqual([`${join(root, 'node_modules')} (optional runtime packages only)`]);
    expect(plan.permissionNote).toContain('--no-save');
    expect(plan.targets.map((target) => target.name)).toEqual([
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
    ]);
  });

  it('skips when both packages already resolve at the pinned version', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    materializePackage(root, '@earendil-works/pi-agent-core', '0.83.0');
    materializePackage(root, '@earendil-works/pi-ai', '0.83.0');
    const plan = await planHarnessInstall('pi', {
      runner: new ScriptedRunner(),
      env: {},
      installRoot: root,
      coreDir: core,
    });
    expect(plan.action).toBe('skip');
    expect(plan.reason).toContain('already resolve at 0.83.0');
    expect(plan.writes).toEqual([]);
  });

  it('plans an upgrade when a different version resolves', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    materializePackage(root, '@earendil-works/pi-agent-core', '0.84.4');
    materializePackage(root, '@earendil-works/pi-ai', '0.84.4');
    const plan = await planHarnessInstall('pi', {
      runner: new ScriptedRunner(),
      env: {},
      installRoot: root,
      coreDir: core,
    });
    expect(plan.action).toBe('upgrade');
    expect(plan.reason).toContain('0.84.4');
    expect(plan.command).toContain('--package-lock=false');
  });

  it('uses the documented pnpm optional-dependency workflow in source worktrees', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const plan = await planHarnessInstall('pi', {
      runner: new ScriptedRunner(),
      env: {},
      installRoot: root,
      coreDir: core,
    });
    expect(plan.sourceTree).toBe(true);
    expect(plan.packageManager).toBe('pnpm');
    expect(plan.program).toBe('corepack');
    expect(plan.args).toEqual([
      'pnpm',
      '--filter',
      '@disclaude/core',
      'add',
      '--save-optional',
      '--save-exact',
      '@earendil-works/pi-agent-core@0.83.0',
      '@earendil-works/pi-ai@0.83.0',
    ]);
    expect(plan.writes).toEqual([
      `${join(root, 'packages', 'core', 'package.json')} (optionalDependencies)`,
      join(root, 'pnpm-lock.yaml'),
    ]);
    expect(plan.permissionNote).toContain('optionalDependencies');
  });

  it('records the pi Node.js requirement in plan notes', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    const plan = await planHarnessInstall('pi', {
      runner: new ScriptedRunner(),
      env: {},
      installRoot: root,
      coreDir: core,
    });
    expect(plan.notes.join(' ')).toContain('22.19.0');
  });
});

describe('runHarnessInstall execution paths', () => {
  const plan = (action: InstallPlan['action']): InstallPlan => ({
    action,
    harness: 'codex',
    reason: 'test',
    sourceTree: false,
    packageManager: 'npm',
    command: 'npm install -g @openai/codex@0.154.0',
    program: 'npm',
    args: ['install', '-g', '@openai/codex@0.154.0'],
    cwd: '/opt/disclaude',
    targets: [{ name: '@openai/codex', version: '0.154.0' }],
    version: {
      value: '0.154.0',
      source: 'Dockerfile.service ARG CODEX_VERSION',
      overridden: false,
    },
    writes: [],
    permissionNote: 'test',
    notes: [],
  });

  it('skips without running anything when the plan already matches', async () => {
    const runner = new ScriptedRunner();
    const execution = await runHarnessInstall(plan('skip'), { runner });
    expect(execution).toMatchObject({ status: 'skipped', executed: false });
    expect(runner.calls).toHaveLength(0);
  });

  it('dry-run reports the plan without executing it', async () => {
    const runner = new ScriptedRunner();
    const execution = await runHarnessInstall(plan('install'), { runner, dryRun: true });
    expect(execution).toMatchObject({ status: 'dry-run', executed: false });
    expect(runner.calls).toHaveLength(0);
  });

  it('aborts when confirmation is refused', async () => {
    const runner = new ScriptedRunner();
    const execution = await runHarnessInstall(plan('upgrade'), {
      runner,
      confirm: () => Promise.resolve(false),
    });
    expect(execution).toMatchObject({
      status: 'aborted',
      executed: false,
      abortReason: 'not confirmed',
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('executes the planned command with --yes and reports the action outcome', async () => {
    const runner = new ScriptedRunner([{ code: 0, stdout: 'added 1 package', stderr: 'npm warn' }]);
    const execution = await runHarnessInstall(plan('upgrade'), { runner, assumeYes: true });
    expect(execution).toMatchObject({ status: 'upgraded', executed: true });
    expect(runner.calls).toEqual([
      {
        command: 'npm',
        args: ['install', '-g', '@openai/codex@0.154.0'],
        cwd: '/opt/disclaude',
        timeoutMs: 600_000,
      },
    ]);
    expect(execution.process).toMatchObject({ code: 0, stdoutTail: 'added 1 package' });
  });

  it('reports a failed install with the child exit code', async () => {
    const runner = new ScriptedRunner([
      { code: 1, stdout: '', stderr: 'EACCES: permission denied' },
    ]);
    const execution = await runHarnessInstall(plan('install'), { runner, assumeYes: true });
    expect(execution).toMatchObject({ status: 'failed', executed: false });
    expect(execution.failure).toBe('npm exited with code 1');
    expect(execution.process?.stderrTail).toContain('EACCES');
  });

  it('maps repair actions to their own status', async () => {
    const runner = new ScriptedRunner([{ code: 0 }]);
    const execution = await runHarnessInstall(plan('repair'), { runner, assumeYes: true });
    expect(execution.status).toBe('repaired');
  });
});
