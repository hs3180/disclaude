/**
 * Unit tests for TaskContext
 *
 * @see https://github.com/hs3180/disclaude/issues/857
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TaskContext } from './task-context.js';

describe('TaskContext', () => {
  let tmpDir: string;
  let ctx: TaskContext;
  let tasksDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
    tasksDir = path.join(tmpDir, 'tasks');
    await fs.mkdir(tasksDir);
    ctx = new TaskContext(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create instance with workspace directory', () => {
      expect(ctx).toBeDefined();
    });
  });

  describe('getProgressPath', () => {
    it('should return correct path for a task ID', () => {
      const result = ctx.getProgressPath('task-123');
      expect(result).toContain('tasks');
      expect(result).toContain('task-123');
      expect(result).toContain('progress.json');
    });

    it('should sanitize task IDs with special characters', () => {
      const result = ctx.getProgressPath('om_abc.def@ghi');
      // Check the task directory part (before progress.json) is sanitized
      const dirPart = path.dirname(result);
      const taskDirName = path.basename(dirPart);
      expect(taskDirName).not.toContain('.');
      expect(taskDirName).not.toContain('@');
    });
  });

  describe('initializeProgress', () => {
    it('should create progress.json with initial state', async () => {
      await ctx.initializeProgress('task-1', 10);

      const progress = await ctx.readProgress('task-1');
      expect(progress.taskId).toBe('task-1');
      expect(progress.status).toBe('running');
      expect(progress.currentPhase).toBe('idle');
      expect(progress.currentIteration).toBe(0);
      expect(progress.completedIterations).toBe(0);
      expect(progress.maxIterations).toBe(10);
      expect(progress.currentStep).toBe('Task initialized, waiting for evaluation');
      expect(progress.filesModified).toEqual([]);
      expect(progress.startedAt).toBeDefined();
      expect(progress.lastUpdatedAt).toBeDefined();
    });

    it('should use default maxIterations when not specified', async () => {
      await ctx.initializeProgress('task-2');

      const progress = await ctx.readProgress('task-2');
      expect(progress.maxIterations).toBe(10);
    });
  });

  describe('hasProgress', () => {
    it('should return false when progress.json does not exist', async () => {
      expect(await ctx.hasProgress('nonexistent')).toBe(false);
    });

    it('should return true when progress.json exists', async () => {
      await ctx.initializeProgress('task-1');
      expect(await ctx.hasProgress('task-1')).toBe(true);
    });
  });

  describe('readProgress', () => {
    it('should read progress from file', async () => {
      await ctx.initializeProgress('task-1', 5);

      const progress = await ctx.readProgress('task-1');
      expect(progress.taskId).toBe('task-1');
      expect(progress.maxIterations).toBe(5);
    });

    it('should throw error when progress.json does not exist', async () => {
      await expect(ctx.readProgress('nonexistent')).rejects.toThrow(
        'Progress not found for task nonexistent'
      );
    });
  });

  describe('updateProgress', () => {
    it('should merge updates with existing progress', async () => {
      await ctx.initializeProgress('task-1', 10);
      await ctx.updateProgress('task-1', {
        currentPhase: 'evaluating',
        currentStep: 'Checking test coverage',
      });

      const progress = await ctx.readProgress('task-1');
      expect(progress.currentPhase).toBe('evaluating');
      expect(progress.currentStep).toBe('Checking test coverage');
      // Original fields should be preserved
      expect(progress.taskId).toBe('task-1');
      expect(progress.maxIterations).toBe(10);
    });

    it('should update lastUpdatedAt timestamp', async () => {
      await ctx.initializeProgress('task-1');
      const before = (await ctx.readProgress('task-1')).lastUpdatedAt;

      // Small delay to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));
      await ctx.updateProgress('task-1', { currentPhase: 'executing' });

      const after = (await ctx.readProgress('task-1')).lastUpdatedAt;
      expect(after).not.toBe(before);
    });

    it('should create progress with defaults if no existing file', async () => {
      await ctx.updateProgress('new-task', {
        status: 'running',
        currentPhase: 'executing',
        currentStep: 'Doing work',
      });

      const progress = await ctx.readProgress('new-task');
      expect(progress.status).toBe('running');
      expect(progress.currentPhase).toBe('executing');
      expect(progress.currentStep).toBe('Doing work');
    });
  });

  describe('setPhase', () => {
    it('should update phase and step', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.setPhase('task-1', 'executing', 'Building auth module');

      const progress = await ctx.readProgress('task-1');
      expect(progress.currentPhase).toBe('executing');
      expect(progress.currentStep).toBe('Building auth module');
    });
  });

  describe('startIteration', () => {
    it('should set current iteration and step', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.startIteration('task-1', 3);

      const progress = await ctx.readProgress('task-1');
      expect(progress.currentIteration).toBe(3);
      expect(progress.currentStep).toBe('Starting iteration 3');
    });
  });

  describe('completeIteration', () => {
    it('should increment completedIterations', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.completeIteration('task-1', 'NEED_EXECUTE');

      const progress = await ctx.readProgress('task-1');
      expect(progress.completedIterations).toBe(1);
      expect(progress.lastEvaluationStatus).toBe('NEED_EXECUTE');
    });

    it('should accumulate across multiple calls', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.completeIteration('task-1', 'NEED_EXECUTE');
      await ctx.completeIteration('task-1', 'NEED_EXECUTE');
      await ctx.completeIteration('task-1', 'COMPLETE');

      const progress = await ctx.readProgress('task-1');
      expect(progress.completedIterations).toBe(3);
      expect(progress.lastEvaluationStatus).toBe('COMPLETE');
    });
  });

  describe('addModifiedFiles', () => {
    it('should add files to the tracking list', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.addModifiedFiles('task-1', ['src/auth.ts', 'src/auth.test.ts']);

      const progress = await ctx.readProgress('task-1');
      expect(progress.filesModified).toEqual(['src/auth.ts', 'src/auth.test.ts']);
    });

    it('should deduplicate files', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.addModifiedFiles('task-1', ['src/auth.ts']);
      await ctx.addModifiedFiles('task-1', ['src/auth.ts', 'src/utils.ts']);

      const progress = await ctx.readProgress('task-1');
      expect(progress.filesModified).toEqual(['src/auth.ts', 'src/utils.ts']);
    });
  });

  describe('completeTask', () => {
    it('should mark task as completed', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.completeTask('task-1', 'All tests passing');

      const progress = await ctx.readProgress('task-1');
      expect(progress.status).toBe('completed');
      expect(progress.currentPhase).toBe('reporting');
      expect(progress.currentStep).toBe('All tests passing');
      expect(progress.completedAt).toBeDefined();
    });

    it('should use default summary if not provided', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.completeTask('task-1');

      const progress = await ctx.readProgress('task-1');
      expect(progress.currentStep).toBe('Task completed successfully');
    });
  });

  describe('failTask', () => {
    it('should mark task as failed with error', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.failTask('task-1', 'Build failed with type errors');

      const progress = await ctx.readProgress('task-1');
      expect(progress.status).toBe('failed');
      expect(progress.error).toBe('Build failed with type errors');
      expect(progress.completedAt).toBeDefined();
    });
  });

  describe('getProgressSummary', () => {
    it('should return formatted summary', async () => {
      await ctx.initializeProgress('task-1', 10);
      await ctx.startIteration('task-1', 2);
      await ctx.setPhase('task-1', 'executing', 'Building auth module');

      const summary = await ctx.getProgressSummary('task-1');
      expect(summary).toContain('Running');
      expect(summary).toContain('Executing');
      expect(summary).toContain('2');
      expect(summary).toContain('Building auth module');
    });

    it('should include error when failed', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.failTask('task-1', 'Test failure');

      const summary = await ctx.getProgressSummary('task-1');
      expect(summary).toContain('Failed');
      expect(summary).toContain('Test failure');
    });
  });

  describe('listTrackedTasks', () => {
    it('should list tasks with progress files', async () => {
      await ctx.initializeProgress('task-1');
      await ctx.initializeProgress('task-2');

      const tracked = await ctx.listTrackedTasks();
      expect(tracked).toHaveLength(2);
      expect(tracked).toContain('task-1');
      expect(tracked).toContain('task-2');
    });

    it('should not list tasks without progress files', async () => {
      // Create a task directory without progress.json
      await fs.mkdir(path.join(tasksDir, 'task-no-progress'));

      const tracked = await ctx.listTrackedTasks();
      expect(tracked).toHaveLength(0);
    });

    it('should return empty array for nonexistent tasks dir', async () => {
      const emptyCtx = new TaskContext('/nonexistent/path');
      const tracked = await emptyCtx.listTrackedTasks();
      expect(tracked).toEqual([]);
    });
  });

  describe('getRunningTasksProgress', () => {
    it('should return only running tasks', async () => {
      await ctx.initializeProgress('task-running');
      await ctx.initializeProgress('task-completed');
      await ctx.completeTask('task-completed');

      const running = await ctx.getRunningTasksProgress();
      expect(running).toHaveLength(1);
      expect(running[0].taskId).toBe('task-running');
    });

    it('should return empty array when no tasks are running', async () => {
      const running = await ctx.getRunningTasksProgress();
      expect(running).toEqual([]);
    });
  });

  describe('removeProgress', () => {
    it('should remove progress.json', async () => {
      await ctx.initializeProgress('task-1');
      expect(await ctx.hasProgress('task-1')).toBe(true);

      await ctx.removeProgress('task-1');
      expect(await ctx.hasProgress('task-1')).toBe(false);
    });

    it('should not throw when progress.json does not exist', async () => {
      await expect(ctx.removeProgress('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('full workflow', () => {
    it('should track complete task lifecycle', async () => {
      // Initialize
      await ctx.initializeProgress('workflow-task', 5);

      // Iteration 1: evaluate → execute → evaluate
      await ctx.startIteration('workflow-task', 1);
      await ctx.setPhase('workflow-task', 'evaluating', 'First evaluation');
      await ctx.setPhase('workflow-task', 'executing', 'Implementing feature');
      await ctx.addModifiedFiles('workflow-task', ['src/feature.ts']);
      await ctx.completeIteration('workflow-task', 'NEED_EXECUTE');

      // Iteration 2: evaluate → complete
      await ctx.startIteration('workflow-task', 2);
      await ctx.setPhase('workflow-task', 'evaluating', 'Second evaluation');
      await ctx.completeIteration('workflow-task', 'COMPLETE');

      // Complete
      await ctx.completeTask('workflow-task', 'Feature implemented successfully');

      // Verify final state
      const progress = await ctx.readProgress('workflow-task');
      expect(progress.status).toBe('completed');
      expect(progress.completedIterations).toBe(2);
      expect(progress.currentIteration).toBe(2);
      expect(progress.filesModified).toEqual(['src/feature.ts']);
      expect(progress.lastEvaluationStatus).toBe('COMPLETE');
      expect(progress.completedAt).toBeDefined();
    });
  });
});
