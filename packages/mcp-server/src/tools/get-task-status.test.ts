/**
 * Tests for get_current_task_status MCP tool.
 *
 * Verifies task status querying for the Reporter Agent pattern (Issue #857).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @disclaude/core
const mockEntries = new Map<string, import('@disclaude/core').TaskContextEntry>();

vi.mock('@disclaude/core', () => ({
  getTaskContext: () => mockTaskContext,
  resetTaskContext: () => {
    mockEntries.clear();
  },
}));

// Need to import after mock setup
import { get_current_task_status } from './get-task-status.js';

// Minimal mock TaskContext
const mockTaskContext = {
  get: (taskId: string) => mockEntries.get(taskId),
  getActiveTaskForChat: (chatId: string) => {
    for (const entry of mockEntries.values()) {
      if (entry.chatId === chatId && entry.status !== 'completed' && entry.status !== 'failed') {
        return entry;
      }
    }
    return undefined;
  },
  listActive: () => {
    const result: import('@disclaude/core').TaskContextEntry[] = [];
    for (const entry of mockEntries.values()) {
      if (entry.status !== 'completed' && entry.status !== 'failed') {
        result.push(entry);
      }
    }
    return result;
  },
};

describe('get_current_task_status', () => {
  beforeEach(() => {
    mockEntries.clear();
  });

  it('should return task status by taskId', () => {
    mockEntries.set('task-1', {
      taskId: 'task-1',
      chatId: 'oc_chat1',
      description: 'Build API',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedSteps: [],
    });

    const result = get_current_task_status({ taskId: 'task-1' });

    expect(result.success).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task!.taskId).toBe('task-1');
    expect(result.task!.description).toBe('Build API');
    expect(result.task!.status).toBe('pending');
  });

  it('should return error for unknown taskId', () => {
    const result = get_current_task_status({ taskId: 'unknown' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
    expect(result.task).toBeUndefined();
  });

  it('should return active task for chatId', () => {
    mockEntries.set('task-1', {
      taskId: 'task-1',
      chatId: 'oc_chat1',
      description: 'Build API',
      status: 'running',
      currentStep: 'Writing code',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedSteps: [],
    });

    const result = get_current_task_status({ chatId: 'oc_chat1' });

    expect(result.success).toBe(true);
    expect(result.task).toBeDefined();
    expect(result.task!.taskId).toBe('task-1');
    expect(result.task!.status).toBe('running');
    expect(result.task!.currentStep).toBe('Writing code');
  });

  it('should return error when no active task for chat', () => {
    const result = get_current_task_status({ chatId: 'oc_empty' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('No active task');
  });

  it('should list all active tasks when no params given', () => {
    mockEntries.set('task-1', {
      taskId: 'task-1',
      chatId: 'oc_chat1',
      description: 'Task 1',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedSteps: [],
    });
    mockEntries.set('task-2', {
      taskId: 'task-2',
      chatId: 'oc_chat2',
      description: 'Task 2',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedSteps: [],
    });
    mockEntries.set('task-3', {
      taskId: 'task-3',
      chatId: 'oc_chat3',
      description: 'Task 3',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      completedSteps: [],
    });

    const result = get_current_task_status({});

    expect(result.success).toBe(true);
    expect(result.activeTasks).toHaveLength(2);
    expect(result.activeTasks!.map(t => t.taskId)).toEqual(
      expect.arrayContaining(['task-1', 'task-2'])
    );
  });

  it('should return empty list when no active tasks', () => {
    const result = get_current_task_status({});

    expect(result.success).toBe(true);
    expect(result.activeTasks).toHaveLength(0);
    expect(result.message).toContain('No active tasks');
  });

  it('should include completed steps in task detail', () => {
    mockEntries.set('task-1', {
      taskId: 'task-1',
      chatId: 'oc_chat1',
      description: 'Build API',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedSteps: ['Read code', 'Write tests', 'Fix bugs'],
    });

    const result = get_current_task_status({ taskId: 'task-1' });

    expect(result.task!.completedSteps).toEqual([
      'Read code',
      'Write tests',
      'Fix bugs',
    ]);
  });

  it('should include iteration info', () => {
    mockEntries.set('task-1', {
      taskId: 'task-1',
      chatId: 'oc_chat1',
      description: 'Build API',
      status: 'executing',
      currentIteration: 3,
      totalIterations: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedSteps: [],
    });

    const result = get_current_task_status({ taskId: 'task-1' });

    expect(result.task!.currentIteration).toBe(3);
    expect(result.task!.totalIterations).toBe(5);
  });

  it('should include elapsed time', () => {
    mockEntries.set('task-1', {
      taskId: 'task-1',
      chatId: 'oc_chat1',
      description: 'Build API',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date(Date.now() - 30000).toISOString(),
      completedSteps: [],
    });

    const result = get_current_task_status({ taskId: 'task-1' });

    expect(result.task!.elapsedSeconds).toBeDefined();
    expect(result.task!.elapsedSeconds).toBeGreaterThanOrEqual(25);
    expect(result.task!.startedAt).toBeTruthy();
  });

  it('should include error for failed tasks', () => {
    mockEntries.set('task-1', {
      taskId: 'task-1',
      chatId: 'oc_chat1',
      description: 'Build API',
      status: 'failed',
      error: 'Test failed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      completedSteps: [],
    });

    const result = get_current_task_status({ taskId: 'task-1' });

    expect(result.task!.status).toBe('failed');
    expect(result.task!.error).toBe('Test failed');
    expect(result.task!.finishedAt).toBeTruthy();
  });

  it('should prefer taskId over chatId', () => {
    mockEntries.set('task-1', {
      taskId: 'task-1',
      chatId: 'oc_chat1',
      description: 'Task 1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedSteps: [],
    });
    mockEntries.set('task-2', {
      taskId: 'task-2',
      chatId: 'oc_chat1',
      description: 'Task 2',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      completedSteps: [],
    });

    const result = get_current_task_status({
      taskId: 'task-2',
      chatId: 'oc_chat1',
    });

    expect(result.task!.taskId).toBe('task-2');
  });
});
