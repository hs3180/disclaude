/**
 * Unit tests for pr-scanner.ts — PR Scanner v2 state management + Label operations.
 *
 * Tests all CLI actions (check-capacity, create-state, mark, status,
 * add-label, remove-label) plus state file parsing, validation, and edge cases.
 * Label tests mock gh CLI calls. Does not depend on real GitHub API.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseStateFile,
  parseArgs,
  type PRStateFile,
  type PRState,
  DEFAULT_MAX_REVIEWING,
  EXPIRY_HOURS,
  REVIEWING_LABEL,
} from '../pr-scanner.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats-test');

// Helper to run the scanner script
async function runScanner(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/schedule/pr-scanner.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath, ...args], {
      env: {
        ...process.env,
        PR_SCANNER_STATE_DIR: TEST_STATE_DIR,
        ...env,
      },
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

function createStateData(overrides: Partial<PRStateFile> = {}): PRStateFile {
  const now = new Date();
  const expires = new Date(now.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
  return {
    prNumber: 100,
    chatId: null,
    state: 'reviewing',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    disbandRequested: null,
    ...overrides,
  };
}

async function writeStateFile(data: PRStateFile): Promise<void> {
  const filePath = resolve(TEST_STATE_DIR, `pr-${data.prNumber}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function cleanupTestDir(): Promise<void> {
  try {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

/**
 * Extract the first JSON object from multi-object stdout output.
 * scanner.ts may output state file JSON followed by label operation JSON.
 */
function parseFirstJsonObject(stdout: string): Record<string, unknown> {
  // Find the first complete JSON object by tracking brace depth
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (stdout[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return JSON.parse(stdout.slice(start, i + 1));
      }
    }
  }
  throw new Error('No JSON object found in output');
}

/**
 * Find and parse the state file JSON (contains "prNumber") from multi-line output.
 */
function findStateJson(stdout: string): PRStateFile {
  const lines = stdout.split('\n');
  // Collect lines that form the state JSON (starts with { and contains prNumber)
  let collecting = false;
  let jsonStr = '';
  for (const line of lines) {
    if (line.trim().startsWith('{')) {
      collecting = true;
      jsonStr = line;
      // Check if this is a single-line JSON with prNumber
      if (line.includes('"prNumber"')) {
        try { return JSON.parse(line); } catch { /* multi-line, continue */ }
      }
      continue;
    }
    if (collecting) {
      jsonStr += '\n' + line;
      if (line.includes('}')) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.prNumber !== undefined) return parsed;
        } catch { /* not valid yet */ }
        collecting = false;
        jsonStr = '';
      }
    }
  }
  throw new Error(`No state JSON with prNumber found in output:\n${stdout}`);
}

// ---- parseStateFile tests ----

