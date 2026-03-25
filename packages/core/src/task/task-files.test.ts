/**
 * Comprehensive tests for TaskFileManager.
 *
 * Tests file operations, directory structure, iteration management,
 * and edge cases for the task file management system.
 * @module task/task-files.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, readdir, stat, access, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskFileManager } from './task-files.js';

describe('TaskFileManager', () => {
  let workspaceDir: string;
  let manager: TaskFileManager;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'task-files-test-'));
    manager = new TaskFileManager({ workspaceDir });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create manager with workspace dir', () => {
      expect(manager).toBeDefined();
    });

    it('should use subdirectory when provided', () => {
      const mgr = new TaskFileManager({ workspaceDir, subdirectory: 'custom' });
      expect(mgr.getTaskDir('task-1')).toContain(join('tasks', 'custom'));
    });

    it('should use default tasks dir without subdirectory', () => {
      expect(manager.getTaskDir('task-1')).toContain(join('tasks'));
    });
  });

  describe('path generation', () => {
    it('should sanitize taskId for directory names', () => {
      const taskId = 'oc_abc123@#%&*()!';
      const taskDir = manager.getTaskDir(taskId);
      expect(taskDir).not.toContain('@');
      expect(taskDir).not.toContain('#');
      expect(taskDir).not.toContain('%');
      expect(taskDir).toContain('oc_abc123________');
    });

    it('should return correct task.md path', () => {
      const path = manager.getTaskSpecPath('task-1');
      expect(path).toMatch(/task-1[\/\\]task\.md$/);
    });

    it('should return correct iterations dir', () => {
      const path = manager.getIterationsDir('task-1');
      expect(path).toMatch(/task-1[\/\\]iterations$/);
    });

    it('should return correct iteration dir', () => {
      const path = manager.getIterationDir('task-1', 2);
      expect(path).toMatch(/task-1[\/\\]iterations[\/\\]iter-2$/);
    });

    it('should return correct steps dir', () => {
      const path = manager.getStepsDir('task-1', 2);
      expect(path).toMatch(/task-1[\/\\]iterations[\/\\]iter-2[\/\\]steps$/);
    });

    it('should return correct evaluation path', () => {
      const path = manager.getEvaluationPath('task-1', 1);
      expect(path).toMatch(/iter-1[\/\\]evaluation\.md$/);
    });

    it('should return correct execution path', () => {
      const path = manager.getExecutionPath('task-1', 1);
      expect(path).toMatch(/iter-1[\/\\]execution\.md$/);
    });

    it('should return correct final result path', () => {
      const path = manager.getFinalResultPath('task-1');
      expect(path).toMatch(/task-1[\/\\]final_result\.md$/);
    });
  });

  describe('initializeTask', () => {
    it('should create task directory with iterations subdirectory', async () => {
      await manager.initializeTask('task-init');

      const taskDir = manager.getTaskDir('task-init');
      const iterationsDir = manager.getIterationsDir('task-init');

      expect(existsSync(taskDir)).toBe(true);
      expect(existsSync(iterationsDir)).toBe(true);
    });

    it('should be idempotent - calling twice should not fail', async () => {
      await manager.initializeTask('task-init');
      await manager.initializeTask('task-init');
      expect(existsSync(manager.getTaskDir('task-init'))).toBe(true);
    });

    it('should create tasks base dir if it does not exist', async () => {
      const nestedDir = join(workspaceDir, 'deep', 'nested');
      const mgr = new TaskFileManager({ workspaceDir: nestedDir });
      await mgr.initializeTask('task-nested');

      expect(existsSync(mgr.getTaskDir('task-nested'))).toBe(true);

      await rm(nestedDir, { recursive: true, force: true });
    });
  });

  describe('writeTaskSpec / readTaskSpec', () => {
    it('should write and read task spec content', async () => {
      await manager.initializeTask('task-spec');
      const content = '# Task: Fix Bug\n\nFix the critical bug.';
      await manager.writeTaskSpec('task-spec', content);

      const read = await manager.readTaskSpec('task-spec');
      expect(read).toBe(content);
    });

    it('should throw when directory does not exist', async () => {
      // writeTaskSpec does NOT auto-create directories
      await expect(manager.writeTaskSpec('task-no-dir', 'content')).rejects.toThrow();
    });

    it('should throw when reading non-existent task spec', async () => {
      await expect(manager.readTaskSpec('nonexistent')).rejects.toThrow();
    });

    it('should preserve multiline content', async () => {
      await manager.initializeTask('task-ml');
      const content = '# Title\n\nLine 2\nLine 3\n\n```json\n{"key": "value"}\n```';
      await manager.writeTaskSpec('task-ml', content);
      const read = await manager.readTaskSpec('task-ml');
      expect(read).toBe(content);
    });
  });

  describe('iteration management', () => {
    it('should create iteration directory with steps subdirectory', async () => {
      await manager.createIteration('task-iter', 1);

      const iterDir = manager.getIterationDir('task-iter', 1);
      const stepsDir = manager.getStepsDir('task-iter', 1);

      expect(existsSync(iterDir)).toBe(true);
      expect(existsSync(stepsDir)).toBe(true);
    });

    it('should create multiple iterations', async () => {
      await manager.createIteration('task-multi', 1);
      await manager.createIteration('task-multi', 2);
      await manager.createIteration('task-multi', 3);

      expect(existsSync(manager.getIterationDir('task-multi', 1))).toBe(true);
      expect(existsSync(manager.getIterationDir('task-multi', 2))).toBe(true);
      expect(existsSync(manager.getIterationDir('task-multi', 3))).toBe(true);
    });
  });

  describe('writeEvaluation / readEvaluation / hasEvaluation', () => {
    beforeEach(async () => {
      await manager.createIteration('task-eval', 1);
    });

    it('should write and read evaluation', async () => {
      const content = '## Evaluation\n\nThe implementation is correct.';
      await manager.writeEvaluation('task-eval', 1, content);

      const read = await manager.readEvaluation('task-eval', 1);
      expect(read).toBe(content);
    });

    it('should return true for hasEvaluation when file exists', async () => {
      await manager.writeEvaluation('task-eval', 1, 'content');
      expect(await manager.hasEvaluation('task-eval', 1)).toBe(true);
    });

    it('should return false for hasEvaluation when file does not exist', async () => {
      expect(await manager.hasEvaluation('task-eval', 1)).toBe(false);
    });

    it('should throw when reading non-existent evaluation', async () => {
      await expect(manager.readEvaluation('task-eval', 99)).rejects.toThrow();
    });
  });

  describe('writeExecution / readExecution / hasExecution', () => {
    beforeEach(async () => {
      await manager.createIteration('task-exec', 1);
    });

    it('should write and read execution', async () => {
      const content = '## Execution\n\nChanges made to file X.';
      await manager.writeExecution('task-exec', 1, content);

      const read = await manager.readExecution('task-exec', 1);
      expect(read).toBe(content);
    });

    it('should return true for hasExecution when file exists', async () => {
      await manager.writeExecution('task-exec', 1, 'content');
      expect(await manager.hasExecution('task-exec', 1)).toBe(true);
    });

    it('should return false for hasExecution when file does not exist', async () => {
      expect(await manager.hasExecution('task-exec', 1)).toBe(false);
    });

    it('should throw when reading non-existent execution', async () => {
      await expect(manager.readExecution('task-exec', 99)).rejects.toThrow();
    });
  });

  describe('writeStepResult', () => {
    it('should write step result to correct path', async () => {
      await manager.createIteration('task-step', 1);
      await manager.writeStepResult('task-step', 1, 1, 'Step 1: Setup environment');

      const stepPath = join(manager.getStepsDir('task-step', 1), 'step-1.md');
      expect(existsSync(stepPath)).toBe(true);

      const content = await readFile(stepPath, 'utf-8');
      expect(content).toBe('Step 1: Setup environment');
    });

    it('should write multiple step results', async () => {
      await manager.createIteration('task-steps', 1);

      await manager.writeStepResult('task-steps', 1, 1, 'Step 1');
      await manager.writeStepResult('task-steps', 1, 2, 'Step 2');
      await manager.writeStepResult('task-steps', 1, 3, 'Step 3');

      const stepsDir = manager.getStepsDir('task-steps', 1);
      const files = await readdir(stepsDir);
      expect(files).toHaveLength(3);
      expect(files.sort()).toEqual(['step-1.md', 'step-2.md', 'step-3.md']);
    });
  });

  describe('writeFinalSummary', () => {
    it('should write final summary to iterations dir', async () => {
      await manager.initializeTask('task-summary');
      await manager.writeFinalSummary('task-summary', '# Summary\n\nTask completed successfully.');

      const summaryPath = join(manager.getIterationsDir('task-summary'), 'final-summary.md');
      expect(existsSync(summaryPath)).toBe(true);

      const content = await readFile(summaryPath, 'utf-8');
      expect(content).toContain('Task completed successfully');
    });
  });

  describe('taskExists', () => {
    it('should return true when task directory exists', async () => {
      await manager.initializeTask('task-exists');
      expect(await manager.taskExists('task-exists')).toBe(true);
    });

    it('should return false when task directory does not exist', async () => {
      expect(await manager.taskExists('nonexistent')).toBe(false);
    });
  });

  describe('listIterations', () => {
    it('should return empty array when no iterations exist', async () => {
      await manager.initializeTask('task-list');
      const iterations = await manager.listIterations('task-list');
      expect(iterations).toEqual([]);
    });

    it('should return sorted iteration numbers', async () => {
      await manager.initializeTask('task-list');
      await manager.createIteration('task-list', 3);
      await manager.createIteration('task-list', 1);
      await manager.createIteration('task-list', 2);

      const iterations = await manager.listIterations('task-list');
      expect(iterations).toEqual([1, 2, 3]);
    });

    it('should ignore non-iteration directories', async () => {
      await manager.initializeTask('task-list-filter');
      await manager.createIteration('task-list-filter', 1);

      // Create a non-iteration directory
      const iterationsDir = manager.getIterationsDir('task-list-filter');
      await mkdir(join(iterationsDir, 'other-dir'), { recursive: true });
      await mkdir(join(iterationsDir, 'iter-invalid'), { recursive: true });

      const iterations = await manager.listIterations('task-list-filter');
      expect(iterations).toEqual([1]);
    });

    it('should return empty array when iterations dir does not exist', async () => {
      const iterations = await manager.listIterations('nonexistent');
      expect(iterations).toEqual([]);
    });
  });

  describe('getTaskStats', () => {
    it('should return zero iterations and no summary for new task', async () => {
      await manager.initializeTask('task-stats');
      const stats = await manager.getTaskStats('task-stats');

      expect(stats.totalIterations).toBe(0);
      expect(stats.hasFinalSummary).toBe(false);
    });

    it('should count iterations correctly', async () => {
      await manager.initializeTask('task-stats-count');
      await manager.createIteration('task-stats-count', 1);
      await manager.createIteration('task-stats-count', 2);

      const stats = await manager.getTaskStats('task-stats-count');
      expect(stats.totalIterations).toBe(2);
      expect(stats.hasFinalSummary).toBe(false);
    });

    it('should detect final summary', async () => {
      await manager.initializeTask('task-stats-summary');
      await manager.writeFinalSummary('task-stats-summary', 'Done!');

      const stats = await manager.getTaskStats('task-stats-summary');
      expect(stats.hasFinalSummary).toBe(true);
    });
  });

  describe('hasFinalResult', () => {
    it('should return false when final_result.md does not exist', async () => {
      await manager.initializeTask('task-fr');
      expect(await manager.hasFinalResult('task-fr')).toBe(false);
    });

    it('should return true when final_result.md exists', async () => {
      await manager.initializeTask('task-fr-exists');
      const finalResultPath = manager.getFinalResultPath('task-fr-exists');
      await writeFile(finalResultPath, 'Task complete', 'utf-8');

      expect(await manager.hasFinalResult('task-fr-exists')).toBe(true);
    });
  });

  describe('cleanupTask', () => {
    it('should remove task directory', async () => {
      await manager.initializeTask('task-cleanup');
      await manager.writeTaskSpec('task-cleanup', 'content');
      await manager.createIteration('task-cleanup', 1);

      expect(await manager.taskExists('task-cleanup')).toBe(true);

      await manager.cleanupTask('task-cleanup');

      expect(await manager.taskExists('task-cleanup')).toBe(false);
    });

    it('should not throw when cleaning non-existent task', async () => {
      await expect(manager.cleanupTask('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('end-to-end workflow', () => {
    it('should support full task lifecycle', async () => {
      const taskId = 'task-e2e';

      // Initialize
      await manager.initializeTask(taskId);
      expect(await manager.taskExists(taskId)).toBe(true);

      // Write task spec
      await manager.writeTaskSpec(taskId, '# Fix Bug\n\nFix the bug in module X');
      const spec = await manager.readTaskSpec(taskId);
      expect(spec).toContain('Fix Bug');

      // Iteration 1
      await manager.createIteration(taskId, 1);
      await manager.writeEvaluation(taskId, 1, '## Eval 1\n\nApproach: Refactor');
      await manager.writeExecution(taskId, 1, '## Exec 1\n\nChanged file X');
      await manager.writeStepResult(taskId, 1, 1, 'Step 1: Analyze');
      await manager.writeStepResult(taskId, 1, 2, 'Step 2: Implement');

      expect(await manager.hasEvaluation(taskId, 1)).toBe(true);
      expect(await manager.hasExecution(taskId, 1)).toBe(true);

      // Iteration 2
      await manager.createIteration(taskId, 2);
      await manager.writeEvaluation(taskId, 2, '## Eval 2\n\nLGTM');

      // Check stats
      const stats = await manager.getTaskStats(taskId);
      expect(stats.totalIterations).toBe(2);
      expect(stats.hasFinalSummary).toBe(false);

      // Write final summary
      await manager.writeFinalSummary(taskId, '# Summary\n\nBug fixed.');
      const stats2 = await manager.getTaskStats(taskId);
      expect(stats2.hasFinalSummary).toBe(true);

      // Cleanup
      await manager.cleanupTask(taskId);
      expect(await manager.taskExists(taskId)).toBe(false);
    });
  });
});
