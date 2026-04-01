/**
 * Tests for TaskFileManager - unified task file management.
 *
 * Issue #1617 Phase 2/3: Tests for TaskFileManager covering
 * path resolution, file operations, iteration management, and task stats.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskFileManager } from './task-files.js';

// Use real temp directories for file system tests
describe('TaskFileManager', () => {
  let tmpDir: string;
  let manager: TaskFileManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-files-test-'));
    manager = new TaskFileManager({ workspaceDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create manager with default tasks subdirectory', () => {
      expect(manager.getTaskDir('test-id')).toContain(path.join(tmpDir, 'tasks'));
    });

    it('should create manager with custom subdirectory', () => {
      const m = new TaskFileManager({ workspaceDir: tmpDir, subdirectory: 'custom' });
      expect(m.getTaskDir('test-id')).toContain(path.join(tmpDir, 'tasks', 'custom'));
    });
  });

  describe('path getters', () => {
    it('should sanitize taskId for directory names', () => {
      const result = manager.getTaskDir('msg@123.abc');
      expect(result).toContain('msg_123_abc');
    });

    it('should return correct task spec path', () => {
      const result = manager.getTaskSpecPath('test-task');
      expect(result).toContain(path.join('test-task', 'task.md'));
    });

    it('should return correct iterations directory path', () => {
      const result = manager.getIterationsDir('test-task');
      expect(result).toContain(path.join('test-task', 'iterations'));
    });

    it('should return correct iteration directory path', () => {
      const result = manager.getIterationDir('test-task', 2);
      expect(result).toContain(path.join('test-task', 'iterations', 'iter-2'));
    });

    it('should return correct steps directory path', () => {
      const result = manager.getStepsDir('test-task', 1);
      expect(result).toContain(path.join('test-task', 'iterations', 'iter-1', 'steps'));
    });

    it('should return correct evaluation path', () => {
      const result = manager.getEvaluationPath('test-task', 3);
      expect(result).toContain(path.join('test-task', 'iterations', 'iter-3', 'evaluation.md'));
    });

    it('should return correct execution path', () => {
      const result = manager.getExecutionPath('test-task', 1);
      expect(result).toContain(path.join('test-task', 'iterations', 'iter-1', 'execution.md'));
    });

    it('should return correct final result path', () => {
      const result = manager.getFinalResultPath('test-task');
      expect(result).toContain(path.join('test-task', 'final_result.md'));
    });
  });

  describe('initializeTask', () => {
    it('should create task and iterations directories', async () => {
      await manager.initializeTask('test-task');

      const taskDir = manager.getTaskDir('test-task');
      const iterationsDir = manager.getIterationsDir('test-task');

      const taskStat = await fs.stat(taskDir);
      expect(taskStat.isDirectory()).toBe(true);

      const iterStat = await fs.stat(iterationsDir);
      expect(iterStat.isDirectory()).toBe(true);
    });
  });

  describe('writeTaskSpec / readTaskSpec', () => {
    it('should write and read task spec content', async () => {
      await manager.initializeTask('test-task');
      await manager.writeTaskSpec('test-task', '# Task Specification\n\nBuild something cool');

      const content = await manager.readTaskSpec('test-task');
      expect(content).toBe('# Task Specification\n\nBuild something cool');
    });

    it('should throw when reading non-existent task spec', async () => {
      await expect(manager.readTaskSpec('non-existent')).rejects.toThrow();
    });
  });

  describe('createIteration', () => {
    it('should create iteration directory with steps subdirectory', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);

      const iterDir = manager.getIterationDir('test-task', 1);
      const stepsDir = manager.getStepsDir('test-task', 1);

      expect((await fs.stat(iterDir)).isDirectory()).toBe(true);
      expect((await fs.stat(stepsDir)).isDirectory()).toBe(true);
    });
  });

  describe('writeEvaluation / readEvaluation', () => {
    it('should write and read evaluation content', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);
      await manager.writeEvaluation('test-task', 1, '# Evaluation\n\nScore: 8/10');

      const content = await manager.readEvaluation('test-task', 1);
      expect(content).toBe('# Evaluation\n\nScore: 8/10');
    });
  });

  describe('hasEvaluation', () => {
    it('should return true when evaluation exists', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);
      await manager.writeEvaluation('test-task', 1, 'content');

      expect(await manager.hasEvaluation('test-task', 1)).toBe(true);
    });

    it('should return false when evaluation does not exist', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);

      expect(await manager.hasEvaluation('test-task', 1)).toBe(false);
    });
  });

  describe('writeExecution / readExecution', () => {
    it('should write and read execution content', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);
      await manager.writeExecution('test-task', 1, '# Execution\n\nSteps taken...');

      const content = await manager.readExecution('test-task', 1);
      expect(content).toBe('# Execution\n\nSteps taken...');
    });
  });

  describe('hasExecution', () => {
    it('should return true when execution exists', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);
      await manager.writeExecution('test-task', 1, 'content');

      expect(await manager.hasExecution('test-task', 1)).toBe(true);
    });

    it('should return false when execution does not exist', async () => {
      await manager.initializeTask('test-task');

      expect(await manager.hasExecution('test-task', 1)).toBe(false);
    });
  });

  describe('writeStepResult', () => {
    it('should write step result markdown file', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);
      await manager.writeStepResult('test-task', 1, 1, '# Step 1\n\nAnalyzed requirements');

      const stepPath = path.join(manager.getStepsDir('test-task', 1), 'step-1.md');
      const content = await fs.readFile(stepPath, 'utf-8');
      expect(content).toBe('# Step 1\n\nAnalyzed requirements');
    });
  });

  describe('writeFinalSummary', () => {
    it('should write final summary markdown file', async () => {
      await manager.initializeTask('test-task');
      await manager.writeFinalSummary('test-task', '# Final Summary\n\nAll done');

      const summaryPath = path.join(manager.getIterationsDir('test-task'), 'final-summary.md');
      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content).toBe('# Final Summary\n\nAll done');
    });
  });

  describe('taskExists', () => {
    it('should return true when task directory exists', async () => {
      await manager.initializeTask('test-task');
      expect(await manager.taskExists('test-task')).toBe(true);
    });

    it('should return false when task directory does not exist', async () => {
      expect(await manager.taskExists('non-existent')).toBe(false);
    });
  });

  describe('listIterations', () => {
    it('should return empty array when no iterations exist', async () => {
      await manager.initializeTask('test-task');
      expect(await manager.listIterations('test-task')).toEqual([]);
    });

    it('should return sorted iteration numbers', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 3);
      await manager.createIteration('test-task', 1);
      await manager.createIteration('test-task', 2);

      const iterations = await manager.listIterations('test-task');
      expect(iterations).toEqual([1, 2, 3]);
    });

    it('should ignore non-iter directories', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);

      // Create a non-iter directory
      const iterationsDir = manager.getIterationsDir('test-task');
      await fs.mkdir(path.join(iterationsDir, 'other-dir'));

      const iterations = await manager.listIterations('test-task');
      expect(iterations).toEqual([1]);
    });
  });

  describe('getTaskStats', () => {
    it('should return correct stats for empty task', async () => {
      await manager.initializeTask('test-task');

      const stats = await manager.getTaskStats('test-task');
      expect(stats.totalIterations).toBe(0);
      expect(stats.hasFinalSummary).toBe(false);
    });

    it('should count iterations and detect final summary', async () => {
      await manager.initializeTask('test-task');
      await manager.createIteration('test-task', 1);
      await manager.createIteration('test-task', 2);
      await manager.writeFinalSummary('test-task', 'summary content');

      const stats = await manager.getTaskStats('test-task');
      expect(stats.totalIterations).toBe(2);
      expect(stats.hasFinalSummary).toBe(true);
    });
  });

  describe('hasFinalResult', () => {
    it('should return true when final_result.md exists', async () => {
      await manager.initializeTask('test-task');
      const finalResultPath = manager.getFinalResultPath('test-task');
      await fs.writeFile(finalResultPath, 'Task complete', 'utf-8');

      expect(await manager.hasFinalResult('test-task')).toBe(true);
    });

    it('should return false when final_result.md does not exist', async () => {
      await manager.initializeTask('test-task');
      expect(await manager.hasFinalResult('test-task')).toBe(false);
    });
  });

  describe('cleanupTask', () => {
    it('should remove the entire task directory', async () => {
      await manager.initializeTask('test-task');
      await manager.writeTaskSpec('test-task', 'content');
      await manager.createIteration('test-task', 1);

      await manager.cleanupTask('test-task');
      expect(await manager.taskExists('test-task')).toBe(false);
    });
  });
});
