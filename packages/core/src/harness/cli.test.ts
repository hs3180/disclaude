/**
 * CLI contract tests for `disclaude harness` (Issue #5169): argument parsing,
 * JSON output shape, exit codes, dry-run/confirmation wiring and unknown
 * harness errors. The package manager is always a scripted fake.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHarnessCli } from './cli.js';
import type { InstallPlan } from './install.js';
import type { ProcessRunner, RunnerResult } from './types.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'disclaude-harness-cli-'));
  directories.push(directory);
  return directory;
}

class ScriptedRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  private readonly pending: Array<Partial<RunnerResult>> = [];

  constructor(replies: Array<Partial<RunnerResult>> = []) {
    this.pending.push(...replies);
  }

  /** Queue npm probe results (globals, then prefix) followed by extra replies. */
  static npmGlobals(packages: Record<string, string>, prefix = '/usr/local/lib'): ScriptedRunner {
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

  queue(stdout: string, stderr: string): void {
    this.pending.push({ stdout, stderr });
  }

  queueError(reply: Partial<RunnerResult>): void {
    this.pending.push(reply);
  }

  run(command: string, args: string[]): Promise<RunnerResult> {
    this.calls.push({ command, args });
    const reply = this.pending.shift() ?? { code: 0, stdout: '', stderr: '' };
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...reply });
  }

  installCalls(): number {
    return this.calls.filter((call) => call.args.includes('install')).length;
  }
}

/** Core fixture with the agent SDK so claude planning has a bundled version. */
function coreFixture(): { root: string; core: string } {
  const root = tempDirectory();
  const core = join(root, 'packages', 'core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, 'package.json'), '{"name":"@disclaude/core","version":"0.6.7"}');
  const sdk = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, 'index.js'), 'module.exports = {};\n');
  writeFileSync(
    join(sdk, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.3.263',
      main: 'index.js',
      claudeCodeVersion: '2.1.263',
    })
  );
  return { root, core };
}

const npmGlobals = (packages: Record<string, string>): ScriptedRunner =>
  ScriptedRunner.npmGlobals(packages);

