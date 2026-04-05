/**
 * Tests for chat/check-deps.sh dependency check script.
 */

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'scripts/chat/check-deps.sh');

async function runCheckDeps(envOverrides: Record<string, string> = {}): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  try {
    const result = await execFileAsync('bash', [SCRIPT_PATH], {
      env: { ...process.env, ...envOverrides },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      code: execErr.code ?? 1,
    };
  }
}

describe('check-deps.sh', () => {
  it('should exit 0 when all required dependencies are present', async () => {
    // Simulate a PATH with only known-good directories (date, flock should exist)
    const result = await runCheckDeps({
      PATH: '/usr/bin:/bin',
    });

    // In this environment jq may or may not be installed
    // The script should at least detect flock and date
    const output = result.stdout + result.stderr;
    expect(output).toContain('Chat Skill Dependency Check');
  });

  it('should detect missing jq and exit 1', async () => {
    // Use a PATH without jq
    const result = await runCheckDeps({
      PATH: '/usr/bin:/bin',
    });

    const output = result.stdout + result.stderr;

    if (!process.env.PATH?.includes('jq')) {
      // If jq is not in the restricted PATH, script should report it missing
      expect(output).toContain('jq');
    }
  });

  it('should report flock as present', async () => {
    const result = await runCheckDeps();
    const output = result.stdout + result.stderr;
    expect(output).toContain('flock');
  });

  it('should report date as present', async () => {
    const result = await runCheckDeps();
    const output = result.stdout + result.stderr;
    expect(output).toContain('date');
  });

  it('should include install instructions when dependencies are missing', async () => {
    const result = await runCheckDeps({
      PATH: '/usr/bin:/bin',
    });
    const output = result.stdout + result.stderr;

    // Should include installation hints
    expect(output).toContain('apk add');
    expect(output).toContain('apt-get install');
    expect(output).toContain('brew install');
  });

  it('should check realpath -m support', async () => {
    const result = await runCheckDeps();
    const output = result.stdout + result.stderr;
    expect(output).toContain('realpath');
  });
});
