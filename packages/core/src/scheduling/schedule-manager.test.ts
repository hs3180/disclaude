/**
 * Tests for ScheduleManager (packages/core/src/scheduling/schedule-manager.ts)
 *
 * Tests the query operations for scheduled tasks including:
 * - Loading tasks from file system
 * - Filtering by chatId
 * - Listing enabled tasks
 * - Getting task by ID
 *
 * Issue #1617 Phase 2: Scheduling tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock Definitions
// ============================================================================

const { mockScanAll } = vi.hoisted(() => ({
  mockScanAll: vi.fn().mockResolvedValue([]),
}));

vi.mock('./schedule-watcher.js', () => ({
  ScheduleFileScanner: vi.fn().mockImplementation(() => ({
    scanAll: mockScanAll,
  })),
}));

// Import after mocks
import { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-test-task',
    name: 'Test Task',
    cron: '0 9 * * *',
    prompt: 'Execute test task',
    chatId: 'oc_test123',
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
    mockScanAll.mockResolvedValue([]);
    manager = new ScheduleManager({ schedulesDir: '/tmp/schedules' });
  });

  describe('constructor', () => {
    it('should create a ScheduleManager', () => {
      expect(manager).toBeDefined();
    });

    it('should expose fileScanner', () => {
      const scanner = manager.getFileScanner();
      expect(scanner).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return task by ID', async () => {
      const task = createTask({ id: 'task-1' });
      mockScanAll.mockResolvedValue([task]);

      const result = await manager.get('task-1');

      expect(result).toBeDefined();
      expect(result!.id).toBe('task-1');
    });

    it('should return undefined for non-existent ID', async () => {
      const task = createTask({ id: 'task-1' });
      mockScanAll.mockResolvedValue([task]);

      const result = await manager.get('non-existent');

      expect(result).toBeUndefined();
    });

    it('should return undefined when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.get('task-1');

      expect(result).toBeUndefined();
    });
  });

  describe('listByChatId', () => {
    it('should filter tasks by chatId', async () => {
      const tasks = [
        createTask({ id: 'task-1', chatId: 'oc_A' }),
        createTask({ id: 'task-2', chatId: 'oc_B' }),
        createTask({ id: 'task-3', chatId: 'oc_A' }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listByChatId('oc_A');

      expect(result).toHaveLength(2);
      expect(result.map(t => t.id)).toEqual(['task-1', 'task-3']);
    });

    it('should return empty array when no tasks match', async () => {
      mockScanAll.mockResolvedValue([
        createTask({ chatId: 'oc_A' }),
        createTask({ chatId: 'oc_B' }),
      ]);

      const result = await manager.listByChatId('oc_C');

      expect(result).toEqual([]);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listByChatId('oc_A');

      expect(result).toEqual([]);
    });
  });

  describe('listEnabled', () => {
    it('should only return enabled tasks', async () => {
      const tasks = [
        createTask({ id: 'task-1', enabled: true }),
        createTask({ id: 'task-2', enabled: false }),
        createTask({ id: 'task-3', enabled: true }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listEnabled();

      expect(result).toHaveLength(2);
      expect(result.map(t => t.id)).toEqual(['task-1', 'task-3']);
    });

    it('should return empty array when all tasks are disabled', async () => {
      mockScanAll.mockResolvedValue([
        createTask({ id: 'task-1', enabled: false }),
        createTask({ id: 'task-2', enabled: false }),
      ]);

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
        createTask({ id: 'task-2', enabled: false }),
        createTask({ id: 'task-3' }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listAll();

      expect(result).toHaveLength(3);
    });

    it('should return empty array when no tasks', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listAll();

      expect(result).toEqual([]);
    });
  });

  describe('no-cache behavior', () => {
    it('should reload from file system on every call', async () => {
      const task = createTask({ id: 'task-1' });
      mockScanAll.mockResolvedValue([task]);

      await manager.get('task-1');
      await manager.get('task-1');
      await manager.listAll();

      // scanAll should be called 3 times (no caching)
      expect(mockScanAll).toHaveBeenCalledTimes(3);
    });
  });
});