describe('help and usage', () => {
  it('prints help for no arguments or --help and exits 0', async () => {
    for (const args of [[], ['--help'], ['-h']]) {
      const lines: string[] = [];
      const code = await runHarnessCli(args, {
        installRoot: '/opt/disclaude',
        write: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('Usage:');
      expect(lines.join('\n')).toContain('disclaude harness install');
      const help = lines.join('\n');
      expect(help).toContain('DISCLAUDE_HARNESS_<CLAUDE|PI|CODEX|DSH>_VERSION');
      expect(help).toContain("'disclaude backend ...' no longer runs");
      expect(help).toContain('agent.agentBackend');
    }
  });

  it('rejects unknown subcommands, extra arguments and unknown flags', async () => {
    for (const args of [
      ['frobnicate'],
      ['list', 'extra'],
      ['doctor', 'codex', 'dsh'],
      ['doctor', '--deep'],
      ['install', 'codex', '--nonsense'],
    ]) {
      const lines: string[] = [];
      const code = await runHarnessCli(args, {
        installRoot: '/opt/disclaude',
        write: (line) => lines.push(line),
      });
      expect(code, JSON.stringify(args)).toBe(1);
      expect(JSON.parse(lines[0])).toMatchObject({ ok: false });
    }
  });
});

describe('list', () => {
  it('reports every harness with version sources and current state', async () => {
    const { root, core } = coreFixture();
    const runner = npmGlobals({ '@openai/codex': '0.151.0' });
    const lines: string[] = [];
    const code = await runHarnessCli(['list'], {
      installRoot: root,
      coreDir: core,
      env: { PATH: '/nonexistent' },
      runner,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.harnesses.map((entry: { id: string }) => entry.id)).toEqual([
      'claude',
      'pi',
      'codex',
      'dsh',
    ]);
    const codex = parsed.data.harnesses.find((entry: { id: string }) => entry.id === 'codex');
    expect(codex.current).toMatchObject({ state: 'installed' });
    expect(codex.current.versions).toEqual({ '@openai/codex': '0.151.0' });
    expect(codex.current.detail).toContain('NOT on PATH');
    expect(codex.packages[0]).toMatchObject({
      expectedVersion: '0.154.0',
      versionSource: expect.stringContaining('Dockerfile.service'),
    });
    const claude = parsed.data.harnesses.find((entry: { id: string }) => entry.id === 'claude');
    expect(claude.packages[0].expectedVersion).toBe('2.1.263');
    expect(claude.serviceRuntime).toMatchObject({ claudeCodeVersion: '2.1.263' });
    const pi = parsed.data.harnesses.find((entry: { id: string }) => entry.id === 'pi');
    expect(pi.installTarget).toBe('node-modules');
    expect(pi.current.state).toBe('not-installed');
    expect(pi.versionEnvKey).toBe('DISCLAUDE_HARNESS_PI_VERSION');
  });
});

describe('install', () => {
  const base = (
    runner: ProcessRunner,
    core: string,
    root: string,
    extra: Record<string, unknown> = {}
  ) => ({
    installRoot: root,
    coreDir: core,
    env: { PATH: '/nonexistent' },
    runner,
    write: (line: string) => lines.push(line),
    ...extra,
  });
  let lines: string[] = [];

  it('rejects unknown harnesses with the supported list', async () => {
    lines = [];
    const { root, core } = coreFixture();
    const code = await runHarnessCli(['install', 'gemini'], base(new ScriptedRunner(), core, root));
    expect(code).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain('claude, pi, codex, dsh');
    expect(parsed.error.message).toContain('deepseek');
  });

  it('requires a harness name and validates flag values', async () => {
    lines = [];
    const { root, core } = coreFixture();
    for (const args of [
      ['install'],
      ['install', 'codex', '--version'],
      ['install', 'codex', '--version', '-bad version!'],
      ['install', 'codex', '--registry', 'not-a-url'],
    ]) {
      const code = await runHarnessCli(args, base(new ScriptedRunner(), core, root));
      expect(code, JSON.stringify(args)).toBe(1);
      expect(JSON.parse(lines[0]).ok).toBe(false);
      lines = [];
    }
  });

  it('dry-run prints the plan without contacting the package manager for an install', async () => {
    const { root, core } = coreFixture();
    const runner = npmGlobals({});
    lines = [];
    const code = await runHarnessCli(['install', 'codex', '--dry-run'], base(runner, core, root));
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ ok: true, command: 'install' });
    expect(parsed.data.status).toBe('dry-run');
    expect(parsed.data.plan.command).toBe('npm install -g @openai/codex@0.154.0');
    expect(parsed.data.plan.version.source).toContain('Dockerfile.service');
    expect(runner.installCalls()).toBe(0);
  });

  it('aborts without --yes when confirmation is refused (non-interactive default)', async () => {
    const { root, core } = coreFixture();
    const runner = npmGlobals({});
    lines = [];
    const code = await runHarnessCli(['install', 'codex'], base(runner, core, root));
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.data).toMatchObject({ status: 'aborted', abortReason: 'not confirmed' });
    expect(runner.installCalls()).toBe(0);
  });

  it('installs with --yes through the scripted package manager', async () => {
    const { root, core } = coreFixture();
    const runner = npmGlobals({});
    runner.queue('', '');
    lines = [];
    const code = await runHarnessCli(['install', 'codex', '--yes'], base(runner, core, root));
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.data).toMatchObject({ status: 'installed', executed: true });
    expect(parsed.data.plan.action).toBe('install');
    expect(runner.installCalls()).toBe(1);
  });

  it('reports a failed install as a nonzero-exit JSON error', async () => {
    const { root, core } = coreFixture();
    const runner = npmGlobals({});
    runner.queueError({ code: 1, stderr: 'network unreachable' });
    lines = [];
    const code = await runHarnessCli(['install', 'codex', '--yes'], base(runner, core, root));
    expect(code).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain('exited with code 1');
    expect(parsed.error.plan.harness).toBe('codex');
  });

  it('skips idempotently when the target version is already installed', async () => {
    const { root, core } = coreFixture();
    const bin = tempDirectory();
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    const runner = npmGlobals({ '@openai/codex': '0.154.0' });
    lines = [];
    const code = await runHarnessCli(['install', 'codex', '--yes'], {
      ...base(runner, core, root),
      env: { PATH: `/nonexistent:${bin}` },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.data).toMatchObject({ status: 'skipped', executed: false });
    expect(parsed.data.plan.reason).toContain('0.154.0');
    expect(runner.installCalls()).toBe(0);
  });

  it('accepts the deepseek alias for dsh and a --version pin', async () => {
    const { root, core } = coreFixture();
    const runner = npmGlobals({});
    runner.queue('', '');
    lines = [];
    const code = await runHarnessCli(
      ['install', 'deepseek', '--version', '0.2.0', '--yes'],
      base(runner, core, root)
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.data.plan.harness).toBe('dsh');
    expect(parsed.data.plan.args).toEqual(['install', '-g', '@deepseek-ai/dsh@0.2.0']);
    expect(parsed.data.plan.version.overridden).toBe('flag');
  });
});

