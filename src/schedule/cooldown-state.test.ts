/**
 * Tests for Cooldown State Manager.
 *
 * Issue #869: 定时任务增加冷静期设计
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  CooldownStateManager,
  resetCooldownStateManager,
  DEFAULT_COOLDOWN_PERIOD,
} from './cooldown-state.js';

describe('CooldownStateManager', () => {
  let manager: CooldownStateManager;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cooldown-test-'));
    manager = new CooldownStateManager(tempDir);
    resetCooldownStateManager();
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getStatus', () => {
    it('should return not in cooldown for unknown task', async () => {
      const status = await manager.getStatus('unknown-task');
      expect(status.inCooldown).toBe(false);
    });

    it('should return in cooldown when task was recently executed', async () => {
      await manager.recordExecution('task-1', 60000); // 1 minute cooldown

      const status = await manager.getStatus('task-1');
      expect(status.inCooldown).toBe(true);
      expect(status.cooldownEndsAt).toBeDefined();
      expect(status.remainingMs).toBeGreaterThan(0);
      expect(status.remainingMs).toBeLessThanOrEqual(60000);
    });

    it('should return not in cooldown after cooldown expires', async () => {
      // Record execution with a very short cooldown (1ms)
      await manager.recordExecution('task-2', 1);

      // Wait for cooldown to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      const status = await manager.getStatus('task-2');
      expect(status.inCooldown).toBe(false);
      expect(status.lastExecutedAt).toBeDefined();
    });
  });

  describe('recordExecution', () => {
    it('should record execution and start cooldown', async () => {
      await manager.recordExecution('task-3', DEFAULT_COOLDOWN_PERIOD);

      const status = await manager.getStatus('task-3');
      expect(status.inCooldown).toBe(true);
      expect(status.lastExecutedAt).toBeDefined();
    });

    it('should update cooldown on subsequent executions', async () => {
      await manager.recordExecution('task-4', 1000);
      const status1 = await manager.getStatus('task-4');

      // Wait a bit and record again
      await new Promise(resolve => setTimeout(resolve, 10));
      await manager.recordExecution('task-4', 1000);
      const status2 = await manager.getStatus('task-4');

      // The lastExecutedAt should be different
      expect(status2.lastExecutedAt).not.toBe(status1.lastExecutedAt);
    });
  });

  describe('clearCooldown', () => {
    it('should clear cooldown for a task', async () => {
      await manager.recordExecution('task-5', 60000);

      const cleared = await manager.clearCooldown('task-5');
      expect(cleared).toBe(true);

      const status = await manager.getStatus('task-5');
      expect(status.inCooldown).toBe(false);
    });

    it('should return false when clearing non-existent cooldown', async () => {
      const cleared = await manager.clearCooldown('unknown-task');
      expect(cleared).toBe(false);
    });
  });

  describe('getAllInCooldown', () => {
    it('should return empty map when no tasks in cooldown', async () => {
      const result = await manager.getAllInCooldown();
      expect(result.size).toBe(0);
    });

    it('should return all tasks currently in cooldown', async () => {
      await manager.recordExecution('task-6', 60000);
      await manager.recordExecution('task-7', 60000);

      const result = await manager.getAllInCooldown();
      expect(result.size).toBe(2);
      expect(result.has('task-6')).toBe(true);
      expect(result.has('task-7')).toBe(true);
    });

    it('should not include expired cooldowns', async () => {
      await manager.recordExecution('task-8', 1); // 1ms cooldown
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await manager.getAllInCooldown();
      expect(result.size).toBe(0);
    });
  });

  describe('cleanupExpired', () => {
    it('should remove entries that expired more than 24 hours ago', async () => {
      // Create an entry with an old timestamp by manipulating the file
      await manager.recordExecution('old-task', 1000);

      // Manually update the file to have an old timestamp
      const stateFile = path.join(tempDir, 'schedules-state', 'cooldown.json');
      const content = await fs.readFile(stateFile, 'utf-8');
      const state = JSON.parse(content);

      // Set lastExecutedAt to 25 hours ago
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
      state['old-task'].lastExecutedAt = oldDate.toISOString();

      await fs.writeFile(stateFile, JSON.stringify(state), 'utf-8');

      // Clear cache to force re-read
      manager.clearCache();

      const removed = await manager.cleanupExpired();
      expect(removed).toBe(1);

      const status = await manager.getStatus('old-task');
      expect(status.inCooldown).toBe(false);
    });

    it('should return 0 when no entries to clean up', async () => {
      await manager.recordExecution('fresh-task', 60000);
      const removed = await manager.cleanupExpired();
      expect(removed).toBe(0);
    });
  });

  describe('persistence', () => {
    it('should persist state across manager instances', async () => {
      await manager.recordExecution('persistent-task', 60000);

      // Create a new manager instance with the same directory
      const newManager = new CooldownStateManager(tempDir);
      const status = await newManager.getStatus('persistent-task');

      expect(status.inCooldown).toBe(true);
    });
  });
});

describe('DEFAULT_COOLDOWN_PERIOD', () => {
  it('should be 5 minutes in milliseconds', () => {
    expect(DEFAULT_COOLDOWN_PERIOD).toBe(5 * 60 * 1000);
  });
});
