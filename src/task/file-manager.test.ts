/**
 * Tests for TaskFileManager (src/task/file-manager.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { TaskFileManager } from './file-manager.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    access: vi.fn(),
    rm: vi.fn(),
  },
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  access: vi.fn(),
  rm: vi.fn(),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
  },
}));

describe('TaskFileManager', () => {
  let manager: TaskFileManager;
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TaskFileManager('/test/workspace');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('constructor', () => {
    it('should use provided workspace directory', () => {
      const customManager = new TaskFileManager('/custom/workspace');
      expect(customManager).toBeDefined();
    });

    it('should use subdirectory when provided', () => {
      const subManager = new TaskFileManager('/test/workspace', 'regular');
      expect(subManager).toBeDefined();
    });
  });

  describe('path methods', () => {
    it('should return correct task directory path', () => {
      const result = manager.getTaskDir('task_123');
      expect(result).toBe('/test/workspace/tasks/task_123');
    });

    it('should sanitize task ID in directory name', () => {
      const result = manager.getTaskDir('task/with/slashes');
      expect(result).toBe('/test/workspace/tasks/task_with_slashes');
    });

    it('should return correct task spec path', () => {
      const result = manager.getTaskSpecPath('task_123');
      expect(result).toBe('/test/workspace/tasks/task_123/task.md');
    });

    it('should return correct iterations directory path', () => {
      const result = manager.getIterationsDir('task_123');
      expect(result).toBe('/test/workspace/tasks/task_123/iterations');
    });

    it('should return correct iteration directory path', () => {
      const result = manager.getIterationDir('task_123', 2);
      expect(result).toBe('/test/workspace/tasks/task_123/iterations/iter-2');
    });

    it('should return correct steps directory path', () => {
      const result = manager.getStepsDir('task_123', 1);
      expect(result).toBe('/test/workspace/tasks/task_123/iterations/iter-1/steps');
    });

    it('should return correct evaluation path', () => {
      const result = manager.getEvaluationPath('task_123', 1);
      expect(result).toBe('/test/workspace/tasks/task_123/iterations/iter-1/evaluation.md');
    });

    it('should return correct execution path', () => {
      const result = manager.getExecutionPath('task_123', 1);
      expect(result).toBe('/test/workspace/tasks/task_123/iterations/iter-1/execution.md');
    });

    it('should return correct final result path', () => {
      const result = manager.getFinalResultPath('task_123');
      expect(result).toBe('/test/workspace/tasks/task_123/final_result.md');
    });

    it('should use subdirectory when configured', () => {
      const subManager = new TaskFileManager('/test/workspace', 'regular');
      const result = subManager.getTaskDir('task_123');
      expect(result).toBe('/test/workspace/tasks/regular/task_123');
    });
  });

  describe('initializeTask', () => {
    it('should create task and iterations directories', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);

      await manager.initializeTask('task_123');

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123/iterations',
        { recursive: true }
      );
    });

    it('should handle creation error', async () => {
      mockFs.mkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(manager.initializeTask('task_123')).rejects.toThrow('Permission denied');
    });
  });

  describe('writeTaskSpec', () => {
    it('should write task.md file', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.writeTaskSpec('task_123', '# Task Description');

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123/task.md',
        '# Task Description',
        'utf-8'
      );
    });

    it('should handle write error', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('Disk full'));

      await expect(
        manager.writeTaskSpec('task_123', '# Task')
      ).rejects.toThrow('Disk full');
    });
  });

  describe('readTaskSpec', () => {
    it('should read task.md file', async () => {
      mockFs.readFile.mockResolvedValue('# Task Content');

      const result = await manager.readTaskSpec('task_123');

      expect(result).toBe('# Task Content');
      expect(mockFs.readFile).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123/task.md',
        'utf-8'
      );
    });

    it('should handle read error', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      await expect(manager.readTaskSpec('task_123')).rejects.toThrow('File not found');
    });
  });

  describe('createIteration', () => {
    it('should create iteration and steps directories', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);

      await manager.createIteration('task_123', 1);

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123/iterations/iter-1/steps',
        { recursive: true }
      );
    });
  });

  describe('writeEvaluation', () => {
    it('should write evaluation.md file', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.writeEvaluation('task_123', 1, '# Evaluation');

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123/iterations/iter-1/evaluation.md',
        '# Evaluation',
        'utf-8'
      );
    });
  });

  describe('readEvaluation', () => {
    it('should read evaluation.md file', async () => {
      mockFs.readFile.mockResolvedValue('# Evaluation Content');

      const result = await manager.readEvaluation('task_123', 1);

      expect(result).toBe('# Evaluation Content');
    });
  });

  describe('hasEvaluation', () => {
    it('should return true when file exists', async () => {
      mockFs.access.mockResolvedValue(undefined);

      const result = await manager.hasEvaluation('task_123', 1);

      expect(result).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('Not found'));

      const result = await manager.hasEvaluation('task_123', 1);

      expect(result).toBe(false);
    });
  });

  describe('writeExecution', () => {
    it('should write execution.md file', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.writeExecution('task_123', 1, '# Execution');

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123/iterations/iter-1/execution.md',
        '# Execution',
        'utf-8'
      );
    });
  });

  describe('readExecution', () => {
    it('should read execution.md file', async () => {
      mockFs.readFile.mockResolvedValue('# Execution Content');

      const result = await manager.readExecution('task_123', 1);

      expect(result).toBe('# Execution Content');
    });
  });

  describe('hasExecution', () => {
    it('should return true when file exists', async () => {
      mockFs.access.mockResolvedValue(undefined);

      const result = await manager.hasExecution('task_123', 1);

      expect(result).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('Not found'));

      const result = await manager.hasExecution('task_123', 1);

      expect(result).toBe(false);
    });
  });

  describe('writeStepResult', () => {
    it('should write step result file', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.writeStepResult('task_123', 1, 1, '# Step 1 Result');

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123/iterations/iter-1/steps/step-1.md',
        '# Step 1 Result',
        'utf-8'
      );
    });
  });

  describe('writeFinalSummary', () => {
    it('should write final summary file', async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      await manager.writeFinalSummary('task_123', '# Final Summary');

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123/iterations/final-summary.md',
        '# Final Summary',
        'utf-8'
      );
    });
  });

  describe('taskExists', () => {
    it('should return true when task directory exists', async () => {
      mockFs.access.mockResolvedValue(undefined);

      const result = await manager.taskExists('task_123');

      expect(result).toBe(true);
    });

    it('should return false when task directory does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('Not found'));

      const result = await manager.taskExists('task_123');

      expect(result).toBe(false);
    });
  });

  describe('listIterations', () => {
    it('should return sorted iteration numbers', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'iter-3', isDirectory: () => true } as any,
        { name: 'iter-1', isDirectory: () => true } as any,
        { name: 'iter-2', isDirectory: () => true } as any,
        { name: 'other-file.txt', isDirectory: () => false } as any,
      ] as any[]);

      const result = await manager.listIterations('task_123');

      expect(result).toEqual([1, 2, 3]);
    });

    it('should ignore non-iteration directories', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'other-dir', isDirectory: () => true } as any,
        { name: 'iter-abc', isDirectory: () => true } as any,
      ] as any[]);

      const result = await manager.listIterations('task_123');

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockFs.readdir.mockRejectedValue(new Error('Not found'));

      const result = await manager.listIterations('task_123');

      expect(result).toEqual([]);
    });
  });

  describe('getTaskStats', () => {
    it('should return task statistics', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'iter-1', isDirectory: () => true } as any,
        { name: 'iter-2', isDirectory: () => true } as any,
      ] as any[]);
      mockFs.access.mockResolvedValue(undefined);

      const result = await manager.getTaskStats('task_123');

      expect(result).toEqual({
        totalIterations: 2,
        hasFinalSummary: true,
      });
    });

    it('should detect missing final summary', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'iter-1', isDirectory: () => true } as any,
      ] as any[]);
      mockFs.access.mockRejectedValue(new Error('Not found'));

      const result = await manager.getTaskStats('task_123');

      expect(result.hasFinalSummary).toBe(false);
    });
  });

  describe('cleanupTask', () => {
    it('should remove task directory recursively', async () => {
      mockFs.rm.mockResolvedValue(undefined);

      await manager.cleanupTask('task_123');

      expect(mockFs.rm).toHaveBeenCalledWith(
        '/test/workspace/tasks/task_123',
        { recursive: true, force: true }
      );
    });

    it('should handle cleanup error', async () => {
      mockFs.rm.mockRejectedValue(new Error('Permission denied'));

      await expect(manager.cleanupTask('task_123')).rejects.toThrow('Permission denied');
    });
  });

  describe('hasFinalResult', () => {
    it('should return true when final_result.md exists', async () => {
      mockFs.access.mockResolvedValue(undefined);

      const result = await manager.hasFinalResult('task_123');

      expect(result).toBe(true);
    });

    it('should return false when final_result.md does not exist', async () => {
      mockFs.access.mockRejectedValue(new Error('Not found'));

      const result = await manager.hasFinalResult('task_123');

      expect(result).toBe(false);
    });
  });
});