describe('doctor', () => {
  it('fails with exit 1 when a required harness is not discoverable', async () => {
    const { root, core } = coreFixture();
    const lines: string[] = [];
    const code = await runHarnessCli(['doctor', 'codex'], {
      installRoot: root,
      coreDir: core,
      env: { PATH: '/nonexistent' },
      runner: npmGlobals({}),
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.data.harnesses[0].ok).toBe(false);
  });

  it('passes for a discoverable harness and exits 0', async () => {
    const { root, core } = coreFixture();
    const bin = tempDirectory();
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    const lines: string[] = [];
    const code = await runHarnessCli(['doctor', 'codex'], {
      installRoot: root,
      coreDir: core,
      env: { PATH: `/nonexistent:${bin}` },
      runner: npmGlobals({ '@openai/codex': '0.154.0' }),
      write: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]).data.harnesses[0].ok).toBe(true);
  });

  it('doctors every harness when no harness is named', async () => {
    const { root, core } = coreFixture();
    const lines: string[] = [];
    const code = await runHarnessCli(['doctor'], {
      installRoot: root,
      coreDir: core,
      env: { PATH: '/nonexistent' },
      runner: npmGlobals({}),
      nodeVersion: 'v22.23.4',
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(lines[0]);
    const ids = parsed.data.harnesses.map((report: { harness: string }) => report.harness);
    expect(ids).toEqual(['claude', 'pi', 'codex', 'dsh']);
    // claude passes via the fixture SDK; pi/codex/dsh fail (not installed).
    const byId = Object.fromEntries(
      parsed.data.harnesses.map((report: { harness: string; ok: boolean }) => [
        report.harness,
        report.ok,
      ])
    );
    expect(byId).toEqual({ claude: true, pi: false, codex: false, dsh: false });
  });

  it('rejects unknown doctor harnesses', async () => {
    const { root, core } = coreFixture();
    const lines: string[] = [];
    const code = await runHarnessCli(['doctor', 'gemini'], {
      installRoot: root,
      coreDir: core,
      env: {},
      runner: new ScriptedRunner(),
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]).error.message).toContain('Unknown harness: gemini');
  });
});

describe('plan content shown to confirmation callbacks', () => {
  it('exposes targets, versions, package manager and write locations', async () => {
    const { root, core } = coreFixture();
    const plans: InstallPlan[] = [];
    const runner = npmGlobals({});
    const lines: string[] = [];
    const code = await runHarnessCli(['install', 'codex'], {
      installRoot: root,
      coreDir: core,
      env: { PATH: '/nonexistent' },
      runner,
      write: (line) => lines.push(line),
      confirm: (plan) => {
        plans.push(plan);
        return Promise.resolve(false);
      },
    });
    expect(code).toBe(0);
    const [plan] = plans;
    expect(plan.packageManager).toBe('npm');
    expect(plan.targets).toEqual([{ name: '@openai/codex', version: '0.154.0' }]);
    expect(plan.writes.join(' ')).toContain('/usr/local/lib');
    expect(plan.permissionNote).toBeTruthy();
  });
});
