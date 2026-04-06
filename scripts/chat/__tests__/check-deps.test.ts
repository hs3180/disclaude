/**
 * Tests for check-deps.sh dependency check script.
 *
 * These tests verify the script runs correctly and produces
 * the expected output format in an environment where all
 * dependencies are satisfied.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT_PATH = resolve(__dirname, '../check-deps.sh');

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCheckDeps(): Promise<ExecResult> {
  try {
    const result = await execFileAsync('bash', [SCRIPT_PATH], {
      cwd: PROJECT_ROOT,
      timeout: 30000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      exitCode: execErr.status ?? -1,
    };
  }
}

describe('check-deps.sh', () => {
  it('exits with 0 when all dependencies are satisfied', async () => {
    const { exitCode } = await runCheckDeps();
    expect(exitCode).toBe(0);
  });

  it('outputs dependency status for Node.js', async () => {
    const { stdout } = await runCheckDeps();
    expect(stdout).toMatch(/Node\.js v\d+\.\d+\.\d+/);
  });

  it('outputs dependency status for tsx', async () => {
    const { stdout } = await runCheckDeps();
    expect(stdout).toMatch(/tsx/);
  });

  it('outputs dependency status for npm', async () => {
    const { stdout } = await runCheckDeps();
    expect(stdout).toMatch(/npm/);
  });

  it('includes summary line', async () => {
    const { stdout } = await runCheckDeps();
    expect(stdout).toMatch(/All dependencies satisfied/);
  });
});
