/**
 * Tests for task-status tool.
 *
 * Issue #857: Reporter Agent - Task status reading tool
 *
 * @module mcp/tools/task-status.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get_current_task_status } from './task-status.js';
import * as taskStateManager from '../../utils/task-state-manager.js';
import * as taskProgressService from '../../agents/task-progress-service.js';

// Mock the task state manager
vi.mock('../../utils/task-state-manager.js', () => ({
  getTaskStateManager: vi.fn(),
}));

// Mock the task progress service
vi.mock('../../agents/task-progress-service.js', () => ({
  taskProgressService: {
    getActiveTask: vi.fn(),
  },
}));

const mockGetTaskStateManager = vi.mocked(taskStateManager.getTaskStateManager);
const mockGetActiveTask = vi.mocked(taskProgressService.taskProgressService.getActiveTask);

describe('get_current_task_status', () => {
  let mockTaskStateManager: {
    getCurrentTask: vi.Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockTaskStateManager = {
      getCurrentTask: vi.fn(),
    };

    mockGetTaskStateManager.mockReturnValue(mockTaskStateManager as unknown as taskStateManager.TaskStateManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('no active task', () => {
    it('should return success with no task message when no task is running', async () => {
      mockTaskStateManager.getCurrentTask.mockResolvedValue(null);

      const result = await get_current_task_status();

      expect(result.success).toBe(true);
      expect(result.message).toBe('No active task found.');
      expect(result.task).toBeUndefined();
    });
  });

  describe('active task', () => {
    it('should return task status for running task', async () => {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 300000); // 5 minutes ago

      mockTaskStateManager.getCurrentTask.mockResolvedValue({
        id: 'task_1234567890_abc12',
        prompt: 'Analyze the codebase and generate a report',
        status: 'running',
        progress: 45,
        chatId: 'oc_test_chat',
        userId: 'user_123',
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
        currentStep: 'Analyzing source files',
      });

      mockGetActiveTask.mockReturnValue(undefined);

      const result = await get_current_task_status();

      expect(result.success).toBe(true);
      expect(result.message).toBe('Current task: running (45%)');
      expect(result.task).toBeDefined();
      expect(result.task?.id).toBe('task_1234567890_abc12');
      expect(result.task?.prompt).toBe('Analyze the codebase and generate a report');
      expect(result.task?.status).toBe('running');
      expect(result.task?.progress).toBe(45);
      expect(result.task?.currentStep).toBe('Analyzing source files');
      expect(result.task?.elapsedSeconds).toBeCloseTo(300, -1); // ~5 minutes
    });

    it('should return task status for paused task', async () => {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 60000); // 1 minute ago

      mockTaskStateManager.getCurrentTask.mockResolvedValue({
        id: 'task_paused',
        prompt: 'Paused task',
        status: 'paused',
        progress: 30,
        chatId: 'oc_test_chat',
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
        currentStep: 'Waiting for user input',
      });

      mockGetActiveTask.mockReturnValue({
        taskId: 'task_paused',
        percent: 30,
        status: 'paused',
      });

      const result = await get_current_task_status();

      expect(result.success).toBe(true);
      expect(result.task?.status).toBe('paused');
      expect(result.task?.progress).toBe(30);
    });

    it('should return task status for completed task', async () => {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 600000); // 10 minutes ago

      mockTaskStateManager.getCurrentTask.mockResolvedValue({
        id: 'task_completed',
        prompt: 'Completed task',
        status: 'completed',
        progress: 100,
        chatId: 'oc_test_chat',
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
      });

      mockGetActiveTask.mockReturnValue(undefined);

      const result = await get_current_task_status();

      expect(result.success).toBe(true);
      expect(result.task?.status).toBe('completed');
      expect(result.task?.progress).toBe(100);
    });

    it('should return task status for error task', async () => {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 30000); // 30 seconds ago

      mockTaskStateManager.getCurrentTask.mockResolvedValue({
        id: 'task_error',
        prompt: 'Failed task',
        status: 'error',
        progress: 50,
        chatId: 'oc_test_chat',
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
        error: 'Network connection timeout',
      });

      mockGetActiveTask.mockReturnValue(undefined);

      const result = await get_current_task_status();

      expect(result.success).toBe(true);
      expect(result.task?.status).toBe('error');
      expect(result.task?.error).toBe('Network connection timeout');
    });

    it('should calculate estimated remaining time based on progress', async () => {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 180000); // 3 minutes ago (180 seconds)

      mockTaskStateManager.getCurrentTask.mockResolvedValue({
        id: 'task_with_eta',
        prompt: 'Task with ETA',
        status: 'running',
        progress: 45,
        chatId: 'oc_test_chat',
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
        currentStep: 'Processing data',
      });

      mockGetActiveTask.mockReturnValue({
        taskId: 'task_with_eta',
        percent: 45,
        status: 'running',
      });

      const result = await get_current_task_status();

      expect(result.success).toBe(true);
      expect(result.task?.elapsedSeconds).toBeCloseTo(180, -1);
      // ETA: 180 seconds / 45% * (100 - 45) = 4 * 55 = 220 seconds
      expect(result.task?.estimatedSecondsRemaining).toBeCloseTo(220, -1);
    });

    it('should not calculate ETA when progress is 0', async () => {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 10000); // 10 seconds ago

      mockTaskStateManager.getCurrentTask.mockResolvedValue({
        id: 'task_no_progress',
        prompt: 'Task with no progress yet',
        status: 'running',
        progress: 0,
        chatId: 'oc_test_chat',
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
      });

      mockGetActiveTask.mockReturnValue({
        taskId: 'task_no_progress',
        percent: 0,
        status: 'running',
      });

      const result = await get_current_task_status();

      expect(result.success).toBe(true);
      expect(result.task?.estimatedSecondsRemaining).toBeUndefined();
    });

    it('should not calculate ETA when progress service has no data', async () => {
      const now = new Date();
      const createdAt = new Date(now.getTime() - 60000);

      mockTaskStateManager.getCurrentTask.mockResolvedValue({
        id: 'task_no_service',
        prompt: 'Task without progress service',
        status: 'running',
        progress: 50,
        chatId: 'oc_test_chat',
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
      });

      mockGetActiveTask.mockReturnValue(undefined);

      const result = await get_current_task_status();

      expect(result.success).toBe(true);
      expect(result.task?.estimatedSecondsRemaining).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should handle exceptions from task state manager', async () => {
      mockTaskStateManager.getCurrentTask.mockRejectedValue(new Error('Storage error'));

      const result = await get_current_task_status();

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to get task status');
      expect(result.message).toContain('Storage error');
    });
  });
});
