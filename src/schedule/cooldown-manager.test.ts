/**
 * Tests for CooldownManager.
 *
 * Issue #869: 定时任务增加冷静期设计
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CooldownManager } from './cooldown-manager.js';

describe('CooldownManager', () => {
  let tempDir: string;
  let manager: CooldownManager;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cooldown-test-'));
    manager = new CooldownManager({ cooldownDir: tempDir });
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('checkCooldown', () => {
    it('should return not in cooldown when no previous execution', async () => {
      const status = await manager.checkCooldown('task-1', 60000);

      expect(status.inCooldown).toBe(false);
      expect(status.taskId).toBe('task-1');
      expect(status.cooldownPeriod).toBe(60000);
      expect(status.remainingMs).toBe(0);
    });

    it('should return not in cooldown when cooldownPeriod is 0', async () => {
      await manager.recordExecution('task-1', 60000);

      const status = await manager.checkCooldown('task-1', 0);

      expect(status.inCooldown).toBe(false);
      expect(status.remainingMs).toBe(0);
    });

    it('should return not in cooldown when cooldownPeriod is negative', async () => {
      await manager.recordExecution('task-1', 60000);

      const status = await manager.checkCooldown('task-1', -1000);

      expect(status.inCooldown).toBe(false);
    });

    it('should return in cooldown after recent execution', async () => {
      const cooldownPeriod = 60000; // 1 minute
      await manager.recordExecution('task-1', cooldownPeriod);

      const status = await manager.checkCooldown('task-1', cooldownPeriod);

      expect(status.inCooldown).toBe(true);
      expect(status.taskId).toBe('task-1');
      expect(status.remainingMs).toBeGreaterThan(0);
      expect(status.remainingMs).toBeLessThanOrEqual(cooldownPeriod);
      expect(status.cooldownEndsAt).toBeDefined();
      expect(status.lastExecutionTime).toBeDefined();
    });

    it('should return not in cooldown after cooldown period expires', async () => {
      // Record execution with very short cooldown
      await manager.recordExecution('task-1', 100); // 100ms

      // Wait for cooldown to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      const status = await manager.checkCooldown('task-1', 100);

      expect(status.inCooldown).toBe(false);
      expect(status.remainingMs).toBe(0);
    });
  });

  describe('recordExecution', () => {
    it('should record execution and start cooldown', async () => {
      await manager.recordExecution('task-1', 300000);

      const status = await manager.checkCooldown('task-1', 300000);

      expect(status.inCooldown).toBe(true);
      expect(status.lastExecutionTime).toBeDefined();
    });

    it('should not record when cooldownPeriod is 0', async () => {
      await manager.recordExecution('task-1', 0);

      const status = await manager.checkCooldown('task-1', 60000);

      expect(status.inCooldown).toBe(false);
    });

    it('should update lastExecutionTime on subsequent calls', async () => {
      await manager.recordExecution('task-1', 1000);
      const status1 = await manager.checkCooldown('task-1', 1000);
      const time1 = status1.lastExecutionTime;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      await manager.recordExecution('task-1', 1000);
      const status2 = await manager.checkCooldown('task-1', 1000);
      const time2 = status2.lastExecutionTime;

      expect(time1).not.toBe(time2);
    });

    it('should persist cooldown state to file', async () => {
      await manager.recordExecution('task-1', 300000);

      // Create a new manager to verify persistence
      const newManager = new CooldownManager({ cooldownDir: tempDir });
      const status = await newManager.checkCooldown('task-1', 300000);

      expect(status.inCooldown).toBe(true);
    });
  });

  describe('clearCooldown', () => {
    it('should clear existing cooldown', async () => {
      await manager.recordExecution('task-1', 60000);

      const cleared = await manager.clearCooldown('task-1');

      expect(cleared).toBe(true);

      const status = await manager.checkCooldown('task-1', 60000);
      expect(status.inCooldown).toBe(false);
    });

    it('should return false when no cooldown exists', async () => {
      const cleared = await manager.clearCooldown('task-nonexistent');

      expect(cleared).toBe(false);
    });

    it('should clear persisted cooldown file', async () => {
      await manager.recordExecution('task-1', 60000);
      await manager.clearCooldown('task-1');

      // Create a new manager to verify file was deleted
      const newManager = new CooldownManager({ cooldownDir: tempDir });
      const status = await newManager.checkCooldown('task-1', 60000);

      expect(status.inCooldown).toBe(false);
    });
  });

  describe('getAllCooldownStatus', () => {
    it('should return empty map when no cooldowns exist', async () => {
      const allStatus = await manager.getAllCooldownStatus();

      expect(allStatus.size).toBe(0);
    });

    it('should return all active cooldowns', async () => {
      await manager.recordExecution('task-1', 60000);
      await manager.recordExecution('task-2', 120000);

      const allStatus = await manager.getAllCooldownStatus();

      expect(allStatus.size).toBe(2);
      expect(allStatus.get('task-1')?.inCooldown).toBe(true);
      expect(allStatus.get('task-2')?.inCooldown).toBe(true);
    });
  });

  describe('cleanupExpired', () => {
    it('should not clean up recently expired cooldowns', async () => {
      await manager.recordExecution('task-1', 100);
      await new Promise(resolve => setTimeout(resolve, 150));

      const cleaned = await manager.cleanupExpired();

      // Recently expired (less than 24h) should not be cleaned
      expect(cleaned).toBe(0);
    });

    it('should clean up old expired cooldowns', async () => {
      // Create a cooldown record with old timestamp
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
      const filePath = path.join(tempDir, 'task-old.json');
      await fs.promises.writeFile(filePath, JSON.stringify({
        taskId: 'task-old',
        lastExecutionTime: oldDate,
        cooldownPeriod: 60000,
      }));

      const cleaned = await manager.cleanupExpired();

      expect(cleaned).toBe(1);

      // Verify file was deleted
      const status = await manager.checkCooldown('task-old', 60000);
      expect(status.inCooldown).toBe(false);
    });
  });

  describe('persistence', () => {
    it('should survive manager restart', async () => {
      await manager.recordExecution('task-1', 300000);

      // Create a new manager instance
      const newManager = new CooldownManager({ cooldownDir: tempDir });

      const status = await newManager.checkCooldown('task-1', 300000);
      expect(status.inCooldown).toBe(true);
    });

    it('should load multiple records on initialization', async () => {
      await manager.recordExecution('task-1', 60000);
      await manager.recordExecution('task-2', 120000);
      await manager.recordExecution('task-3', 180000);

      // Create a new manager instance
      const newManager = new CooldownManager({ cooldownDir: tempDir });

      const allStatus = await newManager.getAllCooldownStatus();
      expect(allStatus.size).toBe(3);
    });
  });
});
