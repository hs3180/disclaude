/**
 * Tests for LongTaskTracker (src/long-task/tracker.ts)
 *
 * Tests the following functionality:
 * - Creating and managing long task directories
 * - Saving long task plans
 * - Saving subtask results
 * - Saving long task summaries
 * - Saving dialogue task plans
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LongTaskTracker } from './tracker.js';

// Mock fs modules
vi.mock('fs/promises');

const mockedFs = vi.mocked(fs);

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/mock/workspace',
  },
}));

describe('LongTaskTracker', () => {
  let tracker: LongTaskTracker;

  beforeEach(() => {
    tracker = new LongTaskTracker('/mock/workspace');
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should use default workspace directory when not provided', () => {
      const tracker = new LongTaskTracker();
      expect(tracker).toBeInstanceOf(LongTaskTracker);
    });

    it('should use provided base directory', () => {
      const tracker = new LongTaskTracker('/custom/workspace');
      expect(tracker).toBeInstanceOf(LongTaskTracker);
    });
  });

  describe('getLongTaskDirPath', () => {
    it('should return correct long task directory path', () => {
      const dirPath = tracker.getLongTaskDirPath('long_task_123');

      expect(dirPath).toContain('long-tasks');
      expect(dirPath).toContain('long_task_123');
    });

    it('should sanitize task ID', () => {
      const dirPath = tracker.getLongTaskDirPath('long/task.123');

      expect(dirPath).toContain('long_task_123');
    });
  });

  describe('ensureLongTaskDir', () => {
    it('should create long task directory', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);

      const dirPath = await tracker.ensureLongTaskDir('task_123');

      expect(dirPath).toContain('task_123');
      expect(mockedFs.mkdir).toHaveBeenCalled();
    });
  });

  describe('saveLongTaskPlan', () => {
    it('should save long task plan', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);
      mockedFs.writeFile.mockResolvedValueOnce(undefined);

      const plan = {
        taskId: 'task_123',
        originalRequest: 'Test request',
        title: 'Test Plan',
        description: 'Test description',
        subtasks: [],
        totalSteps: 5,
        createdAt: '2024-01-01T00:00:00Z',
      };

      await tracker.saveLongTaskPlan('task_123', plan);

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('TASK_PLAN.md'),
        expect.stringContaining('Test Plan'),
        'utf-8'
      );
    });

    it('should handle write errors', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);
      mockedFs.writeFile.mockRejectedValueOnce(new Error('Write failed'));

      const plan = {
        taskId: 'task_123',
        originalRequest: 'Test request',
        title: 'Test Plan',
        description: 'Test description',
        subtasks: [],
        totalSteps: 5,
        createdAt: '2024-01-01T00:00:00Z',
      };

      await expect(tracker.saveLongTaskPlan('task_123', plan)).rejects.toThrow();
    });
  });

  describe('saveSubtaskResult', () => {
    it('should save subtask result as JSON', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);
      mockedFs.writeFile.mockResolvedValueOnce(undefined);

      const result = {
        sequence: 1,
        success: true,
        summary: 'Test summary',
        files: ['file1.ts', 'file2.ts'],
        summaryFile: 'summary.md',
        completedAt: '2024-01-01T00:00:00Z',
      };

      await tracker.saveSubtaskResult('task_123', result);

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('subtask-1-result.json'),
        expect.stringContaining('"sequence": 1'),
        'utf-8'
      );
    });
  });

  describe('saveLongTaskSummary', () => {
    it('should save long task summary', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);
      mockedFs.writeFile.mockResolvedValueOnce(undefined);

      const summary = '# Task Summary\n\nCompleted successfully.';

      await tracker.saveLongTaskSummary('task_123', summary);

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('FINAL_SUMMARY.md'),
        summary,
        'utf-8'
      );
    });
  });

  describe('saveDialogueTaskPlan', () => {
    it('should save dialogue task plan', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);
      mockedFs.writeFile.mockResolvedValueOnce(undefined);

      const plan = {
        taskId: 'task_123',
        title: 'Test Dialogue Plan',
        description: 'Test description',
        milestones: ['Milestone 1', 'Milestone 2'],
        originalRequest: 'Test request',
        createdAt: '2024-01-01T00:00:00Z',
      };

      await tracker.saveDialogueTaskPlan(plan);

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('TASK_PLAN.md'),
        expect.stringContaining('Test Dialogue Plan'),
        'utf-8'
      );
    });

    it('should handle save errors without throwing', async () => {
      mockedFs.mkdir.mockResolvedValueOnce(undefined);
      mockedFs.writeFile.mockRejectedValueOnce(new Error('Write failed'));

      const plan = {
        taskId: 'task_123',
        title: 'Test',
        description: 'Test',
        milestones: [],
        originalRequest: 'Test',
        createdAt: '2024-01-01T00:00:00Z',
      };

      await expect(tracker.saveDialogueTaskPlan(plan)).resolves.not.toThrow();
    });
  });

  describe('file path sanitization', () => {
    it('should replace special characters but keep valid ones in directory path', () => {
      const dirPath1 = tracker.getLongTaskDirPath('long/task.123');
      expect(dirPath1).toContain('long_task_123');
    });

    it('should preserve valid characters in directory path', () => {
      const dirPath = tracker.getLongTaskDirPath('long-task-123_Test');
      expect(dirPath).toContain('long-task-123_Test');
    });
  });
});
