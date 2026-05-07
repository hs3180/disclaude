/**
 * Tests for TaskContextManager.
 *
 * Verifies TaskContext creation, updates, queries, and metrics tracking
 * for the deep task progress reporting feature (Issue #857).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskContextManager } from './task-context-manager.js';
import type { TaskContext } from './task-context.js';

let tempDir: string;
let manager: TaskContextManager;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
  manager = new TaskContextManager({ workspaceDir: tempDir });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskContextManager', () => {
  describe('createContext', () => {
    it('should create a TaskContext with default values', async () => {
      const context = await manager.createContext({
        taskId: 'test-task-1',
        chatId: 'oc_chat123',
        title: 'Fix login bug',
        description: 'Fix the authentication timeout issue',
      });

      expect(context.version).toBe(1);
      expect(context.taskId).toBe('test-task-1');
      expect(context.chatId).toBe('oc_chat123');
      expect(context.title).toBe('Fix login bug');
      expect(context.status).toBe('pending');
      expect(context.phase).toBe('definition');
      expect(context.startedAt).toBeNull();
      expect(context.completedAt).toBeNull();
      expect(context.currentIteration).toBe(0);
      expect(context.totalIterations).toBe(0);
      expect(context.currentStep).toBeNull();
      expect(context.completedSteps).toEqual([]);
      expect(context.plannedSteps).toEqual([]);
      expect(context.metrics).toEqual({
        filesModified: 0,
        testsRun: 0,
        testsPassed: 0,
        toolsInvoked: 0,
      });
      expect(context.error).toBeNull();
    });

    it('should write task-context.json to the task directory', async () => {
      await manager.createContext({
        taskId: 'test-task-2',
        chatId: 'oc_chat123',
        title: 'Some task',
        description: 'Some description',
      });

      const contextPath = manager.getContextPath('test-task-2');
      const raw = await fs.readFile(contextPath, 'utf-8');
      const parsed = JSON.parse(raw);

      expect(parsed.taskId).toBe('test-task-2');
      expect(parsed.version).toBe(1);
    });

    it('should sanitize task ID in context path', () => {
      const contextPath = manager.getContextPath('msg/with/slashes');
      expect(contextPath).not.toContain('msg/with/slashes');
      expect(contextPath).toContain('msg_with_slashes');
    });
  });

  describe('updateContext', () => {
    it('should update status and phase', async () => {
      await manager.createContext({
        taskId: 'test-task-3',
        chatId: 'oc_chat123',
        title: 'Test task',
        description: 'Test',
      });

      const updated = await manager.updateContext('test-task-3', {
        status: 'running',
        phase: 'execution',
        currentStep: 'Analyzing codebase',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('running');
      expect(updated!.phase).toBe('execution');
      expect(updated!.currentStep).toBe('Analyzing codebase');
      expect(updated!.startedAt).not.toBeNull();
    });

    it('should auto-set startedAt when status becomes running', async () => {
      await manager.createContext({
        taskId: 'test-task-4',
        chatId: 'oc_chat123',
        title: 'Test task',
        description: 'Test',
      });

      const updated = await manager.updateContext('test-task-4', {
        status: 'running',
      });

      expect(updated!.startedAt).not.toBeNull();
    });

    it('should auto-set completedAt and phase when completed', async () => {
      await manager.createContext({
        taskId: 'test-task-5',
        chatId: 'oc_chat123',
        title: 'Test task',
        description: 'Test',
      });

      const updated = await manager.updateContext('test-task-5', {
        status: 'completed',
      });

      expect(updated!.completedAt).not.toBeNull();
      expect(updated!.phase).toBe('completed');
      expect(updated!.currentStep).toBeNull();
    });

    it('should auto-set completedAt and phase when failed', async () => {
      await manager.createContext({
        taskId: 'test-task-6',
        chatId: 'oc_chat123',
        title: 'Test task',
        description: 'Test',
      });

      const updated = await manager.updateContext('test-task-6', {
        status: 'failed',
        error: 'Test timeout exceeded',
      });

      expect(updated!.completedAt).not.toBeNull();
      expect(updated!.phase).toBe('failed');
      expect(updated!.error).toBe('Test timeout exceeded');
    });

    it('should record completed steps when currentStep changes', async () => {
      await manager.createContext({
        taskId: 'test-task-7',
        chatId: 'oc_chat123',
        title: 'Test task',
        description: 'Test',
      });

      // Start with a step
      await manager.updateContext('test-task-7', {
        status: 'running',
        currentStep: 'Step 1: Analyzing',
      });

      // Move to next step — previous step should be recorded
      const updated = await manager.updateContext('test-task-7', {
        currentStep: 'Step 2: Implementing',
      });

      expect(updated!.completedSteps).toHaveLength(1);
      expect(updated!.completedSteps[0].description).toBe('Step 1: Analyzing');
      expect(updated!.completedSteps[0].status).toBe('completed');
    });

    it('should merge metrics updates', async () => {
      await manager.createContext({
        taskId: 'test-task-8',
        chatId: 'oc_chat123',
        title: 'Test task',
        description: 'Test',
      });

      const updated = await manager.updateContext('test-task-8', {
        metrics: { filesModified: 3, testsRun: 10 },
      });

      expect(updated!.metrics.filesModified).toBe(3);
      expect(updated!.metrics.testsRun).toBe(10);
      expect(updated!.metrics.testsPassed).toBe(0); // unchanged
    });

    it('should return null for non-existent task', async () => {
      const result = await manager.updateContext('non-existent', {
        status: 'running',
      });

      expect(result).toBeNull();
    });
  });

  describe('startIteration', () => {
    it('should increment iteration count and update phase', async () => {
      await manager.createContext({
        taskId: 'test-iter',
        chatId: 'oc_chat123',
        title: 'Iteration test',
        description: 'Test',
      });

      const ctx1 = await manager.startIteration('test-iter', 'evaluation');
      expect(ctx1!.currentIteration).toBe(1);
      expect(ctx1!.totalIterations).toBe(1);
      expect(ctx1!.phase).toBe('evaluation');

      const ctx2 = await manager.startIteration('test-iter', 'execution');
      expect(ctx2!.currentIteration).toBe(2);
      expect(ctx2!.totalIterations).toBe(2);
      expect(ctx2!.phase).toBe('execution');
    });
  });

  describe('recordStep', () => {
    it('should record a completed step', async () => {
      await manager.createContext({
        taskId: 'test-step',
        chatId: 'oc_chat123',
        title: 'Step test',
        description: 'Test',
      });

      await manager.recordStep('test-step', 'Read source files');
      await manager.recordStep('test-step', 'Write tests', 'completed');

      const ctx = await manager.getContext('test-step');
      expect(ctx!.completedSteps).toHaveLength(2);
      expect(ctx!.completedSteps[0].description).toBe('Read source files');
      expect(ctx!.completedSteps[0].status).toBe('completed');
      expect(ctx!.completedSteps[1].description).toBe('Write tests');
    });

    it('should record a failed step', async () => {
      await manager.createContext({
        taskId: 'test-fail-step',
        chatId: 'oc_chat123',
        title: 'Step test',
        description: 'Test',
      });

      await manager.recordStep('test-fail-step', 'Run integration tests', 'failed');

      const ctx = await manager.getContext('test-fail-step');
      expect(ctx!.completedSteps).toHaveLength(1);
      expect(ctx!.completedSteps[0].status).toBe('failed');
    });
  });

  describe('incrementMetrics', () => {
    it('should increment individual metrics', async () => {
      await manager.createContext({
        taskId: 'test-metrics',
        chatId: 'oc_chat123',
        title: 'Metrics test',
        description: 'Test',
      });

      await manager.incrementMetrics('test-metrics', { filesModified: 1 });
      await manager.incrementMetrics('test-metrics', { filesModified: 2, testsRun: 5, testsPassed: 4 });

      const ctx = await manager.getContext('test-metrics');
      expect(ctx!.metrics.filesModified).toBe(3);
      expect(ctx!.metrics.testsRun).toBe(5);
      expect(ctx!.metrics.testsPassed).toBe(4);
    });
  });

  describe('getContext', () => {
    it('should return null for non-existent task', async () => {
      const ctx = await manager.getContext('non-existent');
      expect(ctx).toBeNull();
    });

    it('should return context for existing task', async () => {
      await manager.createContext({
        taskId: 'test-get',
        chatId: 'oc_chat123',
        title: 'Get test',
        description: 'Test',
      });

      const ctx = await manager.getContext('test-get');
      expect(ctx).not.toBeNull();
      expect(ctx!.taskId).toBe('test-get');
    });
  });

  describe('listContexts and listActiveTasks', () => {
    it('should list all contexts', async () => {
      await manager.createContext({
        taskId: 'task-1',
        chatId: 'oc_chat123',
        title: 'Task 1',
        description: 'Test',
      });
      await manager.createContext({
        taskId: 'task-2',
        chatId: 'oc_chat123',
        title: 'Task 2',
        description: 'Test',
      });

      const all = await manager.listContexts();
      expect(all).toHaveLength(2);
    });

    it('should filter by status', async () => {
      await manager.createContext({
        taskId: 'pending-task',
        chatId: 'oc_chat123',
        title: 'Pending',
        description: 'Test',
      });
      await manager.createContext({
        taskId: 'running-task',
        chatId: 'oc_chat123',
        title: 'Running',
        description: 'Test',
      });
      await manager.updateContext('running-task', { status: 'running' });

      const running = await manager.listContexts({ status: 'running' });
      expect(running).toHaveLength(1);
      expect(running[0].taskId).toBe('running-task');
    });

    it('should list active tasks (pending + running)', async () => {
      await manager.createContext({
        taskId: 'active-1',
        chatId: 'oc_chat123',
        title: 'Active 1',
        description: 'Test',
      });
      await manager.createContext({
        taskId: 'active-2',
        chatId: 'oc_chat123',
        title: 'Active 2',
        description: 'Test',
      });
      await manager.updateContext('active-2', { status: 'running' });

      // Complete one task so it's not active
      await manager.createContext({
        taskId: 'done-task',
        chatId: 'oc_chat123',
        title: 'Done',
        description: 'Test',
      });
      await manager.updateContext('done-task', { status: 'completed' });

      const active = await manager.listActiveTasks();
      expect(active).toHaveLength(2);
      const ids = active.map(c => c.taskId).sort();
      expect(ids).toEqual(['active-1', 'active-2']);
    });

    it('should return empty array when no tasks exist', async () => {
      const all = await manager.listContexts();
      expect(all).toEqual([]);
    });
  });

  describe('getElapsedTime', () => {
    it('should return null for unstarted task', () => {
      const ctx: TaskContext = {
        version: 1,
        taskId: 'test',
        chatId: 'oc_chat',
        status: 'pending',
        phase: 'definition',
        title: 'Test',
        description: '',
        createdAt: new Date().toISOString(),
        startedAt: null,
        updatedAt: new Date().toISOString(),
        completedAt: null,
        currentIteration: 0,
        totalIterations: 0,
        currentStep: null,
        completedSteps: [],
        plannedSteps: [],
        metrics: { filesModified: 0, testsRun: 0, testsPassed: 0, toolsInvoked: 0 },
        error: null,
      };

      expect(manager.getElapsedTime(ctx)).toBeNull();
    });

    it('should calculate elapsed time for running task', () => {
      const startedAt = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
      const ctx: TaskContext = {
        version: 1,
        taskId: 'test',
        chatId: 'oc_chat',
        status: 'running',
        phase: 'execution',
        title: 'Test',
        description: '',
        createdAt: startedAt,
        startedAt,
        updatedAt: new Date().toISOString(),
        completedAt: null,
        currentIteration: 0,
        totalIterations: 0,
        currentStep: null,
        completedSteps: [],
        plannedSteps: [],
        metrics: { filesModified: 0, testsRun: 0, testsPassed: 0, toolsInvoked: 0 },
        error: null,
      };

      const elapsed = manager.getElapsedTime(ctx);
      expect(elapsed).not.toBeNull();
      expect(elapsed!).toBeGreaterThanOrEqual(59000);
      expect(elapsed!).toBeLessThanOrEqual(70000);
    });
  });

  describe('formatElapsedTime', () => {
    it('should format seconds', () => {
      expect(manager.formatElapsedTime(5000)).toBe('5s');
    });

    it('should format minutes and seconds', () => {
      expect(manager.formatElapsedTime(150000)).toBe('2m 30s');
    });

    it('should format hours and minutes', () => {
      expect(manager.formatElapsedTime(7800000)).toBe('2h 10m');
    });
  });

  describe('full lifecycle', () => {
    it('should track a complete task lifecycle', async () => {
      // 1. Create
      const ctx = await manager.createContext({
        taskId: 'lifecycle-test',
        chatId: 'oc_chat123',
        title: 'Fix auth bug',
        description: 'Fix the login timeout issue',
      });
      expect(ctx.status).toBe('pending');
      expect(ctx.phase).toBe('definition');

      // 2. Start running
      const running = await manager.updateContext('lifecycle-test', {
        status: 'running',
        phase: 'execution',
        currentStep: 'Analyzing auth.service.ts',
        plannedSteps: ['Fix timeout logic', 'Add tests', 'Run test suite'],
      });
      expect(running!.status).toBe('running');
      expect(running!.startedAt).not.toBeNull();
      expect(running!.plannedSteps).toHaveLength(3);

      // 3. Progress through steps
      await manager.updateContext('lifecycle-test', {
        currentStep: 'Fixing timeout logic',
        metrics: { filesModified: 1 },
      });
      await manager.updateContext('lifecycle-test', {
        currentStep: 'Writing tests',
        metrics: { filesModified: 2 },
      });

      // 4. Complete
      const completed = await manager.updateContext('lifecycle-test', {
        status: 'completed',
        metrics: { testsRun: 5, testsPassed: 5 },
      });
      expect(completed!.status).toBe('completed');
      expect(completed!.phase).toBe('completed');
      expect(completed!.completedAt).not.toBeNull();
      expect(completed!.metrics.filesModified).toBe(2);
      expect(completed!.metrics.testsRun).toBe(5);
      expect(completed!.completedSteps).toHaveLength(2); // two steps were tracked

      // 5. Verify context persists
      const loaded = await manager.getContext('lifecycle-test');
      expect(loaded!.status).toBe('completed');
      expect(loaded!.completedSteps).toHaveLength(2);
    });
  });
});