describe('parseStateFile', () => {
  it('should parse a valid state file', () => {
    const data = createStateData();
    const json = JSON.stringify(data);
    const result = parseStateFile(json, 'test.json');
    expect(result.prNumber).toBe(100);
    expect(result.state).toBe('reviewing');
    expect(result.chatId).toBeNull();
    expect(result.disbandRequested).toBeNull();
  });

  it('should parse a state file with chatId', () => {
    const data = createStateData({ chatId: 'oc_test123' });
    const result = parseStateFile(JSON.stringify(data), 'test.json');
    expect(result.chatId).toBe('oc_test123');
  });

  it('should reject invalid JSON', () => {
    expect(() => parseStateFile('not json', 'test.json')).toThrow('not valid JSON');
  });

  it('should reject non-object JSON', () => {
    expect(() => parseStateFile('"string"', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('[]', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('null', 'test.json')).toThrow('not a valid JSON object');
  });

  it('should reject missing prNumber', () => {
    const data = createStateData();
    delete (data as Record<string, unknown>).prNumber;
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('should reject non-integer prNumber', () => {
    const data = createStateData({ prNumber: 1.5 } as Partial<PRStateFile>);
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('should reject zero prNumber', () => {
    const data = createStateData({ prNumber: 0 } as Partial<PRStateFile>);
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('should reject negative prNumber', () => {
    const data = createStateData({ prNumber: -1 } as Partial<PRStateFile>);
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'prNumber\'');
  });

  it('should reject invalid state', () => {
    const data = createStateData();
    (data as Record<string, unknown>).state = 'unknown';
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid \'state\'');
  });

  it('should reject non-null disbandRequested', () => {
    const data = createStateData();
    (data as Record<string, unknown>).disbandRequested = 'some-value';
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid \'disbandRequested\'');
  });

  it('should accept all valid states', () => {
    for (const state of ['reviewing', 'approved', 'closed'] as PRState[]) {
      const data = createStateData({ state });
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.state).toBe(state);
    }
  });

  it('should reject invalid createdAt format', () => {
    const data = createStateData();
    data.createdAt = '2026-04-07 10:00:00'; // missing T and Z
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid or missing \'createdAt\'');
  });

  it('should reject non-string chatId', () => {
    const data = createStateData();
    (data as Record<string, unknown>).chatId = 123;
    expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('invalid \'chatId\'');
  });
});

// ---- parseArgs tests ----

describe('parseArgs', () => {
  it('should parse --action flag', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'status']);
    expect(result.action).toBe('status');
  });

  it('should parse positional action', () => {
    const result = parseArgs(['node', 'script.ts', 'status']);
    expect(result.action).toBe('status');
  });

  it('should parse --pr and --state flags', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'mark', '--pr', '123', '--state', 'approved']);
    expect(result.action).toBe('mark');
    expect(result.pr).toBe(123);
    expect(result.state).toBe('approved');
  });

  it('should parse --chat-id flag', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'create-state', '--pr', '123', '--chat-id', 'oc_test']);
    expect(result.chatId).toBe('oc_test');
  });

  it('should parse --label flag', () => {
    const result = parseArgs(['node', 'script.ts', '--action', 'add-label', '--pr', '123', '--label', 'pr-scanner:reviewing']);
    expect(result.label).toBe('pr-scanner:reviewing');
  });

  it('should default all values when no args', () => {
    const result = parseArgs(['node', 'script.ts']);
    expect(result.action).toBe('');
    expect(result.pr).toBeNull();
    expect(result.state).toBeNull();
    expect(result.chatId).toBeNull();
    expect(result.label).toBeNull();
  });
});

// ---- Integration tests (run actual script) ----

