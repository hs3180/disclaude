import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseStateFile,
  validateStateFile,
  nowISO,
  stateFilePath,
  atomicWrite,
  checkExpired,
  markDisband,
  STATE_DIR,
  DISBAND_COOLDOWN_MS,
  type PRStateFile,
} from './lifecycle.js';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ---- Helper: create a valid state file for testing ----

function makeStateFile(overrides: Partial<PRStateFile> = {}): PRStateFile {
  return {
    prNumber: 1,
    chatId: null,
    state: 'reviewing',
    createdAt: '2026-04-07T10:00:00Z',
    updatedAt: '2026-04-07T10:00:00Z',
    expiresAt: '2026-04-09T10:00:00Z',
    disbandRequested: null,
    ...overrides,
  };
}

/** Write a state file to .temp-chats/ for testing */
async function writeTestState(state: PRStateFile): Promise<string> {
  const path = stateFilePath(state.prNumber);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  return path;
}

/** Clean up test state files */
async function cleanupTestStates(): Promise<void> {
  try {
    const files = await readdir(STATE_DIR);
    for (const f of files) {
      if (f.startsWith('pr-') && f.endsWith('.json')) {
        await rm(resolve(STATE_DIR, f));
      }
    }
  } catch {
    // Directory may not exist
  }
}

