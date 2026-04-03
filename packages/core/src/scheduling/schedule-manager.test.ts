/**
 * Unit tests for ScheduleManager
 *
 * Tests the ScheduleManager class which provides query operations for scheduled tasks:
 * - get: retrieve task by ID
 * - listByChatId: filter tasks by chat scope
 * - listEnabled: filter enabled tasks only
 * - listAll: retrieve all tasks
 * - FileScanner delegation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger before importing
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock ScheduleFileScanner - use vi.hoisted to share the mock across hoisted boundary
const { mockScanAll } = vi.hoisted(() => ({
  mockScanAll: vi.fn().mockResolvedValue([]),
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

function createMockTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    cron: '0 9 * * *',
    prompt: 'Do something',
    chatId: 'oc_chat1',
    enabled: true,
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
    // Reset mock call history but keep implementation
    mockScanAll.mockReset();
    mockScanAll.mockResolvedValue([]);
    manager = new ScheduleManager({ schedulesDir: MOCK_DIR });
  });

  describe('constructor', () => {
    it('should create a ScheduleManager with schedulesDir', () => {
      expect(manager).toBeDefined();
    });
  });

  describe('getFileScanner', () => {
    it('should return the file scanner instance', () => {
      const scanner = manager.getFileScanner();
      expect(scanner).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return task by ID when found', async () => {
      const task = createMockTask({ id: 'task-1' });
      mockScanAll.mockResolvedValue([task]);

      const result = await manager.get('task-1');
      expect(result).toEqual(task);
    });

    it('should return undefined for non-existent task', async () => {
      mockScanAll.mockResolvedValue([createMockTask({ id: 'other-task' })]);

      const result = await manager.get('non-existent');
      expect(result).toBeUndefined();
    });

    it('should return undefined when no tasks exist', async () => {
      const result = await manager.get('any-id');
      expect(result).toBeUndefined();
    });
  });

  describe('listByChatId', () => {
    it('should return tasks filtered by chatId', async () => {
      const task1 = createMockTask({ id: 'task-1', chatId: 'oc_chat1' });
      const task2 = createMockTask({ id: 'task-2', chatId: 'oc_chat2' });
      const task3 = createMockTask({ id: 'task-3', chatId: 'oc_chat1' });
      mockScanAll.mockResolvedValue([task1, task2, task3]);

      const result = await manager.listByChatId('oc_chat1');
      expect(result).toHaveLength(2);
      expect(result.map(t => t.id)).toEqual(['task-1', 'task-3']);
    });

    it('should return empty array when no tasks match chatId', async () => {
      mockScanAll.mockResolvedValue([createMockTask({ chatId: 'oc_other' })]);

      const result = await manager.listByChatId('oc_chat1');
      expect(result).toEqual([]);
    });

    it('should return empty array when no tasks exist', async () => {
      const result = await manager.listByChatId('oc_chat1');
      expect(result).toEqual([]);
    });
  });

  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      const enabled1 = createMockTask({ id: 'e1', enabled: true });
      const disabled = createMockTask({ id: 'd1', enabled: false });
      const enabled2 = createMockTask({ id: 'e2', enabled: true });
      mockScanAll.mockResolvedValue([enabled1, disabled, enabled2]);

      const result = await manager.listEnabled();
      expect(result).toHaveLength(2);
      expect(result.map(t => t.id)).toEqual(['e1', 'e2']);
    });

    it('should return empty array when all tasks are disabled', async () => {
      mockScanAll.mockResolvedValue([
        createMockTask({ enabled: false }),
        createMockTask({ enabled: false }),
      ]);

      const result = await manager.listEnabled();
      expect(result).toEqual([]);
    });

    it('should return empty array when no tasks exist', async () => {
      const result = await manager.listEnabled();
      expect(result).toEqual([]);
    });
  });

  describe('listAll', () => {
    it('should return all tasks regardless of enabled state', async () => {
      const tasks = [
        createMockTask({ id: 'a', enabled: true }),
        createMockTask({ id: 'b', enabled: false }),
        createMockTask({ id: 'c', enabled: true }),
      ];
      mockScanAll.mockResolvedValue(tasks);

      const result = await manager.listAll();
      expect(result).toHaveLength(3);
      expect(result).toEqual(tasks);
    });

    it('should return empty array when no tasks exist', async () => {
      const result = await manager.listAll();
      expect(result).toEqual([]);
    });
  });

  describe('no cache behavior', () => {
    it('should always read fresh data from file system', async () => {
      const taskV1 = createMockTask({ id: 'task-1', name: 'Version 1' });
      const taskV2 = createMockTask({ id: 'task-1', name: 'Version 2' });

      // First call returns v1
      mockScanAll.mockResolvedValueOnce([taskV1]);
      const result1 = await manager.get('task-1');
      expect(result1!.name).toBe('Version 1');

      // Second call returns v2 (simulating file change)
      mockScanAll.mockResolvedValueOnce([taskV2]);
      const result2 = await manager.get('task-1');
      expect(result2!.name).toBe('Version 2');
    });
  });
});
