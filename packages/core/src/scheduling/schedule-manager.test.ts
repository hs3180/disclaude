/**
 * Tests for ScheduleManager - query operations for scheduled tasks.
 *
 * Issue #1617 Phase 2/3: Tests for ScheduleManager covering
 * task listing, filtering by chatId, and enabled task retrieval.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScheduleManager } from './schedule-manager.js';
import type { ScheduleFileTask } from './schedule-watcher.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

function createMockFileTask(overrides?: Partial<ScheduleFileTask>): ScheduleFileTask {
  return {
    id: 'schedule-daily-report',
    name: 'Daily Report',
    cron: '0 9 * * *',
    prompt: 'Generate daily report',
    chatId: 'oc_chat_1',
    enabled: true,
    blocking: true,
    createdAt: '2025-01-01T00:00:00Z',
    sourceFile: '/schedules/daily-report.md',
    fileMtime: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ScheduleManager', () => {
  let manager: ScheduleManager;
  let mockScanAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createManager(tasks: ScheduleFileTask[]): ScheduleManager {
    mockScanAll = vi.fn().mockResolvedValue(tasks);
    vi.doMock('./schedule-watcher.js', () => ({
      ScheduleFileScanner: class {
        scanAll = mockScanAll;
      },
    }));

    // Create manager using a temp directory
    const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
    manager = new ScheduleManager({ schedulesDir: tmpDir });
    return manager;
  }

  describe('constructor', () => {
    it('should create a ScheduleManager with schedulesDir', () => {
      const tmpDir = '/tmp/test-schedules';
      const m = new ScheduleManager({ schedulesDir: tmpDir });
      expect(m).toBeDefined();
      expect(m.getFileScanner()).toBeDefined();
    });
  });

  describe('listAll', () => {
    it('should return all tasks from file system', async () => {
      const tasks = [
        createMockFileTask({ id: 'task-1', chatId: 'oc_1' }),
        createMockFileTask({ id: 'task-2', chatId: 'oc_2' }),
      ];

      const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
      const m = new ScheduleManager({ schedulesDir: tmpDir });

      // Mock the fileScanner's scanAll
      vi.spyOn(m.getFileScanner(), 'scanAll').mockResolvedValue(tasks);

      const result = await m.listAll();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('task-1');
      expect(result[1].id).toBe('task-2');
    });

    it('should return empty array when no tasks exist', async () => {
      const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
      const m = new ScheduleManager({ schedulesDir: tmpDir });
      vi.spyOn(m.getFileScanner(), 'scanAll').mockResolvedValue([]);

      const result = await m.listAll();
      expect(result).toEqual([]);
    });
  });

  describe('listEnabled', () => {
    it('should return only enabled tasks', async () => {
      const tasks = [
        createMockFileTask({ id: 'task-1', enabled: true }),
        createMockFileTask({ id: 'task-2', enabled: false }),
        createMockFileTask({ id: 'task-3', enabled: true }),
      ];

      const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
      const m = new ScheduleManager({ schedulesDir: tmpDir });
      vi.spyOn(m.getFileScanner(), 'scanAll').mockResolvedValue(tasks);

      const result = await m.listEnabled();
      expect(result).toHaveLength(2);
      expect(result.every(t => t.enabled)).toBe(true);
    });
  });

  describe('listByChatId', () => {
    it('should return only tasks matching the chatId', async () => {
      const tasks = [
        createMockFileTask({ id: 'task-1', chatId: 'oc_1' }),
        createMockFileTask({ id: 'task-2', chatId: 'oc_2' }),
        createMockFileTask({ id: 'task-3', chatId: 'oc_1' }),
      ];

      const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
      const m = new ScheduleManager({ schedulesDir: tmpDir });
      vi.spyOn(m.getFileScanner(), 'scanAll').mockResolvedValue(tasks);

      const result = await m.listByChatId('oc_1');
      expect(result).toHaveLength(2);
      expect(result.every(t => t.chatId === 'oc_1')).toBe(true);
    });

    it('should return empty array when no tasks match chatId', async () => {
      const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
      const m = new ScheduleManager({ schedulesDir: tmpDir });
      vi.spyOn(m.getFileScanner(), 'scanAll').mockResolvedValue([
        createMockFileTask({ chatId: 'oc_1' }),
      ]);

      const result = await m.listByChatId('oc_other');
      expect(result).toEqual([]);
    });
  });

  describe('get', () => {
    it('should return the task with matching ID', async () => {
      const tasks = [
        createMockFileTask({ id: 'task-1' }),
        createMockFileTask({ id: 'task-2' }),
      ];

      const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
      const m = new ScheduleManager({ schedulesDir: tmpDir });
      vi.spyOn(m.getFileScanner(), 'scanAll').mockResolvedValue(tasks);

      const result = await m.get('task-1');
      expect(result).toBeDefined();
      expect(result!.id).toBe('task-1');
    });

    it('should return undefined when task not found', async () => {
      const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
      const m = new ScheduleManager({ schedulesDir: tmpDir });
      vi.spyOn(m.getFileScanner(), 'scanAll').mockResolvedValue([]);

      const result = await m.get('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('getFileScanner', () => {
    it('should return the file scanner instance', () => {
      const tmpDir = `/tmp/schedule-manager-test-${Date.now()}`;
      const m = new ScheduleManager({ schedulesDir: tmpDir });
      expect(m.getFileScanner()).toBeDefined();
    });
  });
});
