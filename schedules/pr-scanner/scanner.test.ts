import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseStateFile,
  validateStateFile,
  nowISO,
  expiryISO,
  stateFilePath,
  atomicWrite,
  checkCapacity,
  listCandidates,
  createState,
  markState,
  getStatus,
  STATE_DIR,
  type PRStateFile,
} from './scanner.js';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Use a test-specific state directory to avoid polluting real state
const TEST_STATE_DIR = resolve('.temp-chats-test');

// Override STATE_DIR for testing by using functions that accept the dir
// We'll test with the real functions but in a controlled temp dir

describe('scanner.ts', () => {
  describe('nowISO', () => {
    it('should return UTC Z-suffix format', () => {
      const result = nowISO();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  describe('expiryISO', () => {
    it('should return a timestamp 48 hours in the future', () => {
      const now = new Date();
      const expiry = new Date(expiryISO());
      const diff = expiry.getTime() - now.getTime();
      // Should be ~48h (allow 1s tolerance)
      expect(diff).toBeGreaterThan(48 * 60 * 60 * 1000 - 1000);
      expect(diff).toBeLessThan(48 * 60 * 60 * 1000 + 1000);
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
      const json = JSON.stringify({
        prNumber: 123,
        chatId: 'oc_test',
        state: 'reviewing',
        createdAt: '2026-04-07T10:00:00Z',
        updatedAt: '2026-04-07T10:00:00Z',
        expiresAt: '2026-04-09T10:00:00Z',
        disbandRequested: null,
      });
      const result = parseStateFile(json, 'test.json');
      expect(result.prNumber).toBe(123);
      expect(result.state).toBe('reviewing');
      expect(result.chatId).toBe('oc_test');
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
      const data = { prNumber: -1, state: 'reviewing', createdAt: 't', updatedAt: 't', expiresAt: 't' };
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('prNumber');
    });

    it('should reject invalid state', () => {
      const data = { prNumber: 1, state: 'invalid', createdAt: 't', updatedAt: 't', expiresAt: 't' };
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('state');
    });

    it('should reject "rejected" state (not in spec)', () => {
      const data = { prNumber: 1, state: 'rejected', createdAt: 't', updatedAt: 't', expiresAt: 't' };
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('state');
    });

    it('should accept all valid states', () => {
      for (const state of ['reviewing', 'approved', 'closed']) {
        const data = { prNumber: 1, state, createdAt: 't', updatedAt: 't', expiresAt: 't' };
        const result = parseStateFile(JSON.stringify(data), 'test.json');
        expect(result.state).toBe(state);
      }
    });

    it('should reject missing createdAt', () => {
      const data = { prNumber: 1, state: 'reviewing', updatedAt: 't', expiresAt: 't' };
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('createdAt');
    });

    it('should accept null chatId', () => {
      const data = { prNumber: 1, state: 'reviewing', createdAt: 't', updatedAt: 't', expiresAt: 't', chatId: null };
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.chatId).toBeNull();
    });

    it('should accept string chatId', () => {
      const data = { prNumber: 1, state: 'reviewing', createdAt: 't', updatedAt: 't', expiresAt: 't', chatId: 'oc_abc123' };
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.chatId).toBe('oc_abc123');
    });

    it('should reject non-string chatId', () => {
      const data = { prNumber: 1, state: 'reviewing', createdAt: 't', updatedAt: 't', expiresAt: 't', chatId: 123 };
      expect(() => parseStateFile(JSON.stringify(data), 'test.json')).toThrow('chatId');
    });

    it('should accept null disbandRequested', () => {
      const data = { prNumber: 1, state: 'reviewing', createdAt: 't', updatedAt: 't', expiresAt: 't', disbandRequested: null };
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.disbandRequested).toBeNull();
    });

    it('should accept undefined disbandRequested', () => {
      const data = { prNumber: 1, state: 'reviewing', createdAt: 't', updatedAt: 't', expiresAt: 't' };
      const result = parseStateFile(JSON.stringify(data), 'test.json');
      expect(result.disbandRequested).toBeUndefined();
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

  describe('actions with real filesystem', () => {
    // Save and restore original STATE_DIR behavior
    // Since STATE_DIR is a module-level constant, we test against the real .temp-chats/
    // but clean up after ourselves
    const realStateDir = STATE_DIR;
    let createdDir = false;

    beforeEach(async () => {
      // Create .temp-chats/ if it doesn't exist for tests
      try {
        await mkdir(realStateDir, { recursive: true });
        createdDir = true;
      } catch { /* already exists */ }

      // Clean up any test files from previous runs
      try {
        const files = await readdir(realStateDir);
        for (const f of files) {
          if (f.startsWith('pr-') && f.endsWith('.json')) {
            await rm(resolve(realStateDir, f));
          }
        }
      } catch { /* dir doesn't exist */ }
    });

    afterEach(async () => {
      // Clean up test files
      try {
        const files = await readdir(realStateDir);
        for (const f of files) {
          if (f.startsWith('pr-') && f.endsWith('.json')) {
            await rm(resolve(realStateDir, f));
          }
        }
      } catch { /* ignore */ }
    });

    describe('createState', () => {
      it('should create a valid state file', async () => {
        const result = await createState(100);

        expect(result.prNumber).toBe(100);
        expect(result.state).toBe('reviewing');
        expect(result.chatId).toBeNull();
        expect(result.disbandRequested).toBeNull();
        expect(result.createdAt).toBeTruthy();
        expect(result.updatedAt).toBeTruthy();
        expect(result.expiresAt).toBeTruthy();

        // Verify file on disk
        const filePath = stateFilePath(100);
        const content = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.prNumber).toBe(100);
        expect(parsed.state).toBe('reviewing');
      });

      it('should reject creating a state file that already exists', async () => {
        await createState(200);
        await expect(createState(200)).rejects.toThrow('already exists');
      });
    });

    describe('markState', () => {
      it('should update state from reviewing to approved', async () => {
        await createState(300);
        const result = await markState(300, 'approved');
        expect(result.state).toBe('approved');
        expect(result.prNumber).toBe(300);

        // Verify on disk
        const filePath = stateFilePath(300);
        const content = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.state).toBe('approved');
      });

      it('should update state from reviewing to closed', async () => {
        await createState(301);
        const result = await markState(301, 'closed');
        expect(result.state).toBe('closed');
      });

      it('should update updatedAt timestamp', async () => {
        const created = await createState(302);
        // Wait 1.1s to ensure second-precision timestamp changes
        await new Promise((r) => setTimeout(r, 1100));
        await markState(302, 'approved');
        const onDisk = await readFile(stateFilePath(302), 'utf-8').then(
          (c) => JSON.parse(c) as PRStateFile
        );
        expect(onDisk.updatedAt).not.toBe(onDisk.createdAt);
      });

      it('should reject updating non-existent PR', async () => {
        await expect(markState(99999, 'approved')).rejects.toThrow('not found');
      });

      it('should preserve other fields when updating state', async () => {
        const created = await createState(303);
        // Simulate adding a chatId manually
        const filePath = stateFilePath(303);
        const data = JSON.parse(await readFile(filePath, 'utf-8'));
        data.chatId = 'oc_test123';
        await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');

        const result = await markState(303, 'closed');
        expect(result.chatId).toBe('oc_test123');
        expect(result.state).toBe('closed');
      });
    });

    describe('checkCapacity', () => {
      it('should report 0 reviewing when no state files exist', async () => {
        const result = await checkCapacity(2);
        expect(result.reviewing).toBe(0);
        expect(result.maxConcurrent).toBe(2);
        expect(result.available).toBe(2);
      });

      it('should count reviewing state files correctly', async () => {
        await createState(400);
        await createState(401);
        const result = await checkCapacity(2);
        expect(result.reviewing).toBe(2);
        expect(result.available).toBe(0);
      });

      it('should not count approved or closed files', async () => {
        await createState(410);
        await createState(411);
        await markState(410, 'approved');
        await markState(411, 'closed');
        const result = await checkCapacity(2);
        expect(result.reviewing).toBe(0);
        expect(result.available).toBe(2);
      });

      it('should handle maxConcurrent of 0', async () => {
        const result = await checkCapacity(0);
        expect(result.available).toBe(0);
      });

      it('should report available as 0 when reviewing exceeds maxConcurrent', async () => {
        await createState(420);
        await createState(421);
        await createState(422);
        const result = await checkCapacity(2);
        expect(result.reviewing).toBe(3);
        expect(result.available).toBe(0);
      });
    });

    describe('listCandidates', () => {
      it('should return all PRs when no state files exist', async () => {
        const result = await listCandidates([1, 2, 3]);
        expect(result).toEqual([1, 2, 3]);
      });

      it('should filter out PRs that have state files', async () => {
        await createState(500);
        await createState(501);
        const result = await listCandidates([500, 501, 502]);
        expect(result).toEqual([502]);
      });

      it('should return empty array when all PRs have state files', async () => {
        await createState(510);
        await createState(511);
        const result = await listCandidates([510, 511]);
        expect(result).toEqual([]);
      });

      it('should return empty array for empty input', async () => {
        const result = await listCandidates([]);
        expect(result).toEqual([]);
      });
    });

    describe('getStatus', () => {
      it('should return empty groups when no state files exist', async () => {
        const result = await getStatus();
        expect(result.reviewing).toEqual([]);
        expect(result.approved).toEqual([]);
        expect(result.closed).toEqual([]);
      });

      it('should group PRs by state', async () => {
        await createState(600);
        await createState(601);
        await createState(602);
        await markState(601, 'approved');
        await markState(602, 'closed');

        const result = await getStatus();
        expect(result.reviewing.length).toBe(1);
        expect(result.reviewing[0].prNumber).toBe(600);
        expect(result.approved.length).toBe(1);
        expect(result.approved[0].prNumber).toBe(601);
        expect(result.closed.length).toBe(1);
        expect(result.closed[0].prNumber).toBe(602);
      });

      it('should sort PRs within each group by number', async () => {
        await createState(603);
        await createState(604);
        await createState(605);

        const result = await getStatus();
        expect(result.reviewing.map((f) => f.prNumber)).toEqual([603, 604, 605]);
      });

      it('should skip corrupted files', async () => {
        await createState(610);
        // Write a corrupted file
        const badPath = stateFilePath(999);
        const { writeFile: wf } = await import('node:fs/promises');
        await wf(badPath, 'not valid json');

        const result = await getStatus();
        expect(result.reviewing.length).toBe(1);
        expect(result.reviewing[0].prNumber).toBe(610);

        // Clean up
        await rm(badPath);
      });
    });
  });
});
