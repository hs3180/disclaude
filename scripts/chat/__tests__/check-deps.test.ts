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

async function runCheckDeps(): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/chat/check-deps.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
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

describe('check-deps', () => {
  it('should exit with code 0 when all dependencies are satisfied', async () => {
    const result = await runCheckDeps();
    // In CI/test environments, tsx should be available and Node >= 18
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('✅ Node.js');
    expect(result.stdout).toContain('✅ tsx');
    expect(result.stdout).toContain('✅ Chat directory');
    expect(result.stdout).toContain('All dependencies satisfied');
  });

  it('should report Node.js version', async () => {
    const result = await runCheckDeps();
    expect(result.stdout).toContain('Node.js');
    expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
  });

  it('should report tsx version', async () => {
    const result = await runCheckDeps();
    expect(result.stdout).toContain('tsx');
  });

  it('should report chat directory status', async () => {
    const result = await runCheckDeps();
    expect(result.stdout).toContain('Chat directory');
  });
});
