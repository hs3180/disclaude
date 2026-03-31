/**
 * Unit tests for TaskFileManager
 *
 * Tests unified task file management: directory structure,
 * task spec operations, iteration management, and cleanup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TaskFileManager } from './task-files.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  access: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  copyFile: vi.fn(),
}));

describe('TaskFileManager', () => {
  let manager: TaskFileManager;
  const workspaceDir = '/test/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TaskFileManager({ workspaceDir });
  });

  describe('constructor', () => {
    it('should set tasksBaseDir to workspace/tasks without subdirectory', () => {
      const mgr = new TaskFileManager({ workspaceDir });
      expect(mgr.getTaskDir('task-1')).toBe(path.join(workspaceDir, 'tasks', 'task-1'));
    });

    it('should set tasksBaseDir to workspace/tasks/subdir with subdirectory', () => {
      const mgr = new TaskFileManager({ workspaceDir, subdirectory: 'my-tasks' });
      expect(mgr.getTaskDir('task-1')).toBe(path.join(workspaceDir, 'tasks', 'my-tasks', 'task-1'));
    });
  });

  describe('getTaskDir', () => {
    it('should return sanitized task directory path', () => {
      expect(manager.getTaskDir('task-123')).toBe(path.join(workspaceDir, 'tasks', 'task-123'));
    });

    it('should sanitize special characters in taskId', () => {
      const result = manager.getTaskDir('task/with@special#chars');
      expect(result).toContain('task_with_special_chars');
    });
  });

  describe('getTaskSpecPath', () => {
    it('should return task.md path', () => {
      expect(manager.getTaskSpecPath('task-1')).toBe(
        path.join(workspaceDir, 'tasks', 'task-1', 'task.md')
      );
    });
  });

  describe('getIterationsDir', () => {
    it('should return iterations directory path', () => {
      expect(manager.getIterationsDir('task-1')).toBe(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations')
      );
    });
  });

  describe('getIterationDir', () => {
    it('should return iter-N directory path', () => {
      expect(manager.getIterationDir('task-1', 1)).toBe(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations', 'iter-1')
      );
    });

    it('should handle multiple iteration numbers', () => {
      expect(manager.getIterationDir('task-1', 5)).toContain('iter-5');
    });
  });

  describe('getStepsDir', () => {
    it('should return steps directory for an iteration', () => {
      expect(manager.getStepsDir('task-1', 1)).toBe(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations', 'iter-1', 'steps')
      );
    });
  });

  describe('initializeTask', () => {
    it('should create base directory and iterations directory', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await manager.initializeTask('task-1');

      // Should call mkdir twice: once for base, once for iterations
      expect(fs.mkdir).toHaveBeenCalledTimes(2);
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(workspaceDir, 'tasks'),
        { recursive: true }
      );
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations'),
        { recursive: true }
      );
    });

    it('should throw error when mkdir fails for iterations', async () => {
      vi.mocked(fs.mkdir)
        .mockResolvedValueOnce(undefined) // base dir succeeds
        .mockRejectedValueOnce(new Error('Permission denied')); // iterations dir fails

      await expect(manager.initializeTask('task-1')).rejects.toThrow('Permission denied');
    });
  });

  describe('writeTaskSpec', () => {
    it('should write content to task.md', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await manager.writeTaskSpec('task-1', '# Task content');

      expect(fs.writeFile).toHaveBeenCalledWith(
        manager.getTaskSpecPath('task-1'),
        '# Task content',
        'utf-8'
      );
    });

    it('should throw error on write failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Disk full'));

      await expect(manager.writeTaskSpec('task-1', 'content')).rejects.toThrow('Disk full');
    });
  });

  describe('readTaskSpec', () => {
    it('should read content from task.md', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# Task content');

      const content = await manager.readTaskSpec('task-1');
      expect(content).toBe('# Task content');
      expect(fs.readFile).toHaveBeenCalledWith(manager.getTaskSpecPath('task-1'), 'utf-8');
    });

    it('should throw error on read failure', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));

      await expect(manager.readTaskSpec('task-1')).rejects.toThrow('File not found');
    });
  });

  describe('createIteration', () => {
    it('should create iteration and steps directories', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await manager.createIteration('task-1', 1);

      // mkdir is called once with recursive: true which creates both dirs
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations', 'iter-1', 'steps'),
        { recursive: true }
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(fs.mkdir).mockRejectedValue(new Error('Permission denied'));

      await expect(manager.createIteration('task-1', 1)).rejects.toThrow('Permission denied');
    });
  });

  describe('writeEvaluation / readEvaluation', () => {
    it('should write evaluation content', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await manager.writeEvaluation('task-1', 1, '# Evaluation');

      expect(fs.writeFile).toHaveBeenCalledWith(
        manager.getEvaluationPath('task-1', 1),
        '# Evaluation',
        'utf-8'
      );
    });

    it('should read evaluation content', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# Evaluation');

      const content = await manager.readEvaluation('task-1', 1);
      expect(content).toBe('# Evaluation');
    });

    it('should throw error on write failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));

      await expect(manager.writeEvaluation('task-1', 1, 'content')).rejects.toThrow('Write failed');
    });

    it('should throw error on read failure', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Read failed'));

      await expect(manager.readEvaluation('task-1', 1)).rejects.toThrow('Read failed');
    });
  });

  describe('getEvaluationPath', () => {
    it('should return correct evaluation.md path', () => {
      expect(manager.getEvaluationPath('task-1', 2)).toBe(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations', 'iter-2', 'evaluation.md')
      );
    });
  });

  describe('hasEvaluation', () => {
    it('should return true when evaluation exists', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      expect(await manager.hasEvaluation('task-1', 1)).toBe(true);
    });

    it('should return false when evaluation does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Not found'));
      expect(await manager.hasEvaluation('task-1', 1)).toBe(false);
    });
  });

  describe('writeExecution / readExecution', () => {
    it('should write execution content', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await manager.writeExecution('task-1', 1, '# Execution');

      expect(fs.writeFile).toHaveBeenCalledWith(
        manager.getExecutionPath('task-1', 1),
        '# Execution',
        'utf-8'
      );
    });

    it('should read execution content', async () => {
      vi.mocked(fs.readFile).mockResolvedValue('# Execution');

      const content = await manager.readExecution('task-1', 1);
      expect(content).toBe('# Execution');
    });

    it('should throw error on write failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));

      await expect(manager.writeExecution('task-1', 1, 'content')).rejects.toThrow('Write failed');
    });

    it('should throw error on read failure', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Read failed'));

      await expect(manager.readExecution('task-1', 1)).rejects.toThrow('Read failed');
    });
  });

  describe('getExecutionPath', () => {
    it('should return correct execution.md path', () => {
      expect(manager.getExecutionPath('task-1', 2)).toBe(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations', 'iter-2', 'execution.md')
      );
    });
  });

  describe('hasExecution', () => {
    it('should return true when execution exists', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      expect(await manager.hasExecution('task-1', 1)).toBe(true);
    });

    it('should return false when execution does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Not found'));
      expect(await manager.hasExecution('task-1', 1)).toBe(false);
    });
  });

  describe('writeStepResult', () => {
    it('should write step result to correct path', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await manager.writeStepResult('task-1', 1, 2, '# Step 2 result');

      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations', 'iter-1', 'steps', 'step-2.md'),
        '# Step 2 result',
        'utf-8'
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));

      await expect(
        manager.writeStepResult('task-1', 1, 1, 'content')
      ).rejects.toThrow('Write failed');
    });
  });

  describe('writeFinalSummary', () => {
    it('should write final summary to iterations dir', async () => {
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await manager.writeFinalSummary('task-1', '# Final Summary');

      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join(workspaceDir, 'tasks', 'task-1', 'iterations', 'final-summary.md'),
        '# Final Summary',
        'utf-8'
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));

      await expect(manager.writeFinalSummary('task-1', 'content')).rejects.toThrow('Write failed');
    });
  });

  describe('taskExists', () => {
    it('should return true when task directory exists', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      expect(await manager.taskExists('task-1')).toBe(true);
    });

    it('should return false when task directory does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Not found'));
      expect(await manager.taskExists('task-1')).toBe(false);
    });
  });

  describe('listIterations', () => {
    it('should return sorted iteration numbers from valid iter-N directories', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'iter-3', isDirectory: () => true },
        { name: 'iter-1', isDirectory: () => true },
        { name: 'iter-2', isDirectory: () => true },
        { name: 'other-dir', isDirectory: () => true },
        { name: 'not-iter', isDirectory: () => true },
        { name: 'file.txt', isDirectory: () => false },
      ] as any[]);

      const iterations = await manager.listIterations('task-1');
      expect(iterations).toEqual([1, 2, 3]);
    });

    it('should return empty array when directory does not exist', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Not found'));
      const iterations = await manager.listIterations('task-1');
      expect(iterations).toEqual([]);
    });

    it('should handle empty directory', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const iterations = await manager.listIterations('task-1');
      expect(iterations).toEqual([]);
    });

    it('should filter non-iter directories', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'iter-1', isDirectory: () => true },
        { name: 'notes', isDirectory: () => true },
        { name: 'iter-x', isDirectory: () => true }, // not a number
      ] as any[]);

      const iterations = await manager.listIterations('task-1');
      expect(iterations).toEqual([1]);
    });
  });

  describe('getTaskStats', () => {
    it('should return correct stats with iterations and summary', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'iter-1', isDirectory: () => true },
        { name: 'iter-2', isDirectory: () => true },
      ] as any[]);
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const stats = await manager.getTaskStats('task-1');
      expect(stats.totalIterations).toBe(2);
      expect(stats.hasFinalSummary).toBe(true);
    });

    it('should return false for hasFinalSummary when file missing', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'iter-1', isDirectory: () => true },
      ] as any[]);
      vi.mocked(fs.access).mockRejectedValue(new Error('Not found'));

      const stats = await manager.getTaskStats('task-1');
      expect(stats.totalIterations).toBe(1);
      expect(stats.hasFinalSummary).toBe(false);
    });
  });

  describe('cleanupTask', () => {
    it('should remove task directory recursively', async () => {
      vi.mocked(fs.rm).mockResolvedValue(undefined);

      await manager.cleanupTask('task-1');

      expect(fs.rm).toHaveBeenCalledWith(
        manager.getTaskDir('task-1'),
        { recursive: true, force: true }
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(fs.rm).mockRejectedValue(new Error('Permission denied'));

      await expect(manager.cleanupTask('task-1')).rejects.toThrow('Permission denied');
    });
  });

  describe('hasFinalResult', () => {
    it('should return true when final_result.md exists', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      expect(await manager.hasFinalResult('task-1')).toBe(true);
    });

    it('should return false when final_result.md does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('Not found'));
      expect(await manager.hasFinalResult('task-1')).toBe(false);
    });
  });

  describe('getFinalResultPath', () => {
    it('should return correct final_result.md path', () => {
      expect(manager.getFinalResultPath('task-1')).toBe(
        path.join(workspaceDir, 'tasks', 'task-1', 'final_result.md')
      );
    });
  });
});
