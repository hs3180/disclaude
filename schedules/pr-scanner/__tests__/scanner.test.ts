/**
 * Tests for PR Scanner v2 scanner.ts.
 *
 * All tests run offline — no GitHub API calls required.
 * State files are written to a temp directory via STATE_DIR env override.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  nowISO,
  calcExpiry,
  isValidState,
  isValidTimestamp,
  getStateDir,
  getMaxConcurrent,
  getStateFilePath,
  atomicWrite,
  createPRState,
  parseStateFile,
  checkCapacity,
  createState,
  markState,
  status,
  deleteStateFile,
} from '../scanner.js';

// Use a temp directory for state files during tests
const TEST_STATE_DIR = resolve('/tmp', `pr-scanner-test-${Date.now()}`);

beforeEach(async () => {
  process.env.STATE_DIR = TEST_STATE_DIR;
  await mkdir(TEST_STATE_DIR, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  delete process.env.STATE_DIR;
});

// ---- Pure functions ----

describe('nowISO', () => {
  it('should return UTC ISO 8601 Z-suffix format', () => {
    const result = nowISO();
    expect(isValidTimestamp(result)).toBe(true);
  });

  it('should return a valid Date', () => {
    const result = nowISO();
    const d = new Date(result);
    expect(d.getTime()).not.toBeNaN();
  });
});

describe('calcExpiry', () => {
  it('should add 48 hours to the input timestamp', () => {
    const created = '2026-04-07T10:00:00Z';
    const expires = calcExpiry(created);
    expect(new Date(expires).getTime()).toBe(new Date('2026-04-09T10:00:00Z').getTime());
  });

  it('should handle month boundaries', () => {
    const created = '2026-04-30T22:00:00Z';
    const expires = calcExpiry(created);
    expect(new Date(expires).getTime()).toBe(new Date('2026-05-02T22:00:00Z').getTime());
  });

  it('should produce a valid ISO timestamp', () => {
    const created = nowISO();
    const expires = calcExpiry(created);
    expect(isValidTimestamp(expires)).toBe(true);
  });
});

describe('isValidState', () => {
  it('should accept valid states', () => {
    expect(isValidState('reviewing')).toBe(true);
    expect(isValidState('approved')).toBe(true);
    expect(isValidState('closed')).toBe(true);
  });

  it('should reject invalid states', () => {
    expect(isValidState('rejected')).toBe(false);
    expect(isValidState('pending')).toBe(false);
    expect(isValidState('')).toBe(false);
    expect(isValidState('REVIEWING')).toBe(false);
  });
});

describe('isValidTimestamp', () => {
  it('should accept UTC Z-suffix timestamps', () => {
    expect(isValidTimestamp('2026-04-07T10:00:00Z')).toBe(true);
    expect(isValidTimestamp('2026-04-07T10:00:00.123Z')).toBe(true);
    expect(isValidTimestamp('2026-04-07T10:00:00.123456Z')).toBe(true);
  });

  it('should reject non-UTC timestamps', () => {
    expect(isValidTimestamp('2026-04-07T10:00:00+08:00')).toBe(false);
    expect(isValidTimestamp('2026-04-07')).toBe(false);
    expect(isValidTimestamp('')).toBe(false);
  });
});

describe('getStateDir', () => {
  it('should return default state dir', () => {
    delete process.env.STATE_DIR;
    expect(getStateDir()).toBe('.temp-chats');
  });

  it('should return overridden state dir from env', () => {
    process.env.STATE_DIR = '/custom/dir';
    expect(getStateDir()).toBe('/custom/dir');
    delete process.env.STATE_DIR;
  });
});

describe('getMaxConcurrent', () => {
  it('should return default max concurrent', () => {
    delete process.env.MAX_CONCURRENT;
    expect(getMaxConcurrent()).toBe(3);
  });

  it('should return overridden max concurrent from env', () => {
    process.env.MAX_CONCURRENT = '5';
    expect(getMaxConcurrent()).toBe(5);
    delete process.env.MAX_CONCURRENT;
  });

  it('should fall back to default for invalid values', () => {
    process.env.MAX_CONCURRENT = 'invalid';
    expect(getMaxConcurrent()).toBe(3);
    process.env.MAX_CONCURRENT = '-1';
    expect(getMaxConcurrent()).toBe(3);
    process.env.MAX_CONCURRENT = '0';
    expect(getMaxConcurrent()).toBe(3);
    delete process.env.MAX_CONCURRENT;
  });
});

describe('getStateFilePath', () => {
  it('should return correct path for a PR number', () => {
    process.env.STATE_DIR = '/test/dir';
    expect(getStateFilePath(123)).toBe(resolve('/test/dir/pr-123.json'));
  });
});

// ---- State file creation & parsing ----

describe('createPRState', () => {
  it('should create a valid state file object', () => {
    const state = createPRState(123);
    expect(state.prNumber).toBe(123);
    expect(state.chatId).toBeNull();
    expect(state.state).toBe('reviewing');
    expect(isValidTimestamp(state.createdAt)).toBe(true);
    expect(state.updatedAt).toBe(state.createdAt);
    expect(state.expiresAt).toBe(calcExpiry(state.createdAt));
    expect(state.disbandRequested).toBeNull();
  });

  it('should accept a chatId', () => {
    const state = createPRState(456, 'oc_test123');
    expect(state.chatId).toBe('oc_test123');
  });
});

describe('parseStateFile', () => {
  it('should parse a valid state file JSON', () => {
    const state = createPRState(123);
    const json = JSON.stringify(state);
    const parsed = parseStateFile(json, 'test.json');
    expect(parsed).toEqual(state);
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseStateFile('not json', 'test.json')).toThrow('not valid JSON');
  });

  it('should throw on non-object JSON', () => {
    expect(() => parseStateFile('[]', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('null', 'test.json')).toThrow('not a valid JSON object');
    expect(() => parseStateFile('"string"', 'test.json')).toThrow('not a valid JSON object');
  });

  it('should throw on invalid prNumber', () => {
    const state = createPRState(123);
    state.prNumber = -1;
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow('invalid or missing');
  });

  it('should throw on invalid state', () => {
    const state = createPRState(123);
    (state as Record<string, unknown>).state = 'rejected';
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow("invalid 'state'");
  });

  it('should throw on invalid createdAt', () => {
    const state = createPRState(123);
    (state as Record<string, unknown>).createdAt = 'not-a-date';
    expect(() => parseStateFile(JSON.stringify(state), 'test.json')).toThrow("invalid or missing 'createdAt'");
  });

  it('should accept timestamps with milliseconds', () => {
    const state = createPRState(123);
    // Manually set timestamps with milliseconds
    (state as Record<string, unknown>).createdAt = '2026-04-07T10:00:00.123Z';
    (state as Record<string, unknown>).updatedAt = '2026-04-07T10:00:00.123Z';
    (state as Record<string, unknown>).expiresAt = '2026-04-09T10:00:00.123Z';
    const json = JSON.stringify(state);
    expect(() => parseStateFile(json, 'test.json')).not.toThrow();
  });
});

// ---- File operations ----

describe('atomicWrite', () => {
  it('should write file content atomically', async () => {
    const filePath = resolve(TEST_STATE_DIR, 'test-atomic.json');
    await atomicWrite(filePath, '{"test": true}');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('{"test": true}');
  });

  it('should overwrite existing file', async () => {
    const filePath = resolve(TEST_STATE_DIR, 'test-overwrite.json');
    await atomicWrite(filePath, 'first');
    await atomicWrite(filePath, 'second');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('second');
  });
});

// ---- Actions ----

describe('checkCapacity', () => {
  it('should report zero reviewing when no state files exist', async () => {
    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await checkCapacity();
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.reviewing).toBe(0);
    expect(output.maxConcurrent).toBe(3);
    expect(output.available).toBe(3);
  });

  it('should count reviewing state files correctly', async () => {
    // Create two reviewing state files
    const state1 = createPRState(101);
    const state2 = createPRState(102);
    await writeFile(getStateFilePath(101), JSON.stringify(state1) + '\n', 'utf-8');
    await writeFile(getStateFilePath(102), JSON.stringify(state2) + '\n', 'utf-8');

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await checkCapacity();
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.reviewing).toBe(2);
    expect(output.available).toBe(1);
  });

  it('should not count non-reviewing state files', async () => {
    const state1 = createPRState(201);
    state1.state = 'approved';
    state1.updatedAt = nowISO();
    const state2 = createPRState(202);
    state2.state = 'closed';
    state2.updatedAt = nowISO();
    await writeFile(getStateFilePath(201), JSON.stringify(state1) + '\n', 'utf-8');
    await writeFile(getStateFilePath(202), JSON.stringify(state2) + '\n', 'utf-8');

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await checkCapacity();
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.reviewing).toBe(0);
    expect(output.available).toBe(3);
  });

  it('should skip corrupted files gracefully', async () => {
    // Create one valid and one corrupted file
    const state1 = createPRState(301);
    await writeFile(getStateFilePath(301), JSON.stringify(state1) + '\n', 'utf-8');
    await writeFile(getStateFilePath(302), 'not-json' + '\n', 'utf-8');

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => consoleSpy.push(args.join(' '));
    console.error = () => {};

    try {
      await checkCapacity();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.reviewing).toBe(1);
  });
});

describe('createState', () => {
  it('should create a new state file', async () => {
    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await createState(1001);
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.prNumber).toBe(1001);
    expect(output.state).toBe('reviewing');
    expect(output.chatId).toBeNull();
    expect(output.disbandRequested).toBeNull();

    // Verify file on disk
    const filePath = getStateFilePath(1001);
    const content = await readFile(filePath, 'utf-8');
    const diskState = JSON.parse(content);
    expect(diskState.prNumber).toBe(1001);
  });

  it('should create state file with chatId', async () => {
    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await createState(1002, 'oc_test_chat');
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.chatId).toBe('oc_test_chat');
  });

  it('should return existing state file (idempotent)', async () => {
    // Create state file first
    const existing = createPRState(1003);
    existing.chatId = 'oc_existing';
    await writeFile(getStateFilePath(1003), JSON.stringify(existing) + '\n', 'utf-8');

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await createState(1003, 'oc_new');
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    // Should return existing state, not overwrite
    expect(output.chatId).toBe('oc_existing');
  });

  it('should create state file with valid schema', async () => {
    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await createState(1004);
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    // Verify all required fields present
    expect(output).toHaveProperty('prNumber');
    expect(output).toHaveProperty('chatId');
    expect(output).toHaveProperty('state');
    expect(output).toHaveProperty('createdAt');
    expect(output).toHaveProperty('updatedAt');
    expect(output).toHaveProperty('expiresAt');
    expect(output).toHaveProperty('disbandRequested');

    // Verify schema constraints
    expect(output.state).toBe('reviewing');
    expect(output.disbandRequested).toBeNull();
    expect(isValidTimestamp(output.createdAt)).toBe(true);
    expect(isValidTimestamp(output.updatedAt)).toBe(true);
    expect(isValidTimestamp(output.expiresAt)).toBe(true);
    expect(output.expiresAt).toBe(calcExpiry(output.createdAt));
  });
});

describe('markState', () => {
  it('should update state from reviewing to approved', async () => {
    // Create initial state
    await createState(2001);

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await markState(2001, 'approved');
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.prNumber).toBe(2001);
    expect(output.state).toBe('approved');
    expect(output.updatedAt).not.toBe(output.createdAt);
  });

  it('should update state from reviewing to closed', async () => {
    await createState(2002);

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await markState(2002, 'closed');
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.state).toBe('closed');
  });

  it('should persist state change to disk', async () => {
    await createState(2003);
    await markState(2003, 'approved');

    const filePath = getStateFilePath(2003);
    const content = await readFile(filePath, 'utf-8');
    const diskState = JSON.parse(content);
    expect(diskState.state).toBe('approved');
  });

  it('should exit with error for missing state file', async () => {
    const originalError = console.error;
    console.error = () => {};

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await markState(9999, 'approved');
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('process.exit(1)');
    } finally {
      console.error = originalError;
      exitSpy.mockRestore();
    }
  });
});

describe('status', () => {
  it('should display empty status when no state files', async () => {
    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await status();
    } finally {
      console.log = originalLog;
    }

    const output = consoleSpy.join('\n');
    expect(output).toContain('0 tracked PRs');
    expect(output).toContain('reviewing: (none)');
    expect(output).toContain('approved: (none)');
    expect(output).toContain('closed: (none)');
  });

  it('should group PRs by state', async () => {
    // Create PRs in different states
    await createState(3001);
    await createState(3002);
    await createState(3003);
    await markState(3002, 'approved');
    await markState(3003, 'closed');

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await status();
    } finally {
      console.log = originalLog;
    }

    const output = consoleSpy.join('\n');
    expect(output).toContain('3 tracked PRs');
    expect(output).toContain('#3001');
    expect(output).toContain('#3002');
    expect(output).toContain('#3003');
  });

  it('should handle corrupted files gracefully', async () => {
    await createState(4001);
    // Add a corrupted file
    await writeFile(
      resolve(TEST_STATE_DIR, 'pr-4002.json'),
      'corrupted' + '\n',
      'utf-8',
    );

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => consoleSpy.push(args.join(' '));
    console.error = () => {};

    try {
      await status();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const output = consoleSpy.join('\n');
    expect(output).toContain('#4001');
  });
});

describe('deleteStateFile', () => {
  it('should delete an existing state file', async () => {
    await createState(5001);
    const filePath = getStateFilePath(5001);

    // Verify it exists
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBeTruthy();

    await deleteStateFile(5001);

    // Verify it's gone
    await expect(readFile(filePath, 'utf-8')).rejects.toThrow();
  });

  it('should not throw for non-existent file', async () => {
    await expect(deleteStateFile(9999)).resolves.not.toThrow();
  });
});

// ---- Edge cases ----

describe('edge cases', () => {
  it('should handle empty state directory', async () => {
    const emptyDir = resolve('/tmp', `pr-scanner-empty-${Date.now()}`);
    process.env.STATE_DIR = emptyDir;
    await mkdir(emptyDir, { recursive: true });

    try {
      const consoleSpy: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => consoleSpy.push(args.join(' '));

      try {
        await checkCapacity();
      } finally {
        console.log = originalLog;
      }

      const output = JSON.parse(consoleSpy[0]);
      expect(output.reviewing).toBe(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should handle non-existent state directory for checkCapacity', async () => {
    process.env.STATE_DIR = '/tmp/nonexistent-dir-' + Date.now();

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await checkCapacity();
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.reviewing).toBe(0);
    expect(output.available).toBe(3);
  });

  it('should handle state file with extra fields gracefully', async () => {
    const state = createPRState(6001);
    const extra = { ...state, extraField: 'should-be-preserved' };
    await writeFile(getStateFilePath(6001), JSON.stringify(extra) + '\n', 'utf-8');

    // parseStateFile should still work
    const content = await readFile(getStateFilePath(6001), 'utf-8');
    const parsed = parseStateFile(content, getStateFilePath(6001));
    expect(parsed.prNumber).toBe(6001);
  });

  it('should handle concurrent state file writes', async () => {
    // Create two state files concurrently
    await Promise.all([
      createState(7001),
      createState(7002),
      createState(7003),
    ]);

    // All three should exist
    const files = await readdir(resolve(TEST_STATE_DIR));
    const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));
    expect(jsonFiles.length).toBe(3);
  });

  it('should handle state file that is not a JSON object', async () => {
    await writeFile(
      resolve(TEST_STATE_DIR, 'pr-8001.json'),
      '"just a string"' + '\n',
      'utf-8',
    );

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => consoleSpy.push(args.join(' '));
    console.error = () => {};

    try {
      await checkCapacity();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    // Should skip the invalid file
    const output = JSON.parse(consoleSpy[0]);
    expect(output.reviewing).toBe(0);
  });

  it('should preserve all fields when marking state', async () => {
    await createState(9001, 'oc_original_chat');

    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => consoleSpy.push(args.join(' '));

    try {
      await markState(9001, 'approved');
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(consoleSpy[0]);
    expect(output.chatId).toBe('oc_original_chat');
    expect(output.prNumber).toBe(9001);
    expect(output.createdAt).toBeTruthy();
    expect(output.expiresAt).toBeTruthy();
    expect(output.disbandRequested).toBeNull();
  });
});
