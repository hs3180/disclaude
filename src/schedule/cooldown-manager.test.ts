/**
 * Tests for CooldownManager.
 *
 * Issue #869: Cooldown period for scheduled tasks.
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CooldownManager } from './cooldown-manager.js';

describe('CooldownManager', () => {
  let tempDir: string;
  let cooldownDir: string;
  let manager: CooldownManager;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cooldown-test-'));
    cooldownDir = path.join(tempDir, '.cooldown');
    manager = new CooldownManager({ cooldownDir });
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  describe('isInCooldown', () => {
    it('should return false when no record exists', async () => {
      const result = await manager.isInCooldown('task-1', 60000);
      expect(result).toBe(false);
    });

    it('should return false when cooldown has expired', async () => {
      // Record execution with 1ms cooldown
      await manager.recordExecution('task-1', 1);

      // Wait for cooldown to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await manager.isInCooldown('task-1', 1);
      expect(result).toBe(false);
    });

    it('should return true when in cooldown period', async () => {
      // Record execution with 10 second cooldown
      await manager.recordExecution('task-1', 10000);

      const result = await manager.isInCooldown('task-1', 10000);
      expect(result).toBe(true);
    });
  });

  describe('getCooldownStatus', () => {
    it('should return null status when no record exists', async () => {
      const status = await manager.getCooldownStatus('task-1');

      expect(status.isInCooldown).toBe(false);
      expect(status.lastExecutionTime).toBeNull();
      expect(status.cooldownEndsAt).toBeNull();
      expect(status.remainingMs).toBe(0);
    });

    it('should return status when record exists', async () => {
      await manager.recordExecution('task-1', 60000);

      const status = await manager.getCooldownStatus('task-1', 60000);

      expect(status.isInCooldown).toBe(true);
      expect(status.lastExecutionTime).not.toBeNull();
      expect(status.cooldownEndsAt).not.toBeNull();
      expect(status.remainingMs).toBeGreaterThan(0);
      expect(status.remainingMs).toBeLessThanOrEqual(60000);
    });

    it('should show remaining time correctly', async () => {
      const cooldownPeriod = 60000; // 1 minute
      await manager.recordExecution('task-1', cooldownPeriod);

      const status = await manager.getCooldownStatus('task-1', cooldownPeriod);

      // Remaining time should be close to cooldown period
      expect(status.remainingMs).toBeGreaterThan(50000);
      expect(status.remainingMs).toBeLessThanOrEqual(60000);
    });
  });

  describe('recordExecution', () => {
    it('should record execution and create file', async () => {
      await manager.recordExecution('task-1', 60000);

      // Check file was created
      const files = await fsPromises.readdir(cooldownDir);
      expect(files.length).toBe(1);
      expect(files[0]).toBe('task-1.json');
    });

    it('should update existing record', async () => {
      await manager.recordExecution('task-1', 60000);
      await new Promise(resolve => setTimeout(resolve, 100));
      await manager.recordExecution('task-1', 30000);

      const status = await manager.getCooldownStatus('task-1', 30000);

      // Should use the new cooldown period
      expect(status.remainingMs).toBeLessThanOrEqual(30000);
    });
  });

  describe('clearCooldown', () => {
    it('should return false when no record exists', async () => {
      const result = await manager.clearCooldown('task-1');
      expect(result).toBe(false);
    });

    it('should clear existing cooldown', async () => {
      await manager.recordExecution('task-1', 60000);

      const result = await manager.clearCooldown('task-1');
      expect(result).toBe(true);

      // Check file was deleted
      const files = await fsPromises.readdir(cooldownDir);
      expect(files.length).toBe(0);

      // Check memory was cleared
      const isInCooldown = await manager.isInCooldown('task-1', 60000);
      expect(isInCooldown).toBe(false);
    });
  });

  describe('getAllInCooldown', () => {
    it('should return empty array when no tasks in cooldown', async () => {
      const result = await manager.getAllInCooldown();
      expect(result).toEqual([]);
    });

    it('should return all tasks in cooldown', async () => {
      await manager.recordExecution('task-1', 60000);
      await manager.recordExecution('task-2', 120000);

      const result = await manager.getAllInCooldown();

      expect(result.length).toBe(2);
      expect(result.map(r => r.taskId).sort()).toEqual(['task-1', 'task-2']);
    });

    it('should not include expired cooldowns', async () => {
      await manager.recordExecution('task-1', 1); // Expires immediately
      await manager.recordExecution('task-2', 60000);

      // Wait for task-1 to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = await manager.getAllInCooldown();

      expect(result.length).toBe(1);
      expect(result[0].taskId).toBe('task-2');
    });
  });

  describe('persistence', () => {
    it('should load records from disk on initialization', async () => {
      // Record with first manager
      await manager.recordExecution('task-1', 60000);

      // Create new manager (simulates restart)
      const newManager = new CooldownManager({ cooldownDir });

      // Should load the existing record
      const isInCooldown = await newManager.isInCooldown('task-1', 60000);
      expect(isInCooldown).toBe(true);
    });

    it('should not load expired records', async () => {
      // Record with 1ms cooldown
      await manager.recordExecution('task-1', 1);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10));

      // Create new manager (simulates restart)
      const newManager = new CooldownManager({ cooldownDir });

      // Should not load expired record
      const isInCooldown = await newManager.isInCooldown('task-1', 1);
      expect(isInCooldown).toBe(false);
    });
  });
});
