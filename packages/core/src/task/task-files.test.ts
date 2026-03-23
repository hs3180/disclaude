/**
 * Tests for TaskFileManager (packages/core/src/task/task-files.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, mockMkdir, mockWriteFile, mockReadFile, mockAccess, mockRm, mockReaddir } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn().mockResolvedValue('file content'),
  mockAccess: vi.fn().mockResolvedValue(undefined),
  mockRm: vi.fn().mockResolvedValue(undefined),
  mockReaddir: vi.fn().mockResolvedValue([]),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue(mockLogger),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    access: mockAccess,
    rm: mockRm,
    readdir: mockReaddir,
  },
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  access: mockAccess,
  rm: mockRm,
  readdir: mockReaddir,
}));

import { TaskFileManager } from './task-files.js';

describe('TaskFileManager', () => {
  let manager: TaskFileManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('file content');
    mockAccess.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    manager = new TaskFileManager({ workspaceDir: '/test-workspace' });
  });

  describe('constructor', () => {
    it('should use workspace dir for tasks base dir', () => {
      expect(manager.getTaskDir('task-1')).toContain('/test-workspace/tasks');
    });

    it('should include subdirectory when configured', () => {
      const mgr = new TaskFileManager({ workspaceDir: '/test-workspace', subdirectory: 'custom' });
      expect(mgr.getTaskDir('task-1')).toContain('/test-workspace/tasks/custom');
    });
  });

  describe('getTaskDir', () => {
    it('should return correct task directory path', () => {
      const dir = manager.getTaskDir('task-1');
      expect(dir).toContain('task-1');
    });

    it('should sanitize taskId for directory name', () => {
      const dir = manager.getTaskDir('task/with@special:chars');
      const dirName = dir.split('/').pop()!;
      expect(dirName).not.toContain('/');
      expect(dirName).not.toContain('@');
      expect(dirName).not.toContain(':');
      expect(dirName).toContain('_');
    });
  });

  describe('getTaskSpecPath', () => {
    it('should return path ending with task.md', () => {
      const path = manager.getTaskSpecPath('task-1');
      expect(path).toContain('task.md');
    });
  });

  describe('getIterationsDir', () => {
    it('should return iterations directory path', () => {
      const dir = manager.getIterationsDir('task-1');
      expect(dir).toContain('iterations');
    });
  });

  describe('getIterationDir', () => {
    it('should return iter-N directory path', () => {
      const dir = manager.getIterationDir('task-1', 1);
      expect(dir).toContain('iter-1');
    });
  });

  describe('getStepsDir', () => {
    it('should return steps directory path', () => {
      const dir = manager.getStepsDir('task-1', 1);
      expect(dir).toContain('steps');
    });
  });

  describe('initializeTask', () => {
    it('should create base dir and iterations dir', async () => {
      await manager.initializeTask('task-1');
      expect(mockMkdir).toHaveBeenCalledTimes(2);
      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('tasks'), { recursive: true });
    });

    it('should throw if mkdir fails', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('mkdir failed'));
      await expect(manager.initializeTask('task-1')).rejects.toThrow('mkdir failed');
    });

    it('should log error when mkdir fails', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('mkdir failed'));
      try { await manager.initializeTask('task-1'); } catch {}
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('writeTaskSpec', () => {
    it('should write task.md with given content', async () => {
      await manager.writeTaskSpec('task-1', '# Task Spec');
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('task.md'),
        '# Task Spec',
        'utf-8'
      );
    });

    it('should throw on write failure', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('write failed'));
      await expect(manager.writeTaskSpec('task-1', 'content')).rejects.toThrow('write failed');
    });
  });

  describe('readTaskSpec', () => {
    it('should return task.md content', async () => {
      mockReadFile.mockResolvedValueOnce('# Task Spec');
      const content = await manager.readTaskSpec('task-1');
      expect(content).toBe('# Task Spec');
    });

    it('should throw on read failure', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('read failed'));
      await expect(manager.readTaskSpec('task-1')).rejects.toThrow('read failed');
    });
  });

  describe('createIteration', () => {
    it('should create iteration and steps directories', async () => {
      await manager.createIteration('task-1', 1);
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('iter-1'),
        { recursive: true }
      );
    });

    it('should throw on mkdir failure', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('mkdir failed'));
      await expect(manager.createIteration('task-1', 1)).rejects.toThrow('mkdir failed');
    });
  });

  describe('writeEvaluation', () => {
    it('should write evaluation.md', async () => {
      await manager.writeEvaluation('task-1', 1, '# Evaluation');
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('evaluation.md'),
        '# Evaluation',
        'utf-8'
      );
    });

    it('should throw on write failure', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('write failed'));
      await expect(manager.writeEvaluation('task-1', 1, 'content')).rejects.toThrow('write failed');
    });
  });

  describe('readEvaluation', () => {
    it('should return evaluation content', async () => {
      mockReadFile.mockResolvedValueOnce('# Evaluation Result');
      const content = await manager.readEvaluation('task-1', 1);
      expect(content).toBe('# Evaluation Result');
    });

    it('should throw on read failure', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('read failed'));
      await expect(manager.readEvaluation('task-1', 1)).rejects.toThrow('read failed');
    });
  });

  describe('hasEvaluation', () => {
    it('should return true when evaluation exists', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      expect(await manager.hasEvaluation('task-1', 1)).toBe(true);
    });

    it('should return false when evaluation does not exist', async () => {
      mockAccess.mockRejectedValueOnce(new Error('not found'));
      expect(await manager.hasEvaluation('task-1', 1)).toBe(false);
    });
  });

  describe('writeExecution', () => {
    it('should write execution.md', async () => {
      await manager.writeExecution('task-1', 1, '# Execution');
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('execution.md'),
        '# Execution',
        'utf-8'
      );
    });

    it('should throw on write failure', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('write failed'));
      await expect(manager.writeExecution('task-1', 1, 'content')).rejects.toThrow('write failed');
    });
  });

  describe('readExecution', () => {
    it('should return execution content', async () => {
      mockReadFile.mockResolvedValueOnce('# Execution Result');
      const content = await manager.readExecution('task-1', 1);
      expect(content).toBe('# Execution Result');
    });

    it('should throw on read failure', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('read failed'));
      await expect(manager.readExecution('task-1', 1)).rejects.toThrow('read failed');
    });
  });

  describe('hasExecution', () => {
    it('should return true when execution exists', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      expect(await manager.hasExecution('task-1', 1)).toBe(true);
    });

    it('should return false when execution does not exist', async () => {
      mockAccess.mockRejectedValueOnce(new Error('not found'));
      expect(await manager.hasExecution('task-1', 1)).toBe(false);
    });
  });

  describe('writeStepResult', () => {
    it('should write step-N.md', async () => {
      await manager.writeStepResult('task-1', 1, 1, 'Step 1 result');
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('step-1.md'),
        'Step 1 result',
        'utf-8'
      );
    });

    it('should throw on write failure', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('write failed'));
      await expect(manager.writeStepResult('task-1', 1, 1, 'content')).rejects.toThrow('write failed');
    });
  });

  describe('writeFinalSummary', () => {
    it('should write final-summary.md in iterations dir', async () => {
      await manager.writeFinalSummary('task-1', '# Final Summary');
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('final-summary.md'),
        '# Final Summary',
        'utf-8'
      );
    });

    it('should throw on write failure', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('write failed'));
      await expect(manager.writeFinalSummary('task-1', 'content')).rejects.toThrow('write failed');
    });
  });

  describe('taskExists', () => {
    it('should return true when task dir exists', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      expect(await manager.taskExists('task-1')).toBe(true);
    });

    it('should return false when task dir does not exist', async () => {
      mockAccess.mockRejectedValueOnce(new Error('not found'));
      expect(await manager.taskExists('task-1')).toBe(false);
    });
  });

  describe('listIterations', () => {
    it('should return sorted iteration numbers', async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: 'iter-3', isDirectory: () => true },
        { name: 'iter-1', isDirectory: () => true },
        { name: 'iter-2', isDirectory: () => true },
        { name: 'other', isDirectory: () => true },
      ] as any);
      const result = await manager.listIterations('task-1');
      expect(result).toEqual([1, 2, 3]);
    });

    it('should skip non-iter directories', async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: 'other-dir', isDirectory: () => true },
        { name: 'iter-1', isDirectory: () => true },
      ] as any);
      const result = await manager.listIterations('task-1');
      expect(result).toEqual([1]);
    });

    it('should skip non-directories', async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: 'iter-1', isDirectory: () => false },
      ] as any);
      const result = await manager.listIterations('task-1');
      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockReaddir.mockRejectedValueOnce(new Error('not found'));
      const result = await manager.listIterations('task-1');
      expect(result).toEqual([]);
    });

    it('should log error on readdir failure', async () => {
      mockReaddir.mockRejectedValueOnce(new Error('not found'));
      await manager.listIterations('task-1');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('getTaskStats', () => {
    it('should return correct stats', async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: 'iter-1', isDirectory: () => true },
        { name: 'iter-2', isDirectory: () => true },
      ] as any);
      mockAccess.mockResolvedValueOnce(undefined); // final-summary exists

      const stats = await manager.getTaskStats('task-1');
      expect(stats.totalIterations).toBe(2);
      expect(stats.hasFinalSummary).toBe(true);
    });

    it('should detect missing final summary', async () => {
      mockReaddir.mockResolvedValueOnce([
        { name: 'iter-1', isDirectory: () => true },
      ] as any);
      mockAccess.mockRejectedValueOnce(new Error('not found'));

      const stats = await manager.getTaskStats('task-1');
      expect(stats.totalIterations).toBe(1);
      expect(stats.hasFinalSummary).toBe(false);
    });
  });

  describe('cleanupTask', () => {
    it('should remove task directory', async () => {
      await manager.cleanupTask('task-1');
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining('task-1'),
        { recursive: true, force: true }
      );
    });

    it('should throw on rm failure', async () => {
      mockRm.mockRejectedValueOnce(new Error('rm failed'));
      await expect(manager.cleanupTask('task-1')).rejects.toThrow('rm failed');
    });

    it('should log error on rm failure', async () => {
      mockRm.mockRejectedValueOnce(new Error('rm failed'));
      try { await manager.cleanupTask('task-1'); } catch {}
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('hasFinalResult', () => {
    it('should return true when final_result.md exists', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      expect(await manager.hasFinalResult('task-1')).toBe(true);
    });

    it('should return false when final_result.md does not exist', async () => {
      mockAccess.mockRejectedValueOnce(new Error('not found'));
      expect(await manager.hasFinalResult('task-1')).toBe(false);
    });
  });

  describe('getFinalResultPath', () => {
    it('should return path ending with final_result.md', () => {
      const path = manager.getFinalResultPath('task-1');
      expect(path).toContain('final_result.md');
    });
  });
});
