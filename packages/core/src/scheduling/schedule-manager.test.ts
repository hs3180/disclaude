/**
 * Tests for ScheduleManager (packages/core/src/scheduling/schedule-manager.ts)
 *
 * Tests the ScheduleManager class which provides query operations for
 * scheduled tasks. All operations read directly from the file system via
 * the ScheduleFileScanner (no caching).
 *
 * Uses vi.mock for ESM module mocking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted to define mock functions referenced in vi.mock factory
const { mockScanAll, mockLogger } = vi.hoisted(() => ({
  mockScanAll: vi.fn().mockResolvedValue([]),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue(mockLogger),
}));

vi.mock('./schedule-watcher.js', () => ({
  ScheduleFileScanner: vi.fn().mockImplementation(() => ({
    scanAll: mockScanAll,
  })),
}));

import { ScheduleManager } from './schedule-manager.js';
import type { ScheduledTask } from './scheduled-task.js';

// ============================================================================
// Helpers
// ============================================================================

const MOCK_DIR = '/tmp/test-schedules';

/** Create a mock ScheduledTask for testing. */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-daily-report',
    name: 'Daily Report',
    cron: '0 9 * * *',
    prompt: 'Execute the daily report task.',
    chatId: 'oc_test123',
    enabled: true,
    blocking: true,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// ScheduleManager Tests
// ============================================================================

describe('ScheduleManager', () => {
  let manager: ScheduleManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ScheduleManager({ schedulesDir: MOCK_DIR });
  });

  describe('constructor', () => {
    it('should create a ScheduleManager with the given schedulesDir', () => {
      expect(manager).toBeInstanceOf(ScheduleManager);
    });

    it('should log initialization message', () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        { schedulesDir: MOCK_DIR },
        'ScheduleManager initialized (no cache)'
      );
    });
  });

  describe('getFileScanner', () => {
    it('should return the file scanner instance', () => {
      const scanner = manager.getFileScanner();
      expect(scanner).toBeDefined();
      expect(scanner).toHaveProperty('scanAll');
    });
  });

  describe('get', () => {
    it('should return a task by ID when it exists', async () => {
      const task = makeTask();
      mockScanAll.mockResolvedValue([task]);

      const result = await manager.get('schedule-daily-report');
      expect(result).toBeDefined();
      expect(result!.id).toBe('schedule-daily-report');
      expect(result!.name).toBe('Daily Report');
    });

    it('should return undefined when task ID does not exist', async () => {
      const task = makeTask({ id: 'schedule-other-task' });
      mockScanAll.mockResolvedValue([task]);

      const result = await manager.get('schedule-daily-report');
      expect(result).toBeUndefined();
    });

    it('should return undefined when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.get('schedule-daily-report');
      expect(result).toBeUndefined();
    });

    it('should call scanAll to load tasks', async () => {
      mockScanAll.mockResolvedValue([]);

      await manager.get('some-id');
      expect(mockScanAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('listByChatId', () => {
    it('should return tasks matching the given chatId', async () => {
      const task1 = makeTask({ id: 'schedule-task-1', chatId: 'oc_chat1' });
      const task2 = makeTask({ id: 'schedule-task-2', chatId: 'oc_chat2' });
      const task3 = makeTask({ id: 'schedule-task-3', chatId: 'oc_chat1' });
      mockScanAll.mockResolvedValue([task1, task2, task3]);

      const result = await manager.listByChatId('oc_chat1');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('schedule-task-1');
      expect(result[1].id).toBe('schedule-task-3');
    });

    it('should return empty array when no tasks match the chatId', async () => {
      const task = makeTask({ chatId: 'oc_other' });
      mockScanAll.mockResolvedValue([task]);

      const result = await manager.listByChatId('oc_chat1');
      expect(result).toHaveLength(0);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listByChatId('oc_chat1');
      expect(result).toHaveLength(0);
    });

    it('should filter correctly when all tasks belong to the same chat', async () => {
      const task1 = makeTask({ id: 'schedule-task-1', chatId: 'oc_chat1' });
      const task2 = makeTask({ id: 'schedule-task-2', chatId: 'oc_chat1' });
      mockScanAll.mockResolvedValue([task1, task2]);

      const result = await manager.listByChatId('oc_chat1');
      expect(result).toHaveLength(2);
    });
  });

  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      const task1 = makeTask({ id: 'schedule-enabled-1', enabled: true });
      const task2 = makeTask({ id: 'schedule-disabled-1', enabled: false });
      const task3 = makeTask({ id: 'schedule-enabled-2', enabled: true });
      mockScanAll.mockResolvedValue([task1, task2, task3]);

      const result = await manager.listEnabled();
      expect(result).toHaveLength(2);
      expect(result.every(t => t.enabled)).toBe(true);
      expect(result.map(t => t.id)).toEqual(['schedule-enabled-1', 'schedule-enabled-2']);
    });

    it('should return empty array when all tasks are disabled', async () => {
      const task1 = makeTask({ id: 'schedule-disabled-1', enabled: false });
      const task2 = makeTask({ id: 'schedule-disabled-2', enabled: false });
      mockScanAll.mockResolvedValue([task1, task2]);

      const result = await manager.listEnabled();
      expect(result).toHaveLength(0);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listEnabled();
      expect(result).toHaveLength(0);
    });

    it('should return all tasks when all are enabled', async () => {
      const task1 = makeTask({ id: 'schedule-task-1', enabled: true });
      const task2 = makeTask({ id: 'schedule-task-2', enabled: true });
      mockScanAll.mockResolvedValue([task1, task2]);

      const result = await manager.listEnabled();
      expect(result).toHaveLength(2);
    });
  });

  describe('listAll', () => {
    it('should return all tasks', async () => {
      const task1 = makeTask({ id: 'schedule-task-1' });
      const task2 = makeTask({ id: 'schedule-task-2' });
      const task3 = makeTask({ id: 'schedule-task-3', enabled: false });
      mockScanAll.mockResolvedValue([task1, task2, task3]);

      const result = await manager.listAll();
      expect(result).toHaveLength(3);
    });

    it('should return empty array when no tasks exist', async () => {
      mockScanAll.mockResolvedValue([]);

      const result = await manager.listAll();
      expect(result).toHaveLength(0);
    });

    it('should return tasks with both enabled and disabled status', async () => {
      const task1 = makeTask({ id: 'schedule-task-1', enabled: true });
      const task2 = makeTask({ id: 'schedule-task-2', enabled: false });
      mockScanAll.mockResolvedValue([task1, task2]);

      const result = await manager.listAll();
      expect(result).toHaveLength(2);
      expect(result[0].enabled).toBe(true);
      expect(result[1].enabled).toBe(false);
    });
  });

  describe('loadAll (private, tested through public methods)', () => {
    it('should always read fresh data on each call (no caching)', async () => {
      const task1 = makeTask({ id: 'schedule-task-1' });
      const task2 = makeTask({ id: 'schedule-task-2' });
      mockScanAll
        .mockResolvedValueOnce([task1])
        .mockResolvedValueOnce([task1, task2]);

      const result1 = await manager.listAll();
      const result2 = await manager.listAll();

      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(2);
      expect(mockScanAll).toHaveBeenCalledTimes(2);
    });

    it('should propagate scanAll errors', async () => {
      mockScanAll.mockRejectedValue(new Error('Scan failed'));

      await expect(manager.listAll()).rejects.toThrow('Scan failed');
    });
  });
});
