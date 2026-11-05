/**
 * Tests for backend discovery probes: PATH lookup, npm global inventory
 * parsing, Node module resolution and the bundled agent-SDK manifest.
 * Probes run against real temporary directory fixtures — no network, no
 * package installation, no secrets.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessRunner, RunnerResult } from './types.js';
import {
  bundledClaudeRuntime,
  findOnPath,
  findPackageManifest,
  npmGlobalPackages,
  npmGlobalPrefix,
  parseNpmLs,
  resolveNodeModules,
} from './detect.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'disclaude-backend-test-'));
  directories.push(directory);
  return directory;
}

/** Stub runner with scripted replies and a call log; never touches a shell. */
class ScriptedRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  private nextIndex = 0;

  constructor(private readonly replies: Array<Partial<RunnerResult> | Error>) {}

  run(command: string, args: string[], options: { cwd?: string } = {}): Promise<RunnerResult> {
    this.calls.push({ command, args, cwd: options.cwd });
    const reply = this.replies[this.nextIndex++] ?? { code: 0, stdout: '', stderr: '' };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...reply });
  }
}

describe('findOnPath', () => {
  it('finds an executable binary on PATH', () => {
    const root = tempDirectory();
    writeFileSync(join(root, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    const found = findOnPath('codex', { PATH: `/nonexistent-first:${root}` });
    expect(found).toBe(join(root, 'codex'));
  });

  it('ignores non-executable files and missing directories', () => {
    const root = tempDirectory();
    writeFileSync(join(root, 'codex'), '#!/bin/sh\n', { mode: 0o644 });
    expect(findOnPath('codex', { PATH: root })).toBeUndefined();
    expect(findOnPath('codex', { PATH: '' })).toBeUndefined();
    expect(findOnPath('codex', {})).toBeUndefined();
  });
});

describe('parseNpmLs', () => {
  it('parses npm ls -g JSON behind warning lines', () => {
    const stdout = [
      'npm warn config production Use `--omit=dev` instead.',
      '{"name":"/usr/local/lib","dependencies":{"@openai/codex":{"version":"0.151.0"},',
      '"@deepseek-ai/dsh":{"version":"0.1.2-rc.1"},"corepack":{"version":"0.36.0","overlapped":true}}}',
    ].join('\n');
    expect(parseNpmLs(stdout)).toEqual({
      '@openai/codex': '0.151.0',
      '@deepseek-ai/dsh': '0.1.2-rc.1',
      corepack: '0.36.0',
    });
  });

  it('returns empty results for empty or malformed output', () => {
    expect(parseNpmLs('')).toEqual({});
    expect(parseNpmLs('no json here')).toEqual({});
    expect(parseNpmLs('{"dependencies":{"broken":{"version":null}}}')).toEqual({});
  });
});

describe('npm probes through the runner', () => {
  it('collects npm ls -g output and tolerates runner failure', async () => {
    const runner = new ScriptedRunner([
      { stdout: '{"dependencies":{"@openai/codex":{"version":"0.154.0"}}}' },
    ]);
    await expect(npmGlobalPackages(runner)).resolves.toEqual({ '@openai/codex': '0.154.0' });
    expect(runner.calls[0]?.args).toEqual(['ls', '-g', '--depth=0', '--json']);

    const failing = new ScriptedRunner([new Error('npm missing')]);
    await expect(npmGlobalPackages(failing)).resolves.toEqual({});
  });

  it('reads the npm global prefix', async () => {
    const runner = new ScriptedRunner([{ stdout: '/usr/local\n' }]);
    await expect(npmGlobalPrefix(runner)).resolves.toBe('/usr/local');
    expect(runner.calls[0]?.args).toEqual(['prefix', '-g']);

    const failing = new ScriptedRunner([new Error('npm missing')]);
    await expect(npmGlobalPrefix(failing)).resolves.toBeUndefined();
  });
});

describe('resolveNodeModules against fixture trees', () => {
  it('resolves installed packages with their manifest version', () => {
    const root = tempDirectory();
    mkdirSync(join(root, 'core'));
    writeFileSync(
      join(root, 'core', 'package.json'),
      '{"name":"@disclaude/core","version":"0.6.7"}'
    );
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai']) {
      const packageDir = join(root, 'node_modules', ...name.split('/'));
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'index.js'), 'module.exports = {};\n');
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name, version: '0.83.0', main: 'index.js' })
      );
    }
    const resolved = resolveNodeModules(join(root, 'core'), [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/absent',
    ]);
    expect(resolved['@earendil-works/pi-agent-core']).toMatchObject({
      resolved: true,
      version: '0.83.0',
    });
    expect(resolved['@earendil-works/pi-ai']).toMatchObject({ resolved: true, version: '0.83.0' });
    expect(resolved['@earendil-works/absent']).toEqual({ resolved: false });
  });
});