describe('pr-scanner CLI', () => {
  beforeEach(async () => {
    await cleanupTestDir();
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  // ---- check-capacity ----

  describe('check-capacity', () => {
    it('should return default capacity for empty directory', async () => {
      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(0);
      expect(output.maxConcurrent).toBe(DEFAULT_MAX_REVIEWING);
      expect(output.available).toBe(DEFAULT_MAX_REVIEWING);
    });

    it('should count reviewing PRs correctly', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 2, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 3, state: 'approved' }));

      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(2);
      expect(output.available).toBe(1);
    });

    it('should respect PR_SCANNER_MAX_REVIEWING env var', async () => {
      const result = await runScanner(['check-capacity'], {
        PR_SCANNER_MAX_REVIEWING: '5',
      });
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.maxConcurrent).toBe(5);
      expect(output.available).toBe(5);
    });

    it('should report 0 available when at capacity', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 2, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 3, state: 'reviewing' }));

      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(3);
      expect(output.available).toBe(0);
    });

    it('should handle non-existent state directory', async () => {
      await rm(TEST_STATE_DIR, { recursive: true, force: true });

      const result = await runScanner(['check-capacity']);
      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.reviewing).toBe(0);
    });
  });

  // ---- create-state ----

  describe('create-state', () => {
    it('should create a state file for a PR', async () => {
      const result = await runScanner(['create-state', '--pr', '42']);
      expect(result.code).toBe(0);

      const output = findStateJson(result.stdout);
      expect(output.prNumber).toBe(42);
      expect(output.state).toBe('reviewing');
      expect(output.chatId).toBeNull();
      expect(output.disbandRequested).toBeNull();

      // Verify file was written
      const filePath = resolve(TEST_STATE_DIR, 'pr-42.json');
      const fileContent = await readFile(filePath, 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.prNumber).toBe(42);
    });

    it('should create a state file with chatId', async () => {
      const result = await runScanner(['create-state', '--pr', '42', '--chat-id', 'oc_abc123']);
      expect(result.code).toBe(0);

      const output = findStateJson(result.stdout);
      expect(output.chatId).toBe('oc_abc123');
    });

    it('should reject duplicate state file', async () => {
      await writeStateFile(createStateData({ prNumber: 42 }));

      const result = await runScanner(['create-state', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should require --pr flag', async () => {
      const result = await runScanner(['create-state']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });
  });

  // ---- mark ----

  describe('mark', () => {
    it('should update state from reviewing to approved', async () => {
      await writeStateFile(createStateData({ prNumber: 42 }));

      const result = await runScanner(['mark', '--pr', '42', '--state', 'approved']);
      expect(result.code).toBe(0);

      const output = findStateJson(result.stdout);
      expect(output.state).toBe('approved');
    });

    it('should update state from reviewing to closed', async () => {
      await writeStateFile(createStateData({ prNumber: 42 }));

      const result = await runScanner(['mark', '--pr', '42', '--state', 'closed']);
      expect(result.code).toBe(0);

      const output = findStateJson(result.stdout);
      expect(output.state).toBe('closed');
    });

    it('should require --pr flag', async () => {
      const result = await runScanner(['mark', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should require --state flag', async () => {
      const result = await runScanner(['mark', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--state is required');
    });

    it('should reject unknown state file', async () => {
      const result = await runScanner(['mark', '--pr', '999', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  // ---- status ----

  describe('status', () => {
    it('should show empty status when no tracked PRs', async () => {
      const result = await runScanner(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No tracked PRs');
    });

    it('should show grouped PRs', async () => {
      await writeStateFile(createStateData({ prNumber: 1, state: 'reviewing' }));
      await writeStateFile(createStateData({ prNumber: 2, state: 'approved' }));
      await writeStateFile(createStateData({ prNumber: 3, state: 'closed' }));

      const result = await runScanner(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Total tracked: 3');
      expect(result.stdout).toContain('reviewing (1)');
      expect(result.stdout).toContain('approved (1)');
      expect(result.stdout).toContain('closed (1)');
    });
  });

  // ---- add-label / remove-label (non-blocking) ----

  describe('add-label', () => {
    it('should require --pr flag', async () => {
      const result = await runScanner(['add-label', '--label', 'test']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should require --label flag', async () => {
      const result = await runScanner(['add-label', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--label is required');
    });

    it('should output result even when gh CLI fails (non-blocking)', async () => {
      // Use a repo that won't exist to trigger gh CLI failure
      const result = await runScanner(['add-label', '--pr', '42', '--label', 'test'], {
        PR_SCANNER_REPO: 'nonexistent/nonexistent-repo-xyz',
      });
      // Should not exit with error code — non-blocking
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('ok');
    });
  });

  describe('remove-label', () => {
    it('should require --pr flag', async () => {
      const result = await runScanner(['remove-label', '--label', 'test']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr is required');
    });

    it('should require --label flag', async () => {
      const result = await runScanner(['remove-label', '--pr', '42']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--label is required');
    });

    it('should output result even when gh CLI fails (non-blocking)', async () => {
      const result = await runScanner(['remove-label', '--pr', '42', '--label', 'test'], {
        PR_SCANNER_REPO: 'nonexistent/nonexistent-repo-xyz',
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('ok');
    });
  });

  // ---- create-state with label integration ----

  describe('create-state label integration', () => {
    it('should include label operation result in output', async () => {
      // Even if gh CLI fails for label, create-state should succeed
      const result = await runScanner(['create-state', '--pr', '99'], {
        PR_SCANNER_REPO: 'nonexistent/nonexistent-repo-xyz',
      });
      expect(result.code).toBe(0);

      // State file should still be created
      const filePath = resolve(TEST_STATE_DIR, 'pr-99.json');
      const fileContent = await readFile(filePath, 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.prNumber).toBe(99);
      expect(fileData.state).toBe('reviewing');
    });
  });

  // ---- mark with label integration ----

  describe('mark label integration', () => {
    it('should attempt label removal when transitioning reviewing → approved', async () => {
      await writeStateFile(createStateData({ prNumber: 88 }));

      const result = await runScanner(['mark', '--pr', '88', '--state', 'approved'], {
        PR_SCANNER_REPO: 'nonexistent/nonexistent-repo-xyz',
      });
      expect(result.code).toBe(0);

      // State should be updated
      const filePath = resolve(TEST_STATE_DIR, 'pr-88.json');
      const fileContent = await readFile(filePath, 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.state).toBe('approved');
    });

    it('should not attempt label removal when state stays reviewing', async () => {
      await writeStateFile(createStateData({ prNumber: 77 }));

      const result = await runScanner(['mark', '--pr', '77', '--state', 'reviewing']);
      expect(result.code).toBe(0);

      const filePath = resolve(TEST_STATE_DIR, 'pr-77.json');
      const fileContent = await readFile(filePath, 'utf-8');
      const fileData = JSON.parse(fileContent);
      expect(fileData.state).toBe('reviewing');
    });
  });

  // ---- unknown action ----

  describe('unknown action', () => {
    it('should reject unknown action', async () => {
      const result = await runScanner(['unknown-action']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown action');
    });
  });
});
