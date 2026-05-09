/**
 * Tests for ProcessLock — PID file-based singleton enforcement.
 *
 * Issue #3417: Prevents launchd KeepAlive crash-restart from spawning
 * duplicate processes.
 *
 * @module utils/process-lock.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProcessLock } from './process-lock.js';
import type { Logger } from 'pino';
import { createLogger } from './logger.js';

describe('ProcessLock', () => {
  let tmpDir: string;
  let lockfilePath: string;
  let logger: Logger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-lock-test-'));
    lockfilePath = path.join(tmpDir, 'test.pid');
    logger = createLogger('test');
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('acquire', () => {
    it('should acquire lock when no PID file exists', () => {
      const lock = new ProcessLock({ lockfilePath, logger });

      const result = lock.acquire();

      expect(result).toBe(true);
      expect(lock.isAcquired).toBe(true);
      expect(fs.existsSync(lockfilePath)).toBe(true);
      expect(fs.readFileSync(lockfilePath, 'utf-8').trim()).toBe(String(process.pid));
    });

    it('should acquire lock and create parent directory if needed', () => {
      const nestedPath = path.join(tmpDir, 'sub', 'dir', 'test.pid');
      const lock = new ProcessLock({ lockfilePath: nestedPath, logger });

      const result = lock.acquire();

      expect(result).toBe(true);
      expect(fs.existsSync(nestedPath)).toBe(true);
    });

    it('should refuse when another process is running (PID file with active PID)', () => {
      // Write the PID of the current test process — it IS running
      fs.writeFileSync(lockfilePath, String(process.pid), 'utf-8');

      // Create a lock that pretends to be a different instance
      // Since process.kill(process.pid, 0) succeeds for our own PID,
      // we need to simulate a "foreign" PID file by writing our own PID
      // and checking that a NEW lock instance sees it as occupied.
      const lock = new ProcessLock({ lockfilePath, logger });

      // Our own PID IS running, so a second lock attempt should fail
      // But wait — this IS our PID. The lock will see it and think
      // another instance is running.
      const result = lock.acquire();

      expect(result).toBe(false);
      expect(lock.isAcquired).toBe(false);
    });

    it('should remove stale PID file when process is not running', () => {
      // Use a PID that definitely doesn't exist (max PID + 1)
      const stalePid = 99999999;
      fs.writeFileSync(lockfilePath, String(stalePid), 'utf-8');

      const lock = new ProcessLock({ lockfilePath, logger });
      const result = lock.acquire();

      expect(result).toBe(true);
      expect(lock.isAcquired).toBe(true);
      // PID file should now contain our PID
      expect(fs.readFileSync(lockfilePath, 'utf-8').trim()).toBe(String(process.pid));
    });

    it('should handle corrupt PID file gracefully', () => {
      fs.writeFileSync(lockfilePath, 'not-a-number', 'utf-8');

      const lock = new ProcessLock({ lockfilePath, logger });
      const result = lock.acquire();

      expect(result).toBe(true);
      expect(fs.readFileSync(lockfilePath, 'utf-8').trim()).toBe(String(process.pid));
    });
  });

  describe('release', () => {
    it('should remove PID file on release', () => {
      const lock = new ProcessLock({ lockfilePath, logger });
      lock.acquire();

      expect(fs.existsSync(lockfilePath)).toBe(true);
      lock.release();

      expect(fs.existsSync(lockfilePath)).toBe(false);
      expect(lock.isAcquired).toBe(false);
    });

    it('should be a no-op if lock was never acquired', () => {
      const lock = new ProcessLock({ lockfilePath, logger });

      // Should not throw
      lock.release();
      expect(lock.isAcquired).toBe(false);
    });

    it('should not remove PID file if PID changed (race condition protection)', () => {
      const lock = new ProcessLock({ lockfilePath, logger });
      lock.acquire();

      // Simulate another process overwriting the PID file
      fs.writeFileSync(lockfilePath, '99999', 'utf-8');

      lock.release();

      // File should still exist because PID doesn't match
      expect(fs.existsSync(lockfilePath)).toBe(true);
      expect(fs.readFileSync(lockfilePath, 'utf-8').trim()).toBe('99999');
    });
  });

  describe('acquire + release lifecycle', () => {
    it('should support acquire → release → acquire cycle', () => {
      const lock = new ProcessLock({ lockfilePath, logger });

      // First acquire
      expect(lock.acquire()).toBe(true);
      expect(lock.isAcquired).toBe(true);

      // Release
      lock.release();
      expect(lock.isAcquired).toBe(false);

      // Re-acquire (should work after release)
      expect(lock.acquire()).toBe(true);
      expect(lock.isAcquired).toBe(true);
      expect(fs.readFileSync(lockfilePath, 'utf-8').trim()).toBe(String(process.pid));
    });
  });
});
