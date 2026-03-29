/**
 * Unit tests for ScheduleManager
 *
 * Issue #1617 Phase 2: Tests for schedule query operations.
 *
 * Tests cover:
 * - get: retrieve task by ID
 * - listByChatId: filter tasks by chat scope
 * - listEnabled: filter enabled tasks for scheduler
 * - listAll: retrieve all tasks
 * - Edge cases: empty directory, missing tasks, file system errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock the schedule-watcher module to avoid file system dependencies
const mockScanAll = vi.fn<() => Promise<ScheduledTask[]>>();

vi.mock('./schedule-watcher.js', () => ({
  ScheduleFileScanner: vi.fn().mockImplementation(() => ({
    scanAll: (...args: unknown[]) => mockScanAll(...args),
  })),
}));

// ============================================================================
// Helpers
// ============================================================================

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    cron: '0 9 * * *',
    prompt: 'Run tests',
    chatId: 'oc_test',
    enabled: true,
    blocking: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ScheduleManager', () => {
  let manager: ScheduleManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ScheduleManager({ schedulesDir: '/tmp/test-schedules' });
  });

  describe('constructor', () => {
    it('should create ScheduleManager with schedules directory', () => {
      expect(manager).toBeDefined();
    });

    it('should expose file scanner', () => {
      expect(manager.getFileScanner()).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return task by ID when found', async () => {
      const task = createTask({ id: 'task-abc' });
      mockScanAll.mockResolvedValue([task]);

      const result = await manager.get('task-abc');
      expect(result).toBeDefined();
      expect(result!.id).toBe('task-abc');
      expect(result!.name).toBe('Test Task');
    });

    it('should return undefined for non-existent task ID', async () => {
      mockScanAll.mockResolvedValue([createTask({ id: 'task-1' })]);

      const result = await manager.get('non-existent');
      expect(result).toBeUndefined();
    });

    it('should return undefined when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.get('any-id');
      expect(result).toBeUndefined();
    });

    it('should scan all tasks on each call (no caching)', async () => {
      mockScanAll.mockResolvedValue([createTask({ id: 'task-1' })]);

      await manager.get('task-1');
      await manager.get('task-1');
      await manager.get('task-1');

      expect(mockScanAll).toHaveBeenCalledTimes(3);
    });
  });

  describe('listByChatId', () => {
    it('should return only tasks matching the chatId', async () => {
      const tasks = [
        createTask({ id: 'task-1', chatId: 'oc_chat1' }),
        createTask({ id: 'task-2', chatId: 'oc_chat2' }),
        createTask({ id: 'task-3', chatId: 'oc_chat1' }),
        createTask({ id: 'task-4', chatId: 'oc_chat3' }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listByChatId('oc_chat1');
      expect(result).toHaveLength(2);
      expect(result.map(t => t.id)).toEqual(['task-1', 'task-3']);
    });

    it('should return empty array when no tasks match chatId', async () => {
      mockScanAll.mockResolvedValue([createTask({ chatId: 'oc_other' })]);

      const result = await manager.listByChatId('oc_nonexistent');
      expect(result).toEqual([]);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listByChatId('oc_any');
      expect(result).toEqual([]);
    });
  });

  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      const tasks = [
        createTask({ id: 'task-1', enabled: true }),
        createTask({ id: 'task-2', enabled: false }),
        createTask({ id: 'task-3', enabled: true }),
        createTask({ id: 'task-4', enabled: false }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listEnabled();
      expect(result).toHaveLength(2);
      expect(result.map(t => t.id)).toEqual(['task-1', 'task-3']);
    });

    it('should return empty array when all tasks are disabled', async () => {
      const tasks = [
        createTask({ id: 'task-1', enabled: false }),
        createTask({ id: 'task-2', enabled: false }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listEnabled();
      expect(result).toEqual([]);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listEnabled();
      expect(result).toEqual([]);
    });
  });

  describe('listAll', () => {
    it('should return all tasks', async () => {
      const tasks = [
        createTask({ id: 'task-1' }),
        createTask({ id: 'task-2' }),
        createTask({ id: 'task-3' }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listAll();
      expect(result).toHaveLength(3);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listAll();
      expect(result).toEqual([]);
    });

    it('should return both enabled and disabled tasks', async () => {
      const tasks = [
        createTask({ id: 'task-1', enabled: true }),
        createTask({ id: 'task-2', enabled: false }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listAll();
      expect(result).toHaveLength(2);
    });
  });

  describe('no cache behavior', () => {
    it('should always read fresh data from file system', async () => {
      // First call: returns 1 task
      mockScanAll.mockResolvedValueOnce([createTask({ id: 'task-1' })]);
      // Second call: returns 2 tasks (simulating file change)
      mockScanAll.mockResolvedValueOnce([
        createTask({ id: 'task-1' }),
        createTask({ id: 'task-2' }),
      ]);

      const result1 = await manager.listAll();
      const result2 = await manager.listAll();

      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('should propagate file system errors from scanAll', async () => {
      mockScanAll.mockRejectedValue(new Error('Permission denied'));

      await expect(manager.listAll()).rejects.toThrow('Permission denied');
    });
  });
});
