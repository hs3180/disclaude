/**
 * Doctor tests (Issue #5169): discoverability checks run against temporary
 * fixture trees and a fake package-manager runner — no real binaries are
 * spawned and no credentials are read.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorHarness } from './doctor.js';
import type { ProcessRunner, RunnerResult } from './types.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'disclaude-harness-doctor-'));
  directories.push(directory);
  return directory;
}

class ScriptedRunner implements ProcessRunner {
  constructor(private readonly replies: Array<Partial<RunnerResult>> = []) {}

  run(): Promise<RunnerResult> {
    const reply = this.replies.shift() ?? { code: 0, stdout: '', stderr: '' };
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...reply });
  }
}

function coreFixture(root: string): string {
  const core = join(root, 'packages', 'core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, 'package.json'), '{"name":"@disclaude/core","version":"0.6.7"}');
  return core;
}

function materializePackage(
  root: string,
  name: string,
  version: string,
  extra: Record<string, string> = {}
): void {
  const packageDir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'index.js'), 'module.exports = {};\n');
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js', ...extra })
  );
}

function pathEnv(binary?: string): { root?: string; env: { PATH: string } } {
  if (!binary) {
    return { env: { PATH: '/nonexistent' } };
  }
  const root = tempDirectory();
  writeFileSync(join(root, binary), '#!/bin/sh\n', { mode: 0o755 });
  return { root, env: { PATH: `/nonexistent:${root}` } };
}

const npmGlobals = (packages: Record<string, string>): ProcessRunner =>
  new ScriptedRunner([
    {
      stdout: JSON.stringify({
        dependencies: Object.fromEntries(
          Object.entries(packages).map(([name, version]) => [name, { version }])
        ),
      }),
    },
  ]);

describe('doctor codex / dsh (PATH CLI is required)', () => {
  it('passes when the binary is discoverable', async () => {
    const { env } = pathEnv('codex');
    const report = await doctorHarness('codex', {
      runner: npmGlobals({ '@openai/codex': '0.154.0' }),
      env,
      coreDir: coreFixture(tempDirectory()),
      installRoot: '/opt/disclaude',
    });
    expect(report.ok).toBe(true);
    const pathCheck = report.checks.find((check) => check.name === 'cli-on-path');
    expect(pathCheck).toMatchObject({ status: 'pass' });
    expect(pathCheck?.detail).toContain('codex');
    expect(report.checks.find((check) => check.name === 'npm-global-package')?.detail).toContain(
      '@openai/codex@0.154.0'
    );
  });

  it('fails with an install hint when the binary is missing', async () => {
    const report = await doctorHarness('codex', {
      runner: npmGlobals({}),
      env: pathEnv().env,
      coreDir: coreFixture(tempDirectory()),
      installRoot: '/opt/disclaude',
    });
    expect(report.ok).toBe(false);
    const failed = report.checks.find((check) => check.status === 'fail');
    expect(failed?.name).toBe('cli-on-path');
    expect(failed?.hint).toContain('disclaude harness install codex');
  });

  it('fails for a missing dsh binary and surfaces the auth next step', async () => {
    const report = await doctorHarness('dsh', {
      runner: npmGlobals({}),
      env: pathEnv().env,
      coreDir: coreFixture(tempDirectory()),
      installRoot: '/opt/disclaude',
    });
    expect(report.ok).toBe(false);
    const auth = report.checks.find((check) => check.name === 'auth');
    expect(auth?.status).toBe('info');
    expect(auth?.detail).toContain('apiKey');
  });
});

describe('doctor claude (bundled SDK runtime is required)', () => {
  it('passes on the bundled runtime and treats a missing PATH CLI as informational', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    materializePackage(root, '@anthropic-ai/claude-agent-sdk', '0.3.263', {
      claudeCodeVersion: '2.1.263',
    });
    const report = await doctorHarness('claude', {
      runner: new ScriptedRunner(),
      env: pathEnv().env,
      coreDir: core,
      installRoot: root,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'bundled-sdk-runtime')).toMatchObject({
      status: 'pass',
    });
    expect(report.checks.find((check) => check.name === 'bundled-sdk-runtime')?.detail).toContain(
      '2.1.263'
    );
    const standalone = report.checks.find((check) => check.name === 'standalone-cli');
    expect(standalone?.status).toBe('info');
    expect(standalone?.detail).toContain('optional for the service');
  });

  it('fails when the agent SDK does not resolve', async () => {
    const report = await doctorHarness('claude', {
      runner: new ScriptedRunner(),
      env: pathEnv('claude').env,
      coreDir: coreFixture(tempDirectory()),
      installRoot: '/opt/disclaude',
    });
    expect(report.ok).toBe(false);
    const failed = report.checks.find((check) => check.status === 'fail');
    expect(failed?.detail).toContain('@anthropic-ai/claude-agent-sdk');
  });
});

describe('doctor pi (module resolution and Node version)', () => {
  it('passes when both runtime packages resolve at the pinned version', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    materializePackage(root, '@earendil-works/pi-agent-core', '0.83.0');
    materializePackage(root, '@earendil-works/pi-ai', '0.83.0');
    const report = await doctorHarness('pi', {
      runner: new ScriptedRunner(),
      env: {},
      coreDir: core,
      installRoot: root,
      nodeVersion: 'v22.23.4',
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === 'runtime-packages')?.detail).toContain(
      '@earendil-works/pi-agent-core@0.83.0'
    );
  });

  it('fails with the prebuilt install hint when packages are missing', async () => {
    const root = tempDirectory();
    const report = await doctorHarness('pi', {
      runner: new ScriptedRunner(),
      env: {},
      coreDir: coreFixture(root),
      installRoot: root,
      nodeVersion: 'v22.23.4',
    });
    expect(report.ok).toBe(false);
    const failed = report.checks.find((check) => check.name === 'runtime-packages');
    expect(failed?.detail).toContain('do not resolve');
    expect(failed?.hint).toContain('disclaude harness install pi');
  });

  it('suggests the pnpm workflow in source worktrees', async () => {
    const root = tempDirectory();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const report = await doctorHarness('pi', {
      runner: new ScriptedRunner(),
      env: {},
      coreDir: coreFixture(root),
      installRoot: root,
      nodeVersion: 'v22.23.4',
    });
    const failed = report.checks.find((check) => check.name === 'runtime-packages');
    expect(failed?.hint).toContain('corepack pnpm --filter @disclaude/core add');
  });

  it('warns instead of failing when a different version resolves', async () => {
    const root = tempDirectory();
    const core = coreFixture(root);
    materializePackage(root, '@earendil-works/pi-agent-core', '0.84.4');
    materializePackage(root, '@earendil-works/pi-ai', '0.84.4');
    const report = await doctorHarness('pi', {
      runner: new ScriptedRunner(),
      env: {},
      coreDir: core,
      installRoot: root,
      nodeVersion: 'v22.23.4',
    });
    expect(report.ok).toBe(true);
    const warn = report.checks.find((check) => check.name === 'runtime-packages');
    expect(warn?.status).toBe('warn');
    expect(warn?.detail).toContain('0.84.4');
  });

  it('fails the Node check below 22.19.0', async () => {
    const root = tempDirectory();
    const report = await doctorHarness('pi', {
      runner: new ScriptedRunner(),
      env: {},
      coreDir: coreFixture(root),
      installRoot: root,
      nodeVersion: 'v22.18.0',
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'node-version')?.status).toBe('fail');
  });
});
