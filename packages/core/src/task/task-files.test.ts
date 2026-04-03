/**
 * Tests for TaskFileManager - Unified task file management system.
 *
 * @module task/task-files.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { TaskFileManager } from './task-files.js';

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
    it('should create manager with default tasks directory', () => {
      const mgr = new TaskFileManager({ workspaceDir: '/workspace' });
      expect(mgr.getTaskDir('test')).toContain('/workspace/tasks/test');
    });

    it('should create manager with custom subdirectory', () => {
      const mgr = new TaskFileManager({
        workspaceDir: '/workspace',
        subdirectory: 'custom',
      });
      expect(mgr.getTaskDir('test')).toContain('/workspace/tasks/custom/test');
    });
  });

  describe('getTaskDir', () => {
    it('should return correct task directory path', () => {
      const taskDir = manager.getTaskDir('msg-123');
      expect(taskDir).toBe(path.join(tmpDir, 'tasks', 'msg-123'));
    });

    it('should sanitize taskId with special characters', () => {
      const taskDir = manager.getTaskDir('msg/123@chat#id');
      expect(taskDir).toBe(path.join(tmpDir, 'tasks', 'msg_123_chat_id'));
    });

    it('should preserve valid characters in taskId', () => {
      const taskDir = manager.getTaskDir('task_abc-123');
      expect(taskDir).toBe(path.join(tmpDir, 'tasks', 'task_abc-123'));
    });
  });

  describe('getTaskSpecPath', () => {
    it('should return path to task.md', () => {
      const specPath = manager.getTaskSpecPath('msg-123');
      expect(specPath).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'task.md'));
    });
  });

  describe('getIterationsDir', () => {
    it('should return path to iterations directory', () => {
      const iterDir = manager.getIterationsDir('msg-123');
      expect(iterDir).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'iterations'));
    });
  });

  describe('getIterationDir', () => {
    it('should return path to specific iteration directory', () => {
      const iterDir = manager.getIterationDir('msg-123', 2);
      expect(iterDir).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'iterations', 'iter-2'));
    });
  });

  describe('getStepsDir', () => {
    it('should return path to steps directory for iteration', () => {
      const stepsDir = manager.getStepsDir('msg-123', 1);
      expect(stepsDir).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'iterations', 'iter-1', 'steps'));
    });
  });

  describe('getEvaluationPath', () => {
    it('should return path to evaluation.md', () => {
      const evalPath = manager.getEvaluationPath('msg-123', 1);
      expect(evalPath).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'iterations', 'iter-1', 'evaluation.md'));
    });
  });

  describe('getExecutionPath', () => {
    it('should return path to execution.md', () => {
      const execPath = manager.getExecutionPath('msg-123', 1);
      expect(execPath).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'iterations', 'iter-1', 'execution.md'));
    });
  });

  describe('getFinalResultPath', () => {
    it('should return path to final_result.md', () => {
      const resultPath = manager.getFinalResultPath('msg-123');
      expect(resultPath).toBe(path.join(tmpDir, 'tasks', 'msg-123', 'final_result.md'));
    });
  });

  describe('initializeTask', () => {
    it('should create task directory structure', async () => {
      await manager.initializeTask('msg-123');

      const taskDir = manager.getTaskDir('msg-123');
      const iterationsDir = manager.getIterationsDir('msg-123');

      await expect(fs.access(taskDir)).resolves.toBeUndefined();
      await expect(fs.access(iterationsDir)).resolves.toBeUndefined();
    });

    it('should handle existing directories gracefully', async () => {
      await manager.initializeTask('msg-123');
      // Second call should not throw
      await manager.initializeTask('msg-123');
    });
  });

  describe('writeTaskSpec / readTaskSpec', () => {
    it('should write and read task spec', async () => {
      await manager.initializeTask('msg-123');
      const content = '# Task: Fix Bug\n\nDescription here';

      await manager.writeTaskSpec('msg-123', content);
      const readContent = await manager.readTaskSpec('msg-123');

      expect(readContent).toBe(content);
    });

    it('should throw when reading non-existent task spec', async () => {
      await expect(manager.readTaskSpec('nonexistent'))
        .rejects.toThrow();
    });
  });

  describe('createIteration', () => {
    it('should create iteration directory with steps subdirectory', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);

      const iterDir = manager.getIterationDir('msg-123', 1);
      const stepsDir = manager.getStepsDir('msg-123', 1);

      await expect(fs.access(iterDir)).resolves.toBeUndefined();
      await expect(fs.access(stepsDir)).resolves.toBeUndefined();
    });
  });

  describe('writeEvaluation / readEvaluation', () => {
    it('should write and read evaluation', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);

      const content = '# Evaluation\n\nScore: 8/10';
      await manager.writeEvaluation('msg-123', 1, content);
      const readContent = await manager.readEvaluation('msg-123', 1);

      expect(readContent).toBe(content);
    });
  });

  describe('hasEvaluation', () => {
    it('should return true when evaluation exists', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);
      await manager.writeEvaluation('msg-123', 1, 'content');

      expect(await manager.hasEvaluation('msg-123', 1)).toBe(true);
    });

    it('should return false when evaluation does not exist', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);

      expect(await manager.hasEvaluation('msg-123', 1)).toBe(false);
    });
  });

  describe('writeExecution / readExecution', () => {
    it('should write and read execution', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);

      const content = '# Execution\n\nSteps taken...';
      await manager.writeExecution('msg-123', 1, content);
      const readContent = await manager.readExecution('msg-123', 1);

      expect(readContent).toBe(content);
    });
  });

  describe('hasExecution', () => {
    it('should return true when execution exists', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);
      await manager.writeExecution('msg-123', 1, 'content');

      expect(await manager.hasExecution('msg-123', 1)).toBe(true);
    });

    it('should return false when execution does not exist', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);

      expect(await manager.hasExecution('msg-123', 1)).toBe(false);
    });
  });

  describe('writeStepResult', () => {
    it('should write step result file', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);

      await manager.writeStepResult('msg-123', 1, 1, 'Step 1 result');

      const stepPath = path.join(manager.getStepsDir('msg-123', 1), 'step-1.md');
      const content = await fs.readFile(stepPath, 'utf-8');
      expect(content).toBe('Step 1 result');
    });

    it('should handle multiple steps', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);

      await manager.writeStepResult('msg-123', 1, 1, 'Step 1');
      await manager.writeStepResult('msg-123', 1, 2, 'Step 2');
      await manager.writeStepResult('msg-123', 1, 3, 'Step 3');

      const stepsDir = manager.getStepsDir('msg-123', 1);
      const entries = await fs.readdir(stepsDir);
      expect(entries).toHaveLength(3);
      expect(entries.sort()).toEqual(['step-1.md', 'step-2.md', 'step-3.md']);
    });
  });

  describe('writeFinalSummary', () => {
    it('should write final summary file', async () => {
      await manager.initializeTask('msg-123');

      const content = '# Final Summary\n\nAll tasks completed.';
      await manager.writeFinalSummary('msg-123', content);

      const summaryPath = path.join(manager.getIterationsDir('msg-123'), 'final-summary.md');
      const readContent = await fs.readFile(summaryPath, 'utf-8');
      expect(readContent).toBe(content);
    });
  });

  describe('taskExists', () => {
    it('should return true when task directory exists', async () => {
      await manager.initializeTask('msg-123');
      expect(await manager.taskExists('msg-123')).toBe(true);
    });

    it('should return false when task directory does not exist', async () => {
      expect(await manager.taskExists('nonexistent')).toBe(false);
    });
  });

  describe('listIterations', () => {
    it('should return empty array for task with no iterations', async () => {
      await manager.initializeTask('msg-123');
      const iterations = await manager.listIterations('msg-123');
      expect(iterations).toEqual([]);
    });

    it('should list all iterations sorted numerically', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 3);
      await manager.createIteration('msg-123', 1);
      await manager.createIteration('msg-123', 2);

      const iterations = await manager.listIterations('msg-123');
      expect(iterations).toEqual([1, 2, 3]);
    });

    it('should ignore non-iter directories', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);

      // Create a non-iter directory
      const iterationsDir = manager.getIterationsDir('msg-123');
      await fs.mkdir(path.join(iterationsDir, 'other-dir'));

      const iterations = await manager.listIterations('msg-123');
      expect(iterations).toEqual([1]);
    });

    it('should return empty array when iterations dir does not exist', async () => {
      const iterations = await manager.listIterations('nonexistent');
      expect(iterations).toEqual([]);
    });
  });

  describe('getTaskStats', () => {
    it('should return correct stats for empty task', async () => {
      await manager.initializeTask('msg-123');

      const stats = await manager.getTaskStats('msg-123');
      expect(stats.totalIterations).toBe(0);
      expect(stats.hasFinalSummary).toBe(false);
    });

    it('should count iterations correctly', async () => {
      await manager.initializeTask('msg-123');
      await manager.createIteration('msg-123', 1);
      await manager.createIteration('msg-123', 2);

      const stats = await manager.getTaskStats('msg-123');
      expect(stats.totalIterations).toBe(2);
    });

    it('should detect final summary', async () => {
      await manager.initializeTask('msg-123');
      await manager.writeFinalSummary('msg-123', '# Summary');

      const stats = await manager.getTaskStats('msg-123');
      expect(stats.hasFinalSummary).toBe(true);
    });
  });

  describe('cleanupTask', () => {
    it('should remove task directory', async () => {
      await manager.initializeTask('msg-123');
      await manager.writeTaskSpec('msg-123', 'content');

      expect(await manager.taskExists('msg-123')).toBe(true);
      await manager.cleanupTask('msg-123');
      expect(await manager.taskExists('msg-123')).toBe(false);
    });

    it('should handle cleanup of non-existent task', async () => {
      // Should not throw even if task doesn't exist (rm with force: true)
      await manager.cleanupTask('nonexistent');
    });
  });

  describe('hasFinalResult', () => {
    it('should return true when final_result.md exists', async () => {
      await manager.initializeTask('msg-123');
      const resultPath = manager.getFinalResultPath('msg-123');
      await fs.writeFile(resultPath, 'Task complete', 'utf-8');

      expect(await manager.hasFinalResult('msg-123')).toBe(true);
    });

    it('should return false when final_result.md does not exist', async () => {
      await manager.initializeTask('msg-123');
      expect(await manager.hasFinalResult('msg-123')).toBe(false);
    });
  });

  describe('full workflow', () => {
    it('should support complete task lifecycle', async () => {
      const taskId = 'msg-workflow-001';

      // Initialize
      await manager.initializeTask(taskId);
      expect(await manager.taskExists(taskId)).toBe(true);

      // Write task spec
      await manager.writeTaskSpec(taskId, '# Fix Bug\n\nFix the login issue');
      const spec = await manager.readTaskSpec(taskId);
      expect(spec).toContain('Fix the login issue');

      // Create iteration and write evaluation
      await manager.createIteration(taskId, 1);
      await manager.writeEvaluation(taskId, 1, '# Eval\n\nScore: 7');
      expect(await manager.hasEvaluation(taskId, 1)).toBe(true);

      // Write execution
      await manager.writeExecution(taskId, 1, '# Exec\n\nFixed the bug');
      expect(await manager.hasExecution(taskId, 1)).toBe(true);

      // Write step results
      await manager.writeStepResult(taskId, 1, 1, 'Step 1: Analysis');
      await manager.writeStepResult(taskId, 1, 2, 'Step 2: Implementation');

      // Write final summary
      await manager.writeFinalSummary(taskId, '# Summary\n\nBug fixed');

      // Check stats
      const stats = await manager.getTaskStats(taskId);
      expect(stats.totalIterations).toBe(1);
      expect(stats.hasFinalSummary).toBe(true);

      // List iterations
      const iterations = await manager.listIterations(taskId);
      expect(iterations).toEqual([1]);

      // Write final result
      const resultPath = manager.getFinalResultPath(taskId);
      await fs.writeFile(resultPath, 'COMPLETE', 'utf-8');
      expect(await manager.hasFinalResult(taskId)).toBe(true);

      // Cleanup
      await manager.cleanupTask(taskId);
      expect(await manager.taskExists(taskId)).toBe(false);
    });
  });
});
