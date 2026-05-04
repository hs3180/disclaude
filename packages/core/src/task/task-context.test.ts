/**
 * Tests for TaskContextStore.
 *
 * Issue #857: Tests for file-based task context management.
 * Verifies context creation, updates, reads, listing, and progress calculation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskContextStore } from './task-context.js';
import { TaskFileManager } from './task-files.js';
import type { TaskContext } from './types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-context-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('TaskContextStore', () => {
  let store: TaskContextStore;
  let fileManager: TaskFileManager;

  beforeEach(() => {
    store = new TaskContextStore(tempDir);
    fileManager = new TaskFileManager({ workspaceDir: tempDir });
  });

  describe('constructor', () => {
    it('should create store with workspace directory', () => {
      expect(store).toBeInstanceOf(TaskContextStore);
    });
  });

  describe('getContextPath', () => {
    it('should return path containing context.md', () => {
      const result = store.getContextPath('task-1');
      expect(result).toContain('context.md');
      expect(result).toContain('task-1');
    });

    it('should sanitize task ID', () => {
      const result = store.getContextPath('task/123@abc');
      const baseName = path.basename(path.dirname(result));
      expect(baseName).not.toContain('/');
      expect(baseName).not.toContain('@');
    });
  });

  describe('create', () => {
    it('should create context.md in task directory', async () => {
      await fileManager.initializeTask('task-1');

      const context = await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Build a feature',
      });

      expect(context.taskId).toBe('task-1');
      expect(context.chatId).toBe('oc_test');
      expect(context.status).toBe('pending');
      expect(context.description).toBe('Build a feature');
      expect(context.completedSteps).toEqual([]);
      expect(context.errors).toEqual([]);
      expect(context.createdAt).toBeTruthy();
      expect(context.updatedAt).toBeTruthy();
    });

    it('should create context with optional fields', async () => {
      await fileManager.initializeTask('task-2');

      const context = await store.create('task-2', {
        chatId: 'oc_test',
        description: 'Complex task',
        totalSteps: 5,
        metadata: { source: 'scheduler', priority: 'high' },
      });

      expect(context.totalSteps).toBe(5);
      expect(context.metadata).toEqual({ source: 'scheduler', priority: 'high' });
    });

    it('should throw if context already exists', async () => {
      await fileManager.initializeTask('task-3');
      await store.create('task-3', {
        chatId: 'oc_test',
        description: 'First creation',
      });

      await expect(store.create('task-3', {
        chatId: 'oc_test',
        description: 'Second creation',
      })).rejects.toThrow('already exists');
    });

    it('should write human-readable markdown', async () => {
      await fileManager.initializeTask('task-4');
      await store.create('task-4', {
        chatId: 'oc_chat',
        description: 'Test task',
      });

      const contextPath = store.getContextPath('task-4');
      const content = await fs.readFile(contextPath, 'utf-8');

      expect(content).toContain('Task Context: task-4');
      expect(content).toContain('oc_chat');
      expect(content).toContain('pending');
      expect(content).toContain('Test task');
    });
  });

  describe('read', () => {
    it('should read back created context', async () => {
      await fileManager.initializeTask('task-1');
      const created = await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Read test',
        totalSteps: 3,
      });

      const read = await store.read('task-1');

      expect(read.taskId).toBe(created.taskId);
      expect(read.chatId).toBe(created.chatId);
      expect(read.status).toBe(created.status);
      expect(read.description).toBe(created.description);
      expect(read.totalSteps).toBe(created.totalSteps);
      expect(read.completedSteps).toEqual([]);
      expect(read.errors).toEqual([]);
    });

    it('should throw when reading non-existent context', async () => {
      await expect(store.read('nonexistent')).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('should update status to running and set startedAt', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Status transition test',
      });

      const updated = await store.update('task-1', { status: 'running' });

      expect(updated.status).toBe('running');
      expect(updated.startedAt).toBeTruthy();
      expect(updated.updatedAt).toBeTruthy();
    });

    it('should update current step', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Step test',
      });

      const updated = await store.update('task-1', { currentStep: 'Cloning repository' });

      expect(updated.currentStep).toBe('Cloning repository');
    });

    it('should add completed step', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Completed step test',
      });

      await store.update('task-1', { addCompletedStep: 'Step 1 done' });
      const updated = await store.update('task-1', { addCompletedStep: 'Step 2 done' });

      expect(updated.completedSteps).toEqual(['Step 1 done', 'Step 2 done']);
    });

    it('should set completedAt on terminal status', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Completion test',
      });
      await store.update('task-1', { status: 'running' });
      const completed = await store.update('task-1', { status: 'completed' });

      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeTruthy();
      expect(completed.startedAt).toBeTruthy();
    });

    it('should set completedAt on failed status', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Failed test',
      });
      await store.update('task-1', { status: 'running' });
      const failed = await store.update('task-1', { status: 'failed' });

      expect(failed.status).toBe('failed');
      expect(failed.completedAt).toBeTruthy();
    });

    it('should set completedAt on cancelled status', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Cancel test',
      });
      const cancelled = await store.update('task-1', { status: 'cancelled' });

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.completedAt).toBeTruthy();
    });

    it('should add errors', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Error test',
      });

      await store.update('task-1', { addError: 'Something went wrong' });
      const updated = await store.update('task-1', { addError: 'Another error' });

      expect(updated.errors).toEqual(['Something went wrong', 'Another error']);
    });

    it('should merge metadata', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Metadata test',
        metadata: { key1: 'value1' },
      });

      const updated = await store.update('task-1', { metadata: { key2: 'value2' } });

      expect(updated.metadata).toEqual({ key1: 'value1', key2: 'value2' });
    });

    it('should update total steps', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Total steps test',
        totalSteps: 3,
      });

      const updated = await store.update('task-1', { totalSteps: 5 });

      expect(updated.totalSteps).toBe(5);
    });

    it('should throw when updating non-existent context', async () => {
      await expect(store.update('nonexistent', { status: 'running' })).rejects.toThrow();
    });

    it('should persist updates to disk', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Persist test',
      });

      await store.update('task-1', { status: 'running', currentStep: 'Working...' });
      await store.update('task-1', { addCompletedStep: 'Done' });

      // Re-read from disk to verify persistence
      const read = await store.read('task-1');
      expect(read.status).toBe('running');
      expect(read.currentStep).toBe('Working...');
      expect(read.completedSteps).toEqual(['Done']);
    });

    it('should handle full task lifecycle', async () => {
      await fileManager.initializeTask('lifecycle-1');

      // Create
      const created = await store.create('lifecycle-1', {
        chatId: 'oc_lifecycle',
        description: 'Full lifecycle test',
        totalSteps: 3,
      });
      expect(created.status).toBe('pending');

      // Start
      const started = await store.update('lifecycle-1', { status: 'running' });
      expect(started.status).toBe('running');
      expect(started.startedAt).toBeTruthy();

      // Progress
      await store.update('lifecycle-1', { currentStep: 'Step 1', addCompletedStep: 'Step 0 complete' });
      await store.update('lifecycle-1', { currentStep: 'Step 2', addCompletedStep: 'Step 1 complete' });

      // Error
      await store.update('lifecycle-1', { addError: 'Minor hiccup' });

      // Complete
      const completed = await store.update('lifecycle-1', {
        status: 'completed',
        addCompletedStep: 'Step 2 complete',
        currentStep: undefined,
      });

      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeTruthy();
      expect(completed.completedSteps).toHaveLength(3);
      expect(completed.errors).toEqual(['Minor hiccup']);
    });
  });

  describe('exists', () => {
    it('should return false when context does not exist', async () => {
      expect(await store.exists('nonexistent')).toBe(false);
    });

    it('should return true after creating context', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Exists test',
      });

      expect(await store.exists('task-1')).toBe(true);
    });
  });

  describe('delete', () => {
    it('should remove context file', async () => {
      await fileManager.initializeTask('task-1');
      await store.create('task-1', {
        chatId: 'oc_test',
        description: 'Delete test',
      });

      expect(await store.exists('task-1')).toBe(true);
      await store.delete('task-1');
      expect(await store.exists('task-1')).toBe(false);
    });

    it('should handle non-existent context gracefully', async () => {
      // Should not throw
      await store.delete('nonexistent');
    });
  });

  describe('listAll', () => {
    it('should return empty array when no contexts exist', async () => {
      const contexts = await store.listAll();
      expect(contexts).toEqual([]);
    });

    it('should list all contexts across tasks', async () => {
      await fileManager.initializeTask('task-1');
      await fileManager.initializeTask('task-2');
      await fileManager.initializeTask('task-3');

      await store.create('task-1', { chatId: 'oc_1', description: 'Task 1' });
      await store.create('task-2', { chatId: 'oc_2', description: 'Task 2' });
      await store.create('task-3', { chatId: 'oc_3', description: 'Task 3' });

      const contexts = await store.listAll();
      expect(contexts).toHaveLength(3);
      expect(contexts.map(c => c.taskId).sort()).toEqual(['task-1', 'task-2', 'task-3']);
    });

    it('should filter by status', async () => {
      await fileManager.initializeTask('task-1');
      await fileManager.initializeTask('task-2');

      await store.create('task-1', { chatId: 'oc_1', description: 'Running task' });
      await store.create('task-2', { chatId: 'oc_2', description: 'Pending task' });
      await store.update('task-1', { status: 'running' });

      const running = await store.listAll('running');
      expect(running).toHaveLength(1);
      expect(running[0].taskId).toBe('task-1');
    });

    it('should skip task directories without context.md', async () => {
      await fileManager.initializeTask('with-context');
      await fileManager.initializeTask('without-context');

      await store.create('with-context', { chatId: 'oc_1', description: 'Has context' });

      const contexts = await store.listAll();
      expect(contexts).toHaveLength(1);
      expect(contexts[0].taskId).toBe('with-context');
    });
  });

  describe('getActiveTasks', () => {
    it('should return only running tasks', async () => {
      await fileManager.initializeTask('running-1');
      await fileManager.initializeTask('pending-1');
      await fileManager.initializeTask('completed-1');

      await store.create('running-1', { chatId: 'oc_1', description: 'Running' });
      await store.update('running-1', { status: 'running' });

      await store.create('pending-1', { chatId: 'oc_2', description: 'Pending' });

      await store.create('completed-1', { chatId: 'oc_3', description: 'Completed' });
      await store.update('completed-1', { status: 'completed' });

      const active = await store.getActiveTasks();
      expect(active).toHaveLength(1);
      expect(active[0].taskId).toBe('running-1');
    });

    it('should return empty array when no tasks are running', async () => {
      await fileManager.initializeTask('pending-1');
      await store.create('pending-1', { chatId: 'oc_1', description: 'Pending' });

      const active = await store.getActiveTasks();
      expect(active).toEqual([]);
    });
  });

  describe('calculateProgress', () => {
    it('should return undefined when totalSteps is not set', () => {
      const context: TaskContext = {
        taskId: 'test',
        chatId: 'oc_test',
        status: 'running',
        description: 'Test',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        completedSteps: ['step1'],
        errors: [],
      };

      expect(store.calculateProgress(context)).toBeUndefined();
    });

    it('should calculate progress percentage', () => {
      const context: TaskContext = {
        taskId: 'test',
        chatId: 'oc_test',
        status: 'running',
        description: 'Test',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        completedSteps: ['step1', 'step2'],
        totalSteps: 4,
        errors: [],
      };

      expect(store.calculateProgress(context)).toBe(50);
    });

    it('should cap at 100%', () => {
      const context: TaskContext = {
        taskId: 'test',
        chatId: 'oc_test',
        status: 'running',
        description: 'Test',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        completedSteps: ['s1', 's2', 's3', 's4', 's5'],
        totalSteps: 4,
        errors: [],
      };

      expect(store.calculateProgress(context)).toBe(100);
    });

    it('should return 0 when no steps completed', () => {
      const context: TaskContext = {
        taskId: 'test',
        chatId: 'oc_test',
        status: 'pending',
        description: 'Test',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        completedSteps: [],
        totalSteps: 5,
        errors: [],
      };

      expect(store.calculateProgress(context)).toBe(0);
    });
  });
});
