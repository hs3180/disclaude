/**
 * Tests for TaskFileManager (packages/core/src/task/task-files.ts)
 */

import { vi } from 'vitest';

// Mock logger before importing the module under test
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  })),
}));

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
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

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create manager with workspace dir and default tasks subdirectory', () => {
      const mgr = new TaskFileManager({ workspaceDir: tmpDir });
      const taskDir = mgr.getTaskDir('test-task');
      expect(taskDir).toContain(path.join(tmpDir, 'tasks', 'test-task'));
    });

    it('should include subdirectory in path when provided', () => {
      const mgr = new TaskFileManager({
        workspaceDir: tmpDir,
        subdirectory: 'my-project',
      });
      const taskDir = mgr.getTaskDir('test-task');
      expect(taskDir).toContain(path.join(tmpDir, 'tasks', 'my-project', 'test-task'));
    });

    it('should handle nested subdirectory', () => {
      const mgr = new TaskFileManager({
        workspaceDir: tmpDir,
        subdirectory: 'org/project-1',
      });
      const taskDir = mgr.getTaskDir('abc');
      expect(taskDir).toBe(path.join(tmpDir, 'tasks', 'org/project-1', 'abc'));
    });
  });

  // =========================================================================
  // Path getters
  // =========================================================================

  describe('path getters', () => {
    const taskId = 'task-123';

    it('getTaskDir() returns correct path', () => {
      const result = manager.getTaskDir(taskId);
      expect(result).toBe(path.join(tmpDir, 'tasks', taskId));
    });

    it('getTaskSpecPath() returns task.md path', () => {
      const result = manager.getTaskSpecPath(taskId);
      expect(result).toBe(path.join(tmpDir, 'tasks', taskId, 'task.md'));
    });

    it('getIterationsDir() returns iterations directory path', () => {
      const result = manager.getIterationsDir(taskId);
      expect(result).toBe(path.join(tmpDir, 'tasks', taskId, 'iterations'));
    });

    it('getIterationDir() returns iter-N directory path', () => {
      const result = manager.getIterationDir(taskId, 3);
      expect(result).toBe(path.join(tmpDir, 'tasks', taskId, 'iterations', 'iter-3'));
    });

    it('getStepsDir() returns steps directory path', () => {
      const result = manager.getStepsDir(taskId, 2);
      expect(result).toBe(path.join(tmpDir, 'tasks', taskId, 'iterations', 'iter-2', 'steps'));
    });

    it('getEvaluationPath() returns evaluation.md path', () => {
      const result = manager.getEvaluationPath(taskId, 1);
      expect(result).toBe(path.join(tmpDir, 'tasks', taskId, 'iterations', 'iter-1', 'evaluation.md'));
    });

    it('getExecutionPath() returns execution.md path', () => {
      const result = manager.getExecutionPath(taskId, 1);
      expect(result).toBe(path.join(tmpDir, 'tasks', taskId, 'iterations', 'iter-1', 'execution.md'));
    });

    it('getFinalResultPath() returns final_result.md path', () => {
      const result = manager.getFinalResultPath(taskId);
      expect(result).toBe(path.join(tmpDir, 'tasks', taskId, 'final_result.md'));
    });
  });

  // =========================================================================
  // Path sanitization
  // =========================================================================

  describe('path sanitization', () => {
    it('should replace slashes in task IDs with underscores', () => {
      const result = manager.getTaskDir('task/slash');
      expect(result).not.toContain('task/slash');
      expect(result).toContain('task_slash');
    });

    it('should replace dots in task IDs with underscores', () => {
      const result = manager.getTaskDir('task.123');
      expect(result).toContain('task_123');
    });

    it('should preserve alphanumeric characters, hyphens, and underscores', () => {
      const result = manager.getTaskDir('task-ABC_123');
      expect(result).toContain('task-ABC_123');
    });

    it('should replace spaces with underscores', () => {
      const result = manager.getTaskDir('task name here');
      expect(result).toContain('task_name_here');
    });

    it('should handle task IDs with special characters', () => {
      const result = manager.getTaskDir('task@#$%^&*()');
      // @#$%^&*() = 8 special chars -> 8 underscores
      expect(result).toContain('task________');
    });

    it('should sanitize consistently across all path methods', () => {
      const taskId = 'task.with/special';
      const taskDir = manager.getTaskDir(taskId);
      const taskSpecPath = manager.getTaskSpecPath(taskId);
      expect(taskSpecPath).toContain(taskDir);
      expect(taskSpecPath).toContain('task_with_special');
    });
  });

  // =========================================================================
  // initializeTask
  // =========================================================================

  describe('initializeTask', () => {
    it('should create task directory', async () => {
      await manager.initializeTask('task-init');
      const stat = await fs.stat(manager.getTaskDir('task-init'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create iterations directory inside task directory', async () => {
      await manager.initializeTask('task-init');
      const stat = await fs.stat(manager.getIterationsDir('task-init'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create base tasks directory if it does not exist', async () => {
      const freshDir = path.join(tmpDir, 'fresh-workspace');
      const freshManager = new TaskFileManager({ workspaceDir: freshDir });
      await freshManager.initializeTask('new-task');
      const stat = await fs.stat(freshManager.getTaskDir('new-task'));
      expect(stat.isDirectory()).toBe(true);
      await fs.rm(freshDir, { recursive: true, force: true });
    });

    it('should be idempotent - calling twice does not throw', async () => {
      await manager.initializeTask('task-init');
      await expect(manager.initializeTask('task-init')).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // writeTaskSpec / readTaskSpec
  // =========================================================================

  describe('writeTaskSpec / readTaskSpec', () => {
    it('should write and read back task spec content', async () => {
      const content = '# Task Specification\n\nThis is a test task.';
      await manager.initializeTask('task-spec');
      await manager.writeTaskSpec('task-spec', content);
      const read = await manager.readTaskSpec('task-spec');
      expect(read).toBe(content);
    });

    it('should overwrite existing task spec', async () => {
      await manager.initializeTask('task-spec');
      await manager.writeTaskSpec('task-spec', 'first');
      await manager.writeTaskSpec('task-spec', 'second');
      const read = await manager.readTaskSpec('task-spec');
      expect(read).toBe('second');
    });

    it('should handle empty content', async () => {
      await manager.initializeTask('task-spec');
      await manager.writeTaskSpec('task-spec', '');
      const read = await manager.readTaskSpec('task-spec');
      expect(read).toBe('');
    });

    it('should handle multiline markdown with code blocks', async () => {
      const content = '# Plan\n\n```typescript\nconsole.log("hello");\n```\n\nDone.';
      await manager.initializeTask('task-spec');
      await manager.writeTaskSpec('task-spec', content);
      const read = await manager.readTaskSpec('task-spec');
      expect(read).toBe(content);
    });
  });

  // =========================================================================
  // createIteration
  // =========================================================================

  describe('createIteration', () => {
    it('should create iteration directory', async () => {
      await manager.initializeTask('task-iter');
      await manager.createIteration('task-iter', 1);
      const stat = await fs.stat(manager.getIterationDir('task-iter', 1));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create steps directory inside iteration', async () => {
      await manager.initializeTask('task-iter');
      await manager.createIteration('task-iter', 1);
      const stat = await fs.stat(manager.getStepsDir('task-iter', 1));
      expect(stat.isDirectory()).toBe(true);
    });

    it('should create multiple iterations independently', async () => {
      await manager.initializeTask('task-iter');
      await manager.createIteration('task-iter', 1);
      await manager.createIteration('task-iter', 2);
      const stat1 = await fs.stat(manager.getIterationDir('task-iter', 1));
      const stat2 = await fs.stat(manager.getIterationDir('task-iter', 2));
      expect(stat1.isDirectory()).toBe(true);
      expect(stat2.isDirectory()).toBe(true);
    });

    it('should be idempotent', async () => {
      await manager.initializeTask('task-iter');
      await manager.createIteration('task-iter', 1);
      await expect(manager.createIteration('task-iter', 1)).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // writeEvaluation / readEvaluation
  // =========================================================================

  describe('writeEvaluation / readEvaluation', () => {
    it('should write and read back evaluation content', async () => {
      const content = '# Evaluation\n\nScore: 8/10';
      await manager.initializeTask('task-eval');
      await manager.createIteration('task-eval', 1);
      await manager.writeEvaluation('task-eval', 1, content);
      const read = await manager.readEvaluation('task-eval', 1);
      expect(read).toBe(content);
    });

    it('should overwrite existing evaluation', async () => {
      await manager.initializeTask('task-eval');
      await manager.createIteration('task-eval', 1);
      await manager.writeEvaluation('task-eval', 1, 'first');
      await manager.writeEvaluation('task-eval', 1, 'second');
      const read = await manager.readEvaluation('task-eval', 1);
      expect(read).toBe('second');
    });

    it('should handle content with unicode characters', async () => {
      const content = '# Evaluation\n\nScore: \u2713 pass, \u2717 fail, \u2605 great';
      await manager.initializeTask('task-eval');
      await manager.createIteration('task-eval', 1);
      await manager.writeEvaluation('task-eval', 1, content);
      const read = await manager.readEvaluation('task-eval', 1);
      expect(read).toBe(content);
    });
  });

  // =========================================================================
  // writeExecution / readExecution
  // =========================================================================

  describe('writeExecution / readExecution', () => {
    it('should write and read back execution content', async () => {
      const content = '# Execution\n\nRan tests, all passed.';
      await manager.initializeTask('task-exec');
      await manager.createIteration('task-exec', 1);
      await manager.writeExecution('task-exec', 1, content);
      const read = await manager.readExecution('task-exec', 1);
      expect(read).toBe(content);
    });

    it('should overwrite existing execution', async () => {
      await manager.initializeTask('task-exec');
      await manager.createIteration('task-exec', 1);
      await manager.writeExecution('task-exec', 1, 'first run');
      await manager.writeExecution('task-exec', 1, 'second run');
      const read = await manager.readExecution('task-exec', 1);
      expect(read).toBe('second run');
    });

    it('should handle large content', async () => {
      const content = 'x'.repeat(100_000);
      await manager.initializeTask('task-exec');
      await manager.createIteration('task-exec', 1);
      await manager.writeExecution('task-exec', 1, content);
      const read = await manager.readExecution('task-exec', 1);
      expect(read).toBe(content);
      expect(read.length).toBe(100_000);
    });
  });

  // =========================================================================
  // writeStepResult
  // =========================================================================

  describe('writeStepResult', () => {
    it('should create step markdown file in steps directory', async () => {
      await manager.initializeTask('task-step');
      await manager.createIteration('task-step', 1);
      await manager.writeStepResult('task-step', 1, 1, '# Step 1\n\nDone.');
      const stepPath = path.join(manager.getStepsDir('task-step', 1), 'step-1.md');
      const content = await fs.readFile(stepPath, 'utf-8');
      expect(content).toBe('# Step 1\n\nDone.');
    });

    it('should create multiple step files for the same iteration', async () => {
      await manager.initializeTask('task-step');
      await manager.createIteration('task-step', 1);
      await manager.writeStepResult('task-step', 1, 1, 'step 1');
      await manager.writeStepResult('task-step', 1, 2, 'step 2');
      await manager.writeStepResult('task-step', 1, 3, 'step 3');
      const stepsDir = manager.getStepsDir('task-step', 1);
      const entries = await fs.readdir(stepsDir);
      expect(entries).toHaveLength(3);
      expect(entries.sort()).toEqual(['step-1.md', 'step-2.md', 'step-3.md']);
    });

    it('should handle step files with markdown content', async () => {
      const content = '## Output\n\n```json\n{"result": true}\n```';
      await manager.initializeTask('task-step');
      await manager.createIteration('task-step', 2);
      await manager.writeStepResult('task-step', 2, 5, content);
      const stepPath = path.join(manager.getStepsDir('task-step', 2), 'step-5.md');
      const read = await fs.readFile(stepPath, 'utf-8');
      expect(read).toBe(content);
    });
  });

  // =========================================================================
  // writeFinalSummary
  // =========================================================================

  describe('writeFinalSummary', () => {
    it('should create final-summary.md in iterations directory', async () => {
      const content = '# Final Summary\n\nTask completed successfully.';
      await manager.initializeTask('task-summary');
      await manager.writeFinalSummary('task-summary', content);
      const summaryPath = path.join(manager.getIterationsDir('task-summary'), 'final-summary.md');
      const read = await fs.readFile(summaryPath, 'utf-8');
      expect(read).toBe(content);
    });

    it('should overwrite existing final summary', async () => {
      await manager.initializeTask('task-summary');
      await manager.writeFinalSummary('task-summary', 'first');
      await manager.writeFinalSummary('task-summary', 'second');
      const summaryPath = path.join(manager.getIterationsDir('task-summary'), 'final-summary.md');
      const read = await fs.readFile(summaryPath, 'utf-8');
      expect(read).toBe('second');
    });
  });

  // =========================================================================
  // taskExists
  // =========================================================================

  describe('taskExists', () => {
    it('should return true when task directory exists', async () => {
      await manager.initializeTask('existing-task');
      const exists = await manager.taskExists('existing-task');
      expect(exists).toBe(true);
    });

    it('should return false when task directory does not exist', async () => {
      const exists = await manager.taskExists('nonexistent-task');
      expect(exists).toBe(false);
    });

    it('should return false after cleanup', async () => {
      await manager.initializeTask('temp-task');
      await manager.cleanupTask('temp-task');
      const exists = await manager.taskExists('temp-task');
      expect(exists).toBe(false);
    });
  });

  // =========================================================================
  // hasEvaluation / hasExecution / hasFinalResult
  // =========================================================================

  describe('hasEvaluation', () => {
    it('should return true when evaluation.md exists', async () => {
      await manager.initializeTask('task-he');
      await manager.createIteration('task-he', 1);
      await manager.writeEvaluation('task-he', 1, 'content');
      expect(await manager.hasEvaluation('task-he', 1)).toBe(true);
    });

    it('should return false when evaluation.md does not exist', async () => {
      await manager.initializeTask('task-he');
      await manager.createIteration('task-he', 1);
      expect(await manager.hasEvaluation('task-he', 1)).toBe(false);
    });
  });

  describe('hasExecution', () => {
    it('should return true when execution.md exists', async () => {
      await manager.initializeTask('task-hx');
      await manager.createIteration('task-hx', 1);
      await manager.writeExecution('task-hx', 1, 'content');
      expect(await manager.hasExecution('task-hx', 1)).toBe(true);
    });

    it('should return false when execution.md does not exist', async () => {
      await manager.initializeTask('task-hx');
      await manager.createIteration('task-hx', 1);
      expect(await manager.hasExecution('task-hx', 1)).toBe(false);
    });
  });

  describe('hasFinalResult', () => {
    it('should return true when final_result.md exists', async () => {
      await manager.initializeTask('task-hfr');
      const finalResultPath = manager.getFinalResultPath('task-hfr');
      await fs.writeFile(finalResultPath, 'done', 'utf-8');
      expect(await manager.hasFinalResult('task-hfr')).toBe(true);
    });

    it('should return false when final_result.md does not exist', async () => {
      await manager.initializeTask('task-hfr');
      expect(await manager.hasFinalResult('task-hfr')).toBe(false);
    });
  });

  // =========================================================================
  // listIterations
  // =========================================================================

  describe('listIterations', () => {
    it('should return empty array when no iterations exist', async () => {
      await manager.initializeTask('task-li');
      const iterations = await manager.listIterations('task-li');
      expect(iterations).toEqual([]);
    });

    it('should list single iteration', async () => {
      await manager.initializeTask('task-li');
      await manager.createIteration('task-li', 1);
      const iterations = await manager.listIterations('task-li');
      expect(iterations).toEqual([1]);
    });

    it('should list multiple iterations sorted numerically', async () => {
      await manager.initializeTask('task-li');
      await manager.createIteration('task-li', 3);
      await manager.createIteration('task-li', 1);
      await manager.createIteration('task-li', 2);
      const iterations = await manager.listIterations('task-li');
      expect(iterations).toEqual([1, 2, 3]);
    });

    it('should ignore non-iter directories', async () => {
      await manager.initializeTask('task-li');
      await manager.createIteration('task-li', 1);
      // Create a non-iteration directory
      await fs.mkdir(path.join(manager.getIterationsDir('task-li'), 'notes'));
      const iterations = await manager.listIterations('task-li');
      expect(iterations).toEqual([1]);
    });

    it('should ignore files in iterations directory', async () => {
      await manager.initializeTask('task-li');
      await manager.createIteration('task-li', 1);
      // Create a file in iterations dir
      await fs.writeFile(path.join(manager.getIterationsDir('task-li'), 'summary.md'), 'text');
      const iterations = await manager.listIterations('task-li');
      expect(iterations).toEqual([1]);
    });

    it('should return empty array when iterations directory does not exist', async () => {
      // Do not initialize - iterations dir won't exist
      const iterations = await manager.listIterations('nonexistent-task');
      expect(iterations).toEqual([]);
    });

    it('should handle gap in iteration numbers', async () => {
      await manager.initializeTask('task-li');
      await manager.createIteration('task-li', 1);
      await manager.createIteration('task-li', 5);
      await manager.createIteration('task-li', 10);
      const iterations = await manager.listIterations('task-li');
      expect(iterations).toEqual([1, 5, 10]);
    });
  });

  // =========================================================================
  // getTaskStats
  // =========================================================================

  describe('getTaskStats', () => {
    it('should return zero iterations and no final summary for new task', async () => {
      await manager.initializeTask('task-stats');
      const stats = await manager.getTaskStats('task-stats');
      expect(stats.totalIterations).toBe(0);
      expect(stats.hasFinalSummary).toBe(false);
    });

    it('should count iterations correctly', async () => {
      await manager.initializeTask('task-stats');
      await manager.createIteration('task-stats', 1);
      await manager.createIteration('task-stats', 2);
      await manager.createIteration('task-stats', 3);
      const stats = await manager.getTaskStats('task-stats');
      expect(stats.totalIterations).toBe(3);
    });

    it('should detect presence of final summary', async () => {
      await manager.initializeTask('task-stats');
      await manager.createIteration('task-stats', 1);
      await manager.writeFinalSummary('task-stats', '# Summary');
      const stats = await manager.getTaskStats('task-stats');
      expect(stats.hasFinalSummary).toBe(true);
      expect(stats.totalIterations).toBe(1);
    });

    it('should return false for hasFinalSummary when not written', async () => {
      await manager.initializeTask('task-stats');
      await manager.createIteration('task-stats', 1);
      const stats = await manager.getTaskStats('task-stats');
      expect(stats.hasFinalSummary).toBe(false);
    });

    it('should handle non-existent task gracefully', async () => {
      const stats = await manager.getTaskStats('nonexistent-task');
      expect(stats.totalIterations).toBe(0);
      expect(stats.hasFinalSummary).toBe(false);
    });
  });

  // =========================================================================
  // cleanupTask
  // =========================================================================

  describe('cleanupTask', () => {
    it('should remove task directory and all contents', async () => {
      await manager.initializeTask('task-cleanup');
      await manager.createIteration('task-cleanup', 1);
      await manager.writeTaskSpec('task-cleanup', 'spec');
      await manager.writeEvaluation('task-cleanup', 1, 'eval');
      await manager.writeExecution('task-cleanup', 1, 'exec');

      await manager.cleanupTask('task-cleanup');

      expect(await manager.taskExists('task-cleanup')).toBe(false);
    });

    it('should not throw when cleaning up non-existent task', async () => {
      await expect(manager.cleanupTask('nonexistent-task')).resolves.not.toThrow();
    });

    it('should not affect other tasks', async () => {
      await manager.initializeTask('task-a');
      await manager.initializeTask('task-b');
      await manager.writeTaskSpec('task-a', 'spec-a');
      await manager.writeTaskSpec('task-b', 'spec-b');

      await manager.cleanupTask('task-a');

      expect(await manager.taskExists('task-a')).toBe(false);
      expect(await manager.taskExists('task-b')).toBe(true);
      const specB = await manager.readTaskSpec('task-b');
      expect(specB).toBe('spec-b');
    });
  });

  // =========================================================================
  // Error handling: reading from non-existent files
  // =========================================================================

  describe('error handling', () => {
    it('readTaskSpec should throw when task spec does not exist', async () => {
      await manager.initializeTask('task-err');
      await expect(manager.readTaskSpec('task-err')).rejects.toThrow();
    });

    it('readEvaluation should throw when evaluation does not exist', async () => {
      await manager.initializeTask('task-err');
      await manager.createIteration('task-err', 1);
      await expect(manager.readEvaluation('task-err', 1)).rejects.toThrow();
    });

    it('readExecution should throw when execution does not exist', async () => {
      await manager.initializeTask('task-err');
      await manager.createIteration('task-err', 1);
      await expect(manager.readExecution('task-err', 1)).rejects.toThrow();
    });

    it('writeTaskSpec should throw when task directory does not exist', async () => {
      // Task directory is never created, so writing should fail
      await expect(manager.writeTaskSpec('no-such-task', 'content')).rejects.toThrow();
    });
  });

  // =========================================================================
  // End-to-end workflow
  // =========================================================================

  describe('end-to-end workflow', () => {
    it('should support full task lifecycle', async () => {
      const taskId = 'e2e-task';

      // Initialize
      await manager.initializeTask(taskId);
      expect(await manager.taskExists(taskId)).toBe(true);

      // Write spec
      const spec = '# Task\n\nBuild something.';
      await manager.writeTaskSpec(taskId, spec);
      expect(await manager.readTaskSpec(taskId)).toBe(spec);

      // Iteration 1
      await manager.createIteration(taskId, 1);
      await manager.writeExecution(taskId, 1, '# Exec 1\n\nAttempt 1');
      await manager.writeEvaluation(taskId, 1, '# Eval 1\n\nNeeds improvement');
      await manager.writeStepResult(taskId, 1, 1, 'Step 1 result');

      // Iteration 2
      await manager.createIteration(taskId, 2);
      await manager.writeExecution(taskId, 2, '# Exec 2\n\nAttempt 2');
      await manager.writeEvaluation(taskId, 2, '# Eval 2\n\nPassed');

      // Write final summary
      await manager.writeFinalSummary(taskId, '# Final Summary\n\nAll done.');

      // Check stats
      const stats = await manager.getTaskStats(taskId);
      expect(stats.totalIterations).toBe(2);
      expect(stats.hasFinalSummary).toBe(true);

      // List iterations
      const iterations = await manager.listIterations(taskId);
      expect(iterations).toEqual([1, 2]);

      // Check existence
      expect(await manager.hasExecution(taskId, 1)).toBe(true);
      expect(await manager.hasEvaluation(taskId, 1)).toBe(true);
      expect(await manager.hasExecution(taskId, 2)).toBe(true);

      // Cleanup
      await manager.cleanupTask(taskId);
      expect(await manager.taskExists(taskId)).toBe(false);
    });
  });
});
