/**
 * Tests for chat/check-deps.sh dependency check script.
 *
 * These tests verify the script's output format and behavior
 * without assuming specific dependencies are installed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'scripts/chat/check-deps.sh');

/** Run check-deps.sh and return stdout, stderr, and exit code */
async function runCheckDeps(envOverrides?: Record<string, string>): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  try {
    const result = await execFileAsync(
      'bash',
      [SCRIPT_PATH],
      {
        cwd: PROJECT_ROOT,
        maxBuffer: 1024 * 1024,
        env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      },
    );
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

/** Check if a command exists in PATH */
async function cmdExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

describe('check-deps.sh', () => {
  let hasJq: boolean;
  let hasFlock: boolean;
  let hasDate: boolean;

  beforeAll(async () => {
    hasJq = await cmdExists('jq');
    hasFlock = await cmdExists('flock');
    hasDate = await cmdExists('date');
  });

  it('should print a header', async () => {
    const { stdout } = await runCheckDeps();
    expect(stdout).toContain('Chat Skill Dependency Check');
  });

  it('should check all three required dependencies', async () => {
    const { stdout } = await runCheckDeps();
    expect(stdout).toContain('jq');
    expect(stdout).toContain('flock');
    expect(stdout).toContain('date');
  });

  it('should include realpath compatibility check', async () => {
    const { stdout } = await runCheckDeps();
    expect(stdout).toContain('realpath');
  });

  it('should report OK for available dependencies', async () => {
    const { stdout } = await runCheckDeps();
    if (hasJq) expect(stdout).toMatch(/OK.*jq/);
    if (hasFlock) expect(stdout).toMatch(/OK.*flock/);
    if (hasDate) expect(stdout).toMatch(/OK.*date/);
  });

  it('should report MISS for missing dependencies', async () => {
    const { stdout, code } = await runCheckDeps();
    const missingDeps = [!hasJq && 'jq', !hasFlock && 'flock', !hasDate && 'date'].filter(Boolean);
    if (missingDeps.length > 0) {
      expect(code).toBe(1);
      for (const dep of missingDeps) {
        expect(stdout).toContain(`MISS ${dep}:`);
      }
    }
  });

  it('should exit 0 when all required dependencies are available', async () => {
    const { code } = await runCheckDeps();
    if (hasJq && hasFlock && hasDate) {
      expect(code).toBe(0);
      const { stdout } = await runCheckDeps();
      expect(stdout).toContain('All dependencies satisfied');
    }
    // If deps are missing, the script correctly exits non-zero (tested above)
  });

  it('should include install instructions when dependencies are missing', async () => {
    const { stdout, code } = await runCheckDeps();
    if (code !== 0) {
      expect(stdout).toContain('Install with');
      expect(stdout).toContain('apk add');
      expect(stdout).toContain('apt-get install');
    }
  });

  it('should exit 1 when PATH is restricted to empty dirs', async () => {
    // Keep bash available but restrict everything else
    const { stdout, code } = await runCheckDeps({
      PATH: `/usr/bin:/bin:/nonexistent-bin`,
    });
    expect(code).toBe(1);
    expect(stdout).toContain('MISS');
  });
});
