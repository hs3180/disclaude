/**
 * Tests for chat/check-deps.ts dependency checker.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHECK_DEPS_SCRIPT = resolve(PROJECT_ROOT, 'scripts/chat/check-deps.ts');

async function runCheckDeps(): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('npx', ['tsx', CHECK_DEPS_SCRIPT], {
      cwd: PROJECT_ROOT,
      maxBuffer: 1024 * 1024,
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

describe('check-deps', () => {
  it('should exit with code 0 when all dependencies are satisfied', async () => {
    const result = await runCheckDeps();
    expect(result.code).toBe(0);
  });

  it('should report Node.js availability', async () => {
    const result = await runCheckDeps();
    expect(result.stdout).toContain('Node.js');
  });

  it('should report npx availability', async () => {
    const result = await runCheckDeps();
    expect(result.stdout).toContain('npx');
  });

  it('should report tsx availability', async () => {
    const result = await runCheckDeps();
    expect(result.stdout).toContain('tsx');
  });

  it('should report file locking status', async () => {
    const result = await runCheckDeps();
    expect(result.stdout).toContain('File locking');
  });

  it('should report chat directory status', async () => {
    const result = await runCheckDeps();
    expect(result.stdout).toContain('Chat directory');
  });

  it('should print a summary line', async () => {
    const result = await runCheckDeps();
    // Should end with either success or warning summary
    const lines = result.stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toMatch(/dependencies satisfied/);
  });
});
