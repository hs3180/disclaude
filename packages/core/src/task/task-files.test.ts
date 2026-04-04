/**
 * Tests for TaskFileManager.
 *
 * Verifies file-based task directory and markdown file management.
 *
 * Issue #1617: Phase 2 - task module test coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskFileManager } from './task-files.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-files-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskFileManager', () => {
  let manager: TaskFileManager;

  beforeEach(() => {
    manager = new TaskFileManager({ workspaceDir: tempDir });
  });

  describe('constructor', () => {
    it('should create manager with default tasks dir', () => {
      const m = new TaskFileManager({ workspaceDir: tempDir });
      expect(m.getTaskDir('test')).toContain('tasks');
    });

    it('should create manager with subdirectory', () => {
      const m = new TaskFileManager({ workspaceDir: tempDir, subdirectory: 'custom' });
      const taskDir = m.getTaskDir('test');
      expect(taskDir).toContain('custom');
      expect(taskDir).toContain('tasks');
    });
  });

  describe('path methods', () => {
    it('should sanitize task ID in getTaskDir', () => {
      const result = manager.getTaskDir('msg/123@abc');
      const baseName = path.basename(result);
      expect(baseName).not.toContain('/');
      expect(baseName).not.toContain('@');
      expect(baseName).toContain('_');
    });

    it('should return correct task spec path', () => {
      const result = manager.getTaskSpecPath('task-1');
      expect(result).toContain('task.md');
      expect(result).toContain('task-1');
    });

    it('should return correct iterations dir', () => {
      const result = manager.getIterationsDir('task-1');
      expect(result).toContain('iterations');
      expect(result).toContain('task-1');
    });

    it('should return correct iteration dir', () => {
      const result = manager.getIterationDir('task-1', 2);
      expect(result).toContain('iter-2');
    });

    it('should return correct steps dir', () => {
      const result = manager.getStepsDir('task-1', 1);
      expect(result).toContain('steps');
      expect(result).toContain('iter-1');
    });

    it('should return correct evaluation path', () => {
      const result = manager.getEvaluationPath('task-1', 1);
      expect(result).toContain('evaluation.md');
    });

    it('should return correct execution path', () => {
      const result = manager.getExecutionPath('task-1', 1);
      expect(result).toContain('execution.md');
    });

    it('should return correct final result path', () => {
      const result = manager.getFinalResultPath('task-1');
      expect(result).toContain('final_result.md');
    });
  });

  describe('initializeTask', () => {
    it('should create task directory and iterations directory', async () => {
      await manager.initializeTask('task-1');

      const taskDir = manager.getTaskDir('task-1');
      const iterDir = manager.getIterationsDir('task-1');

      const stat1 = await fs.stat(taskDir);
      const stat2 = await fs.stat(iterDir);
      expect(stat1.isDirectory()).toBe(true);
      expect(stat2.isDirectory()).toBe(true);
    });

    it('should handle existing directory gracefully', async () => {
      await manager.initializeTask('task-1');
      await manager.initializeTask('task-1'); // should not throw
    });
  });

  describe('writeTaskSpec / readTaskSpec', () => {
    it('should write and read task spec', async () => {
      await manager.initializeTask('task-1');
      const content = '# My Task\n\nThis is the task description.';
      await manager.writeTaskSpec('task-1', content);

      const read = await manager.readTaskSpec('task-1');
      expect(read).toBe(content);
    });

    it('should throw when reading non-existent spec', async () => {
      await expect(manager.readTaskSpec('nonexistent')).rejects.toThrow();
    });
  });

  describe('createIteration', () => {
    it('should create iteration and steps directory', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);

      const iterDir = manager.getIterationDir('task-1', 1);
      const stepsDir = manager.getStepsDir('task-1', 1);

      expect((await fs.stat(iterDir)).isDirectory()).toBe(true);
      expect((await fs.stat(stepsDir)).isDirectory()).toBe(true);
    });

    it('should handle existing iteration directory', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);
      await manager.createIteration('task-1', 1); // should not throw
    });
  });

  describe('writeEvaluation / readEvaluation / hasEvaluation', () => {
    it('should write and read evaluation', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);

      const content = '## Evaluation\n\nThe task was completed successfully.';
      await manager.writeEvaluation('task-1', 1, content);

      const read = await manager.readEvaluation('task-1', 1);
      expect(read).toBe(content);
    });

    it('should return true for existing evaluation', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);
      await manager.writeEvaluation('task-1', 1, 'eval');

      expect(await manager.hasEvaluation('task-1', 1)).toBe(true);
    });

    it('should return false for non-existent evaluation', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);

      expect(await manager.hasEvaluation('task-1', 1)).toBe(false);
    });

    it('should throw when reading non-existent evaluation', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);

      await expect(manager.readEvaluation('task-1', 1)).rejects.toThrow();
    });
  });

  describe('writeExecution / readExecution / hasExecution', () => {
    it('should write and read execution', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);

      const content = '## Execution\n\nSteps taken...';
      await manager.writeExecution('task-1', 1, content);

      const read = await manager.readExecution('task-1', 1);
      expect(read).toBe(content);
    });

    it('should return true for existing execution', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);
      await manager.writeExecution('task-1', 1, 'exec');

      expect(await manager.hasExecution('task-1', 1)).toBe(true);
    });

    it('should return false for non-existent execution', async () => {
      await manager.initializeTask('task-1');
      expect(await manager.hasExecution('task-1', 1)).toBe(false);
    });
  });

  describe('writeStepResult', () => {
    it('should write step result file', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);

      await manager.writeStepResult('task-1', 1, 1, 'Step 1 result');

      const stepPath = path.join(manager.getStepsDir('task-1', 1), 'step-1.md');
      const content = await fs.readFile(stepPath, 'utf-8');
      expect(content).toBe('Step 1 result');
    });

    it('should write multiple step results', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);

      await manager.writeStepResult('task-1', 1, 1, 'Step 1');
      await manager.writeStepResult('task-1', 1, 2, 'Step 2');
      await manager.writeStepResult('task-1', 1, 3, 'Step 3');

      const stepsDir = manager.getStepsDir('task-1', 1);
      const files = await fs.readdir(stepsDir);
      expect(files).toHaveLength(3);
      expect(files.sort()).toEqual(['step-1.md', 'step-2.md', 'step-3.md']);
    });
  });

  describe('writeFinalSummary', () => {
    it('should write final summary file', async () => {
      await manager.initializeTask('task-1');

      const content = '# Final Summary\n\nAll tasks completed.';
      await manager.writeFinalSummary('task-1', content);

      const summaryPath = path.join(manager.getIterationsDir('task-1'), 'final-summary.md');
      const read = await fs.readFile(summaryPath, 'utf-8');
      expect(read).toBe(content);
    });
  });

  describe('taskExists', () => {
    it('should return false for non-existent task', async () => {
      expect(await manager.taskExists('nonexistent')).toBe(false);
    });

    it('should return true after initialization', async () => {
      await manager.initializeTask('task-1');
      expect(await manager.taskExists('task-1')).toBe(true);
    });
  });

  describe('listIterations', () => {
    it('should return empty array for task with no iterations', async () => {
      await manager.initializeTask('task-1');
      expect(await manager.listIterations('task-1')).toEqual([]);
    });

    it('should return iteration numbers sorted', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 3);
      await manager.createIteration('task-1', 1);
      await manager.createIteration('task-1', 2);

      const iterations = await manager.listIterations('task-1');
      expect(iterations).toEqual([1, 2, 3]);
    });

    it('should ignore non-iter directories', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);

      // Create a non-iteration directory
      const iterDir = manager.getIterationsDir('task-1');
      await fs.mkdir(path.join(iterDir, 'other-dir'));

      const iterations = await manager.listIterations('task-1');
      expect(iterations).toEqual([1]);
    });

    it('should return empty array for non-existent task', async () => {
      expect(await manager.listIterations('nonexistent')).toEqual([]);
    });
  });

  describe('getTaskStats', () => {
    it('should return stats for task with no iterations', async () => {
      await manager.initializeTask('task-1');

      const stats = await manager.getTaskStats('task-1');
      expect(stats.totalIterations).toBe(0);
      expect(stats.hasFinalSummary).toBe(false);
    });

    it('should return correct iteration count', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);
      await manager.createIteration('task-1', 2);

      const stats = await manager.getTaskStats('task-1');
      expect(stats.totalIterations).toBe(2);
    });

    it('should detect final summary', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);
      await manager.writeFinalSummary('task-1', 'Summary');

      const stats = await manager.getTaskStats('task-1');
      expect(stats.hasFinalSummary).toBe(true);
    });
  });

  describe('hasFinalResult', () => {
    it('should return false when final_result.md does not exist', async () => {
      await manager.initializeTask('task-1');
      expect(await manager.hasFinalResult('task-1')).toBe(false);
    });

    it('should return true when final_result.md exists', async () => {
      await manager.initializeTask('task-1');
      const finalResultPath = manager.getFinalResultPath('task-1');
      await fs.writeFile(finalResultPath, 'Final result', 'utf-8');

      expect(await manager.hasFinalResult('task-1')).toBe(true);
    });
  });

  describe('cleanupTask', () => {
    it('should remove task directory', async () => {
      await manager.initializeTask('task-1');
      await manager.createIteration('task-1', 1);
      await manager.writeTaskSpec('task-1', 'content');

      expect(await manager.taskExists('task-1')).toBe(true);
      await manager.cleanupTask('task-1');
      expect(await manager.taskExists('task-1')).toBe(false);
    });

    it('should handle non-existent task gracefully', async () => {
      await expect(manager.cleanupTask('nonexistent')).resolves.toBeUndefined();
    });
  });
});