describe('findPackageManifest', () => {
  it('walks the node_modules chain up from the base directory', () => {
    const root = tempDirectory();
    const packageDir = join(root, 'node_modules', 'example-pkg');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      '{"name":"example-pkg","version":"1.2.3","claudeCodeVersion":"9.9.9"}'
    );
    const nested = join(root, 'packages', 'core');
    mkdirSync(nested, { recursive: true });
    expect(findPackageManifest(nested, 'example-pkg')).toEqual({
      name: 'example-pkg',
      version: '1.2.3',
      claudeCodeVersion: '9.9.9',
      path: join(packageDir, 'package.json'),
    });
    expect(findPackageManifest(nested, 'absent-pkg')).toBeUndefined();
  });

  it('rejects manifests whose name does not match the request', () => {
    const root = tempDirectory();
    const packageDir = join(root, 'node_modules', 'example-pkg');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), '{"name":"other-pkg","version":"1.0.0"}');
    expect(findPackageManifest(root, 'example-pkg')).toBeUndefined();
  });
});

describe('bundledClaudeRuntime', () => {
  it('reports the SDK version and bundled Claude Code version', () => {
    const root = tempDirectory();
    mkdirSync(join(root, 'core'));
    writeFileSync(
      join(root, 'core', 'package.json'),
      '{"name":"@disclaude/core","version":"0.6.7"}'
    );
    const sdkDir = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(
      join(sdkDir, 'package.json'),
      '{"name":"@anthropic-ai/claude-agent-sdk","version":"0.3.263","main":"sdk.mjs","claudeCodeVersion":"2.1.263"}'
    );
    writeFileSync(join(sdkDir, 'sdk.mjs'), 'export {};');
    expect(bundledClaudeRuntime(join(root, 'core'))).toEqual({
      resolvable: true,
      sdkVersion: '0.3.263',
      claudeCodeVersion: '2.1.263',
      path: join(sdkDir, 'package.json'),
    });
  });

  it('reports unresolved when the SDK is absent', () => {
    const root = tempDirectory();
    mkdirSync(join(root, 'core'));
    writeFileSync(join(root, 'core', 'package.json'), '{"name":"@disclaude/core"}');
    expect(bundledClaudeRuntime(join(root, 'core'))).toEqual({ resolvable: false });
  });
});

describe('sanitizeChildEnv', () => {
  it('strips credential-shaped variables and keeps ordinary ones', async () => {
    const { sanitizeChildEnv } = await import('./types.js');
    const sanitized = sanitizeChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      NPM_CONFIG_REGISTRY: 'https://mirror.example.com',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      NPM_TOKEN: 'secret',
      MY_PASSWORD: 'secret',
      SERVICE_CREDENTIALS: 'secret',
    });
    expect(sanitized).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      NPM_CONFIG_REGISTRY: 'https://mirror.example.com',
    });
  });
});

describe('corePackageDir', () => {
  it('resolves two levels up from this module (src and dist layouts share depth)', async () => {
    const { corePackageDir } = await import('./detect.js');
    const { resolve } = await import('node:path');
    expect(corePackageDir(join('x', 'src', 'backends'))).toBe(resolve('x'));
    expect(corePackageDir(join('x', 'dist', 'backends'))).toBe(resolve('x'));
  });
});

describe('createDefaultRunner', () => {
  it('normalizes non-zero exits and strips secrets from the child environment', async () => {
    const { createDefaultRunner } = await import('./types.js');
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const execFile = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return Promise.reject(
        Object.assign(new Error('failed'), { code: 3, stdout: 'out', stderr: 'err' })
      );
    }) as unknown as typeof import('node:child_process').execFile.__promisify__;
    const runner = createDefaultRunner({ PATH: '/bin', ANTHROPIC_API_KEY: 'x' }, execFile);
    await expect(runner.run('npm', ['ls', '-g'], { timeoutMs: 1_000 })).resolves.toEqual({
      code: 3,
      stdout: 'out',
      stderr: 'err',
    });
    expect(calls[0]).toMatchObject({ command: 'npm', args: ['ls', '-g'] });
    expect(calls[0].options.env).toEqual({ PATH: '/bin' });
    expect(calls[0].options.timeout).toBe(1_000);
  });

  it('returns captured output for successful commands', async () => {
    const { createDefaultRunner } = await import('./types.js');
    const execFile = (() =>
      Promise.resolve({
        stdout: 'ok-out',
        stderr: 'warn',
      })) as unknown as typeof import('node:child_process').execFile.__promisify__;
    const runner = createDefaultRunner({}, execFile);
    await expect(runner.run('npm', ['prefix', '-g'])).resolves.toEqual({
      code: 0,
      stdout: 'ok-out',
      stderr: 'warn',
    });
  });

  it('throws RunnerLaunchError when the command cannot start', async () => {
    const { createDefaultRunner, RunnerLaunchError } = await import('./types.js');
    const execFile = (() =>
      Promise.reject(
        Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
      )) as unknown as typeof import('node:child_process').execFile.__promisify__;
    const runner = createDefaultRunner({}, execFile);
    await expect(runner.run('definitely-missing', [])).rejects.toBeInstanceOf(RunnerLaunchError);
  });
});

describe('filesystem hygiene', () => {
  it('keeps every temp directory removable', () => {
    const root = tempDirectory();
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'file'), 'data');
    chmodSync(join(root, 'nested'), 0o755);
    expect(directories).toContain(root);
  });
});