describe('lifecycle.ts', () => {
  describe('nowISO', () => {
    it('should return UTC Z-suffix format without milliseconds', () => {
      const result = nowISO();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  describe('stateFilePath', () => {
    it('should return correct path', () => {
      const path = stateFilePath(123);
      expect(path).toContain('.temp-chats');
      expect(path).toContain('pr-123.json');
    });
  });

  describe('parseStateFile', () => {
    it('should parse a valid state file', () => {
      const json = JSON.stringify(makeStateFile({ prNumber: 42 }));
      const result = parseStateFile(json, 'test.json');
      expect(result.prNumber).toBe(42);
      expect(result.state).toBe('reviewing');
    });

    it('should reject invalid JSON', () => {
      expect(() => parseStateFile('not json', 'test.json')).toThrow('not valid JSON');
    });

    it('should reject non-object JSON', () => {
      expect(() => parseStateFile('"string"', 'test.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('null', 'test.json')).toThrow('not a valid JSON object');
      expect(() => parseStateFile('[]', 'test.json')).toThrow('not a valid JSON object');
    });

    it('should reject missing prNumber', () => {
      const data = { state: 'reviewing', createdAt: 't', updatedAt: 't', expiresAt: 't' };
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('prNumber');
    });

    it('should reject invalid prNumber', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), prNumber: -1 }), 'test.json')).toThrow('prNumber');
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), prNumber: 0 }), 'test.json')).toThrow('prNumber');
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), prNumber: 1.5 }), 'test.json')).toThrow('prNumber');
    });

    it('should reject invalid state', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), state: 'invalid' }), 'test.json')).toThrow('state');
    });

    it('should reject "rejected" state (not in spec)', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), state: 'rejected' }), 'test.json')).toThrow('state');
    });

    it('should accept all valid states', () => {
      for (const state of ['reviewing', 'approved', 'closed'] as const) {
        const result = parseStateFile(JSON.stringify(makeStateFile({ state })), 'test.json');
        expect(result.state).toBe(state);
      }
    });

    it('should accept null chatId', () => {
      const result = parseStateFile(JSON.stringify({ ...makeStateFile(), chatId: null }), 'test.json');
      expect(result.chatId).toBeNull();
    });

    it('should accept string chatId', () => {
      const result = parseStateFile(JSON.stringify({ ...makeStateFile(), chatId: 'oc_abc123' }), 'test.json');
      expect(result.chatId).toBe('oc_abc123');
    });

    it('should reject non-string/non-null chatId', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), chatId: 123 }), 'test.json')).toThrow('chatId');
    });

    it('should accept null disbandRequested', () => {
      const result = parseStateFile(JSON.stringify({ ...makeStateFile(), disbandRequested: null }), 'test.json');
      expect(result.disbandRequested).toBeNull();
    });

    it('should accept string disbandRequested', () => {
      const result = parseStateFile(JSON.stringify({ ...makeStateFile(), disbandRequested: '2026-04-08T10:00:00Z' }), 'test.json');
      expect(result.disbandRequested).toBe('2026-04-08T10:00:00Z');
    });

    it('should reject non-string/non-null disbandRequested', () => {
      expect(() => parseStateFile(JSON.stringify({ ...makeStateFile(), disbandRequested: 123 }), 'test.json')).toThrow('disbandRequested');
    });
  });

  describe('atomicWrite', () => {
    const testDir = resolve('.temp-chats-test-atomic');

    afterEach(async () => {
      try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
    });

    it('should create parent directories if needed', async () => {
      const filePath = resolve(testDir, 'sub', 'dir', 'test.json');
      await atomicWrite(filePath, '{"test": true}');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('{"test": true}');
    });

    it('should overwrite existing file atomically', async () => {
      const filePath = resolve(testDir, 'test.json');
      await atomicWrite(filePath, 'first');
      await atomicWrite(filePath, 'second');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('second');
    });
  });

  describe('checkExpired', () => {
    beforeEach(cleanupTestStates);
    afterEach(cleanupTestStates);

    it('should return empty when no state files exist', async () => {
      // Clean directory
      const result = await checkExpired();
      expect(result).toEqual([]);
    });

    it('should find expired reviewing PRs', async () => {
      // Create a state file that expired 1 hour ago
      const past = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeTestState(makeStateFile({
        prNumber: 100,
        state: 'reviewing',
        expiresAt: past,
      }));

      const result = await checkExpired();
      expect(result).toHaveLength(1);
      expect(result[0].prNumber).toBe(100);
      expect(result[0].state).toBe('reviewing');
      expect(result[0].withinCooldown).toBe(false);
    });

    it('should not find PRs that have not expired', async () => {
      // Create a state file that expires 1 hour from now
      const future = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeTestState(makeStateFile({
        prNumber: 200,
        state: 'reviewing',
        expiresAt: future,
      }));

      const result = await checkExpired();
      expect(result).toHaveLength(0);
    });

    it('should not find approved or closed PRs even if expired', async () => {
      const past = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeTestState(makeStateFile({ prNumber: 300, state: 'approved', expiresAt: past }));
      await writeTestState(makeStateFile({ prNumber: 301, state: 'closed', expiresAt: past }));

      const result = await checkExpired();
      expect(result).toHaveLength(0);
    });

    it('should detect withinCooldown for recent disbandRequested', async () => {
      // Expired but disband was requested 1 hour ago (within 24h cooldown)
      const past = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const recentDisband = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeTestState(makeStateFile({
        prNumber: 400,
        state: 'reviewing',
        expiresAt: past,
        disbandRequested: recentDisband,
      }));

      const result = await checkExpired();
      expect(result).toHaveLength(1);
      expect(result[0].withinCooldown).toBe(true);
    });

    it('should not set withinCooldown for old disbandRequested (> 24h)', async () => {
      const past = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const oldDisband = new Date(Date.now() - DISBAND_COOLDOWN_MS - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeTestState(makeStateFile({
        prNumber: 500,
        state: 'reviewing',
        expiresAt: past,
        disbandRequested: oldDisband,
      }));

      const result = await checkExpired();
      expect(result).toHaveLength(1);
      expect(result[0].withinCooldown).toBe(false);
    });

    it('should skip corrupted state files', async () => {
      await mkdir(STATE_DIR, { recursive: true });
      const path = stateFilePath(600);
      await writeFile(path, 'not valid json\n', 'utf-8');

      const result = await checkExpired();
      expect(result).toEqual([]);
    });

    it('should find multiple expired reviewing PRs', async () => {
      const past = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeTestState(makeStateFile({ prNumber: 700, state: 'reviewing', expiresAt: past }));
      await writeTestState(makeStateFile({ prNumber: 701, state: 'reviewing', expiresAt: past }));
      await writeTestState(makeStateFile({ prNumber: 702, state: 'reviewing', expiresAt: past }));

      const result = await checkExpired();
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.prNumber).sort()).toEqual([700, 701, 702]);
    });
  });

  describe('markDisband', () => {
    beforeEach(cleanupTestStates);
    afterEach(cleanupTestStates);

    it('should update disbandRequested timestamp for reviewing PR', async () => {
      const past = new Date(Date.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await writeTestState(makeStateFile({
        prNumber: 800,
        state: 'reviewing',
        expiresAt: past,
      }));

      const result = await markDisband(800);
      expect(result.disbandRequested).not.toBeNull();
      expect(result.prNumber).toBe(800);

      // Verify on disk
      const filePath = stateFilePath(800);
      const content = await readFile(filePath, 'utf-8');
      const onDisk = JSON.parse(content) as PRStateFile;
      expect(onDisk.disbandRequested).toBeTruthy();
      expect(onDisk.updatedAt).toBeTruthy();
      expect(onDisk.prNumber).toBe(800);
    });

    it('should reject non-existent PR', async () => {
      await expect(markDisband(99999)).rejects.toThrow('not found');
    });

    it('should reject PR with state !== reviewing', async () => {
      await writeTestState(makeStateFile({ prNumber: 801, state: 'approved' }));
      await expect(markDisband(801)).rejects.toThrow('expected \'reviewing\'');
    });

    it('should reject PR with closed state', async () => {
      await writeTestState(makeStateFile({ prNumber: 802, state: 'closed' }));
      await expect(markDisband(802)).rejects.toThrow('expected \'reviewing\'');
    });

    it('should preserve other fields when updating', async () => {
      await writeTestState(makeStateFile({
        prNumber: 803,
        chatId: 'oc_test123',
        state: 'reviewing',
      }));

      const result = await markDisband(803);
      expect(result.chatId).toBe('oc_test123');
      expect(result.disbandRequested).not.toBeNull();
      expect(result.prNumber).toBe(803);
    });

    it('should overwrite previous disbandRequested', async () => {
      await writeTestState(makeStateFile({
        prNumber: 804,
        state: 'reviewing',
        disbandRequested: '2026-04-07T12:00:00Z',
      }));

      const result = await markDisband(804);
      expect(result.disbandRequested).not.toBe('2026-04-07T12:00:00Z');
      // Should be a recent timestamp
      const disbandTime = new Date(result.disbandRequested!).getTime();
      const now = Date.now();
      expect(Math.abs(now - disbandTime)).toBeLessThan(5000); // within 5 seconds
    });
  });
});
