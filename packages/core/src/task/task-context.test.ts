/**
 * Tests for TaskContext.
 *
 * Verifies shared task state management for progress reporting.
 * Covers: creation, step management, status transitions,
 * markdown serialization/round-trip, and reporting heuristics.
 *
 * Issue #857: Phase 1 — TaskContext + Reporter Agent infrastructure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskContext } from './task-context.js';

let tempDir: string;
let taskDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
  taskDir = path.join(tempDir, 'tasks', 'test-task-001');
  await fs.mkdir(taskDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskContext', () => {
  describe('constructor', () => {
    it('should create context with correct initial state', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Fix bug in parser');
      const data = ctx.getData();

      expect(data.taskId).toBe('task-001');
      expect(data.chatId).toBe('chat-001');
      expect(data.description).toBe('Fix bug in parser');
      expect(data.status).toBe('pending');
      expect(data.startedAt).toBeNull();
      expect(data.completedAt).toBeNull();
      expect(data.steps).toEqual([]);
      expect(data.errors).toEqual([]);
      expect(data.totalStepsPlanned).toBeNull();
      expect(data.metadata).toEqual({});
    });
  });

  describe('static create', () => {
    it('should create new context when no file exists', async () => {
      const ctx = await TaskContext.create(taskDir, 'task-001', 'chat-001', 'Test task');
      expect(ctx.getData().taskId).toBe('task-001');
    });

    it('should load existing context from disk', async () => {
      // Create and save initial context
      const ctx1 = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test task');
      ctx1.start();
      ctx1.addStep('step-1');
      ctx1.startStep('step-1');
      ctx1.completeStep('step-1', 'Done');
      await ctx1.save();

      // Load from disk
      const ctx2 = await TaskContext.create(taskDir, 'task-001', 'chat-001', 'Test task');
      const data = ctx2.getData();

      expect(data.status).toBe('running');
      expect(data.steps).toHaveLength(1);
      expect(data.steps[0].name).toBe('step-1');
      expect(data.steps[0].status).toBe('completed');
      expect(data.steps[0].result).toBe('Done');
    });
  });

  describe('status transitions', () => {
    it('should transition from pending to running', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      expect(ctx.getStatus()).toBe('pending');

      ctx.start();
      expect(ctx.getStatus()).toBe('running');
      expect(ctx.getData().startedAt).not.toBeNull();
    });

    it('should transition to completed', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.start();
      ctx.complete();

      expect(ctx.getStatus()).toBe('completed');
      expect(ctx.getData().completedAt).not.toBeNull();
    });

    it('should transition to failed with error', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.start();
      ctx.fail('Something went wrong');

      expect(ctx.getStatus()).toBe('failed');
      expect(ctx.getData().completedAt).not.toBeNull();
      expect(ctx.getData().errors).toHaveLength(1);
      expect(ctx.getData().errors[0].message).toBe('Something went wrong');
    });
  });

  describe('step management', () => {
    it('should add steps', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.addStep('analyze');
      ctx.addStep('implement');
      ctx.addStep('test');

      expect(ctx.getTotalStepCount()).toBe(3);
      expect(ctx.getCompletedStepCount()).toBe(0);
    });

    it('should not add duplicate steps', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.addStep('analyze');
      ctx.addStep('analyze');

      expect(ctx.getTotalStepCount()).toBe(1);
    });

    it('should track step lifecycle', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.addStep('analyze');

      const [stepBefore] = ctx.getData().steps;
      expect(stepBefore.status).toBe('pending');
      expect(stepBefore.startedAt).toBeNull();

      ctx.startStep('analyze');
      const [stepInProgress] = ctx.getData().steps;
      expect(stepInProgress.status).toBe('in_progress');
      expect(stepInProgress.startedAt).not.toBeNull();

      ctx.completeStep('analyze', 'Found root cause');
      const [stepCompleted] = ctx.getData().steps;
      expect(stepCompleted.status).toBe('completed');
      expect(stepCompleted.completedAt).not.toBeNull();
      expect(stepCompleted.result).toBe('Found root cause');
    });

    it('should track step failure', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.addStep('deploy');
      ctx.startStep('deploy');
      ctx.failStep('deploy', 'Connection refused');

      const [step] = ctx.getData().steps;
      expect(step.status).toBe('failed');
      expect(step.error).toBe('Connection refused');
      expect(step.completedAt).not.toBeNull();
      expect(ctx.getData().errors).toHaveLength(1);
      expect(ctx.getData().errors[0].step).toBe('deploy');
    });

    it('should handle unknown step gracefully', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      // These should not throw
      ctx.startStep('nonexistent');
      ctx.completeStep('nonexistent', 'result');
      ctx.failStep('nonexistent', 'error');
    });
  });

  describe('planned steps', () => {
    it('should set total planned steps', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.setTotalStepsPlanned(5);
      expect(ctx.getData().totalStepsPlanned).toBe(5);
    });
  });

  describe('metadata', () => {
    it('should store and retrieve metadata', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.setMetadata('priority', 'high');
      ctx.setMetadata('source', 'user-request');

      expect(ctx.getData().metadata.priority).toBe('high');
      expect(ctx.getData().metadata.source).toBe('user-request');
    });
  });

  describe('elapsed time', () => {
    it('should return null before task starts', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      expect(ctx.getElapsedTimeSeconds()).toBeNull();
    });

    it('should return elapsed time after task starts', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.start();
      const elapsed = ctx.getElapsedTimeSeconds();
      expect(elapsed).not.toBeNull();
      expect(elapsed!).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getData immutability', () => {
    it('should return a copy, not a reference', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.addStep('step-1');
      const data1 = ctx.getData();
      const data2 = ctx.getData();

      // Mutating the returned data should not affect the context
      data1.steps.push({ name: 'fake', status: 'pending', startedAt: null, completedAt: null, result: null, error: null });
      expect(data2.steps).toHaveLength(1);
    });
  });

  describe('markdown serialization', () => {
    it('should produce valid markdown with human-readable format', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Fix bug');
      ctx.start();
      ctx.addStep('analyze');
      ctx.startStep('analyze');
      ctx.completeStep('analyze', 'Found issue');
      ctx.addStep('fix');

      const md = ctx.toMarkdown();
      expect(md).toContain('# Task Context: Fix bug');
      expect(md).toContain('**Task ID**: task-001');
      expect(md).toContain('**Status**: running');
      expect(md).toContain('analyze');
      expect(md).toContain('Found issue');
      expect(md).toContain('fix');
    });

    it('should include embedded JSON for reliable parsing', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      const md = ctx.toMarkdown();
      expect(md).toContain('<!-- TASK_CONTEXT_JSON');
      expect(md).toContain('-->');
    });
  });

  describe('round-trip: save and load', () => {
    it('should preserve all data through save/load cycle', async () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Complex task');
      ctx.start();
      ctx.setTotalStepsPlanned(3);
      ctx.addStep('analyze');
      ctx.startStep('analyze');
      ctx.completeStep('analyze', 'Root cause found');
      ctx.addStep('implement');
      ctx.startStep('implement');
      ctx.failStep('implement', 'Build failed');
      ctx.setMetadata('priority', 'critical');

      await ctx.save();

      // Parse from disk
      const loaded = await TaskContext.create(taskDir, 'task-001', 'chat-001', 'Complex task');
      const data = loaded.getData();

      expect(data.taskId).toBe('task-001');
      expect(data.chatId).toBe('chat-001');
      expect(data.status).toBe('running');
      expect(data.description).toBe('Complex task');
      expect(data.totalStepsPlanned).toBe(3);
      expect(data.steps).toHaveLength(2);
      expect(data.steps[0].name).toBe('analyze');
      expect(data.steps[0].status).toBe('completed');
      expect(data.steps[0].result).toBe('Root cause found');
      expect(data.steps[1].name).toBe('implement');
      expect(data.steps[1].status).toBe('failed');
      expect(data.steps[1].error).toBe('Build failed');
      expect(data.errors).toHaveLength(1);
      expect(data.errors[0].step).toBe('implement');
      expect(data.metadata.priority).toBe('critical');
    });
  });

  describe('shouldConsiderReporting', () => {
    it('should not report when pending', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      expect(ctx.shouldConsiderReporting()).toBe(false);
    });

    it('should consider reporting when running with completed steps', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.start();
      ctx.addStep('step-1');
      ctx.startStep('step-1');
      ctx.completeStep('step-1');
      expect(ctx.shouldConsiderReporting()).toBe(true);
    });

    it('should consider reporting when there are errors', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.start();
      ctx.addStep('step-1');
      ctx.failStep('step-1', 'Error');
      expect(ctx.shouldConsiderReporting()).toBe(true);
    });
  });

  describe('saveSync', () => {
    it('should save synchronously', () => {
      const ctx = new TaskContext(taskDir, 'task-001', 'chat-001', 'Test');
      ctx.start();
      ctx.addStep('step-1');
      ctx.saveSync();

      // Verify file was written
      const fsSync = require('node:fs');
      const content = fsSync.readFileSync(path.join(taskDir, 'task-context.md'), 'utf-8');
      expect(content).toContain('task-001');
      expect(content).toContain('running');
    });
  });
});
