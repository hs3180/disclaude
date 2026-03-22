/**
 * Unit tests for CooldownManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CooldownManager } from './cooldown-manager.js';
import * as fsPromises from 'fs/promises';

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
  mkdir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

describe('CooldownManager', () => {
  let manager: CooldownManager;
  let cooldownDir: string;

  beforeEach(() => {
    cooldownDir = '/tmp/test-cooldown';
    manager = new CooldownManager({ cooldownDir });

    // Mock mkdir to succeed
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    // Mock readdir to return empty
    vi.mocked(fsPromises.readdir).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a CooldownManager', () => {
      expect(manager).toBeDefined();
    });
  });

  describe('isInCooldown', () => {
    it('should return false for task with no record', async () => {
      const result = await manager.isInCooldown('task-1', 60000);
      expect(result).toBe(false);
    });

    it('should return true for task in cooldown', async () => {
      await manager.recordExecution('task-1', 60000);
      const result = await manager.isInCooldown('task-1');
      expect(result).toBe(true);
    });

    it('should return false after cooldown expires', async () => {
      // Record execution with very short cooldown
      await manager.recordExecution('task-1', 1); // 1ms cooldown
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = await manager.isInCooldown('task-1');
      expect(result).toBe(false);
    });

    it('should allow custom cooldown period', async () => {
      await manager.recordExecution('task-1', 60000); // 60s cooldown
      // Custom check with longer period
      const result = await manager.isInCooldown('task-1', 120000);
      expect(result).toBe(true);
    });
  });

  describe('recordExecution', () => {
    it('should record execution and persist to file', async () => {
      await manager.recordExecution('task-1', 60000);

      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('task-1.json'),
        expect.stringContaining('"taskId": "task-1"'),
        'utf-8'
      );
    });

    it('should handle writeFile errors gracefully', async () => {
      vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('Write error'));
      // Should not throw
      await expect(manager.recordExecution('task-1', 60000)).resolves.not.toThrow();
    });

    it('should update existing record on re-execution', async () => {
      await manager.recordExecution('task-1', 30000);
      await manager.recordExecution('task-1', 60000);

      // Should still be in cooldown with new period
      const result = await manager.isInCooldown('task-1', 60000);
      expect(result).toBe(true);
    });
  });

  describe('clearCooldown', () => {
    it('should return false for task with no record', async () => {
      const result = await manager.clearCooldown('non-existent');
      expect(result).toBe(false);
    });

    it('should clear cooldown and return true', async () => {
      await manager.recordExecution('task-1', 60000);
      const result = await manager.clearCooldown('task-1');

      expect(result).toBe(true);
      expect(fsPromises.unlink).toHaveBeenCalled();

      // Should no longer be in cooldown
      const inCooldown = await manager.isInCooldown('task-1');
      expect(inCooldown).toBe(false);
    });

    it('should handle unlink ENOENT gracefully', async () => {
      await manager.recordExecution('task-1', 60000);
      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.unlink).mockRejectedValue(enoentError);

      // Should not throw
      const result = await manager.clearCooldown('task-1');
      expect(result).toBe(true); // Still removed from memory
    });
  });

  describe('getCooldownStatus', () => {
    it('should return null status for non-existent task', async () => {
      const status = await manager.getCooldownStatus('non-existent', 60000);
      expect(status.isInCooldown).toBe(false);
      expect(status.lastExecutionTime).toBeNull();
      expect(status.cooldownEndsAt).toBeNull();
      expect(status.remainingMs).toBe(0);
    });

    it('should return correct status for active cooldown', async () => {
      await manager.recordExecution('task-1', 60000);
      const status = await manager.getCooldownStatus('task-1');

      expect(status.isInCooldown).toBe(true);
      expect(status.lastExecutionTime).not.toBeNull();
      expect(status.cooldownEndsAt).not.toBeNull();
      expect(status.remainingMs).toBeGreaterThan(0);
    });
  });

  describe('getAllInCooldown', () => {
    it('should return empty array when no tasks are in cooldown', async () => {
      const all = await manager.getAllInCooldown();
      expect(all).toEqual([]);
    });

    it('should return all tasks currently in cooldown', async () => {
      await manager.recordExecution('task-1', 60000);
      await manager.recordExecution('task-2', 60000);

      const all = await manager.getAllInCooldown();
      expect(all).toHaveLength(2);
      expect(all.map(t => t.taskId)).toContain('task-1');
      expect(all.map(t => t.taskId)).toContain('task-2');
    });

    it('should not include expired tasks', async () => {
      await manager.recordExecution('task-1', 1); // 1ms cooldown
      await manager.recordExecution('task-2', 60000);

      await new Promise(resolve => setTimeout(resolve, 10));

      const all = await manager.getAllInCooldown();
      expect(all).toHaveLength(1);
      expect(all[0].taskId).toBe('task-2');
    });
  });

  describe('initialization', () => {
    it('should load existing records from disk', async () => {
      const record = {
        taskId: 'existing-task',
        lastExecutionTime: new Date().toISOString(),
        cooldownPeriod: 60000,
      };

      vi.mocked(fsPromises.readdir).mockResolvedValue(['existing-task.json'] as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(JSON.stringify(record));

      const freshManager = new CooldownManager({ cooldownDir });
      const inCooldown = await freshManager.isInCooldown('existing-task');
      expect(inCooldown).toBe(true);
    });

    it('should skip expired records from disk', async () => {
      const expiredRecord = {
        taskId: 'expired-task',
        lastExecutionTime: new Date(Date.now() - 120000).toISOString(),
        cooldownPeriod: 60000, // 60s, already expired
      };

      vi.mocked(fsPromises.readdir).mockResolvedValue(['expired-task.json'] as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(JSON.stringify(expiredRecord));
      vi.mocked(fsPromises.unlink).mockResolvedValue(undefined);

      const freshManager = new CooldownManager({ cooldownDir });
      const inCooldown = await freshManager.isInCooldown('expired-task');
      expect(inCooldown).toBe(false);
    });

    it('should handle directory creation errors gracefully', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error('Permission denied'));
      vi.mocked(fsPromises.readdir).mockRejectedValue(new Error('ENOENT'));

      // Should not throw - continues without persistence
      await manager.recordExecution('task-1', 60000);
      const result = await manager.isInCooldown('task-1');
      expect(result).toBe(true); // Still works in memory
    });
  });
});
