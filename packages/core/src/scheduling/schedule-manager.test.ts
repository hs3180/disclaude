/**
 * Unit tests for ScheduleManager - query operations for scheduled tasks.
 *
 * Issue #1617 Phase 2 (P1): Tests for task querying, filtering, and
 * file-based persistence through ScheduleFileScanner.
 *
 * Tests cover:
 * - Constructor with schedulesDir configuration
 * - get: retrieve task by ID
 * - listByChatId: filter tasks by chat
 * - listEnabled: filter enabled tasks
 * - listAll: retrieve all tasks
 * - getFileScanner: access underlying scanner
 * - Edge cases: empty tasks, missing tasks, no cache behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockScanAll = vi.fn();

vi.mock('./schedule-watcher.js', () => ({
  ScheduleFileScanner: vi.fn().mockImplementation(({ schedulesDir }: { schedulesDir: string }) => ({
    schedulesDir,
    scanAll: mockScanAll,
  })),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ============================================================================
// Test fixtures
// ============================================================================

function createTestTask(overrides: Partial<{
  id: string;
  name: string;
  chatId: string;
  enabled: boolean;
  cron: string;
  prompt: string;
  createdAt: string;
}> = {}) {
  return {
    id: overrides.id ?? 'task-1',
    name: overrides.name ?? 'Test Task',
    chatId: overrides.chatId ?? 'oc_chat1',
    enabled: overrides.enabled ?? true,
    cron: overrides.cron ?? '0 9 * * *',
    prompt: overrides.prompt ?? 'Test prompt',
    createdAt: overrides.createdAt ?? '2026-03-27T00:00:00Z',
  };
}

// ============================================================================
// Tests
// ============================================================================

import { ScheduleManager } from './schedule-manager.js';
import { ScheduleFileScanner } from './schedule-watcher.js';

describe('ScheduleManager', () => {
  let manager: ScheduleManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ScheduleManager({ schedulesDir: '/test/schedules' });
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should create ScheduleManager with schedulesDir', () => {
      expect(manager).toBeDefined();
      expect(ScheduleFileScanner).toHaveBeenCalledWith({ schedulesDir: '/test/schedules' });
    });

    it('should create ScheduleFileScanner with custom directory', () => {
      const customManager = new ScheduleManager({ schedulesDir: '/custom/path' });
      expect(ScheduleFileScanner).toHaveBeenCalledWith({ schedulesDir: '/custom/path' });
    });
  });

  // ==========================================================================
  // get
  // ==========================================================================

  describe('get', () => {
    it('should return task by ID when found', async () => {
      const task = createTestTask({ id: 'task-1' });
      mockScanAll.mockResolvedValue([task]);

      const result = await manager.get('task-1');

      expect(result).toEqual(task);
    });

    it('should return undefined when task not found', async () => {
      mockScanAll.mockResolvedValue([createTestTask({ id: 'other-task' })]);

      const result = await manager.get('non-existent');

      expect(result).toBeUndefined();
    });

    it('should return undefined when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.get('any-id');

      expect(result).toBeUndefined();
    });
  });

  // ==========================================================================
  // listByChatId
  // ==========================================================================

  describe('listByChatId', () => {
    it('should return tasks filtered by chatId', async () => {
      const tasks = [
        createTestTask({ id: 'task-1', chatId: 'oc_chat1' }),
        createTestTask({ id: 'task-2', chatId: 'oc_chat2' }),
        createTestTask({ id: 'task-3', chatId: 'oc_chat1' }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listByChatId('oc_chat1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('task-1');
      expect(result[1].id).toBe('task-3');
    });

    it('should return empty array when no tasks match chatId', async () => {
      mockScanAll.mockResolvedValue([createTestTask({ chatId: 'oc_other' })]);

      const result = await manager.listByChatId('oc_chat1');

      expect(result).toEqual([]);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listByChatId('oc_chat1');

      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // listEnabled
  // ==========================================================================

  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      const tasks = [
        createTestTask({ id: 'task-1', enabled: true }),
        createTestTask({ id: 'task-2', enabled: false }),
        createTestTask({ id: 'task-3', enabled: true }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listEnabled();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('task-1');
      expect(result[1].id).toBe('task-3');
    });

    it('should return empty array when all tasks are disabled', async () => {
      const tasks = [
        createTestTask({ id: 'task-1', enabled: false }),
        createTestTask({ id: 'task-2', enabled: false }),
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

  // ==========================================================================
  // listAll
  // ==========================================================================

  describe('listAll', () => {
    it('should return all tasks', async () => {
      const tasks = [
        createTestTask({ id: 'task-1', enabled: true }),
        createTestTask({ id: 'task-2', enabled: false }),
        createTestTask({ id: 'task-3', enabled: true }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listAll();

      expect(result).toHaveLength(3);
      expect(result).toEqual(tasks);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listAll();

      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // getFileScanner
  // ==========================================================================

  describe('getFileScanner', () => {
    it('should return the file scanner instance', () => {
      const scanner = manager.getFileScanner();
      expect(scanner).toBeDefined();
      expect(scanner.schedulesDir).toBe('/test/schedules');
    });
  });

  // ==========================================================================
  // No cache behavior
  // ==========================================================================

  describe('no cache behavior', () => {
    it('should always read fresh data from file system', async () => {
      // First call returns one set of tasks
      mockScanAll.mockResolvedValueOnce([createTestTask({ id: 'task-1' })]);
      const result1 = await manager.listAll();
      expect(result1).toHaveLength(1);

      // Second call returns different tasks (simulates file system change)
      mockScanAll.mockResolvedValueOnce([
        createTestTask({ id: 'task-1' }),
        createTestTask({ id: 'task-2' }),
      ]);
      const result2 = await manager.listAll();
      expect(result2).toHaveLength(2);
    });

    it('should call scanAll for each query (no caching)', async () => {
      mockScanAll.mockResolvedValue([]);

      await manager.listAll();
      await manager.listAll();
      await manager.listEnabled();

      expect(mockScanAll).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // Error handling
  // ==========================================================================

  describe('error handling', () => {
    it('should propagate file scanner errors', async () => {
      mockScanAll.mockRejectedValue(new Error('Permission denied'));

      await expect(manager.listAll()).rejects.toThrow('Permission denied');
    });
  });
});
