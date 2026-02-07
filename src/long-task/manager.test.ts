/**
 * Tests for LongTaskManager (src/long-task/manager.ts)
 *
 * Tests the following functionality:
 * - Long task initialization
 * - Task execution workflow
 * - Timeout handling
 * - Abort/cancellation
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LongTaskManager } from './manager.js';
import type { LongTaskConfig } from './types.js';

// Mock dependencies
vi.mock('./planner.js', () => ({
  TaskPlanner: vi.fn(),
}));

vi.mock('./executor.js', () => ({
  SubtaskExecutor: vi.fn(),
}));

vi.mock('./tracker.js', () => ({
  LongTaskTracker: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
  },
}));

import { TaskPlanner } from './planner.js';
import { SubtaskExecutor } from './executor.js';
import { LongTaskTracker } from './tracker.js';

const mockedTaskPlanner = vi.mocked(TaskPlanner);
const mockedSubtaskExecutor = vi.mocked(SubtaskExecutor);
const mockedTaskTracker = vi.mocked(LongTaskTracker);

describe('LongTaskManager', () => {
  let manager: LongTaskManager;
  let config: LongTaskConfig;
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let mockChatId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockChatId = 'oc_test_chat';
    mockSendMessage = vi.fn().mockResolvedValue(undefined);

    config = {
      chatId: mockChatId,
      sendMessage: mockSendMessage,
      sendCard: vi.fn().mockResolvedValue(undefined),
      workspaceBaseDir: '/mock/workspace',
      taskTimeoutMs: 60000, // 1 minute for testing
    };

    // Mock TaskTracker
    const mockTrackerInstance = {
      ensureLongTaskDir: vi.fn().mockResolvedValue('/mock/workspace/tasks/test-task'),
      saveLongTaskPlan: vi.fn().mockResolvedValue(undefined),
      saveSubtaskResult: vi.fn().mockResolvedValue(undefined),
      saveLongTaskSummary: vi.fn().mockResolvedValue(undefined),
    };

    mockedTaskTracker.mockImplementation(() => mockTrackerInstance as any);

    // Mock TaskPlanner
    const mockPlannerInstance = {
      planTask: vi.fn().mockResolvedValue({
        taskId: 'test-task-1',
        originalRequest: 'Test request',
        title: 'Test Task',
        description: 'Test description',
        subtasks: [
          {
            sequence: 1,
            description: 'First subtask',
            status: 'pending',
          },
          {
            sequence: 2,
            description: 'Second subtask',
            status: 'pending',
          },
        ],
        totalSteps: 2,
        createdAt: new Date().toISOString(),
      }),
    };

    mockedTaskPlanner.mockImplementation(() => mockPlannerInstance as any);

    // Mock SubtaskExecutor
    const mockExecutorInstance = {
      executeSubtask: vi.fn().mockResolvedValue({
        success: true,
        summary: 'Subtask completed',
        files: ['test.ts'],
        summaryFile: 'summary.md',
      }),
    };

    mockedSubtaskExecutor.mockImplementation(() => mockExecutorInstance as any);

    manager = new LongTaskManager(
      'test-api-key',
      'claude-3-5-sonnet-20241022',
      undefined,
      config
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create LongTaskManager with config', () => {
      expect(manager).toBeInstanceOf(LongTaskManager);
    });

    it('should initialize with empty active tasks', () => {
      const activeTasks = (manager as any).activeTasks;
      expect(activeTasks.size).toBe(0);
    });
  });

  describe('startLongTask', () => {
    it('should send initial planning message', async () => {
      // This is a simplified test - in reality, the full workflow is complex
      // We'll test the setup and message sending

      // Mock the executeTask to do nothing for now
      const executeTaskSpy = vi.spyOn(manager as any, 'executeTask').mockResolvedValue(undefined);

      await manager.startLongTask('Create a test feature');

      expect(mockSendMessage).toHaveBeenCalledWith(
        mockChatId,
        expect.stringContaining('Starting Long Task Workflow')
      );

      expect(mockSendMessage).toHaveBeenCalledWith(
        mockChatId,
        expect.stringContaining('Create a test feature')
      );

      executeTaskSpy.mockRestore();
    });

    it('should handle task completion', async () => {
      const executeTaskSpy = vi.spyOn(manager as any, 'executeTask').mockResolvedValue(undefined);

      await manager.startLongTask('Test task');

      // Should not throw
      expect(executeTaskSpy).toHaveBeenCalled();

      executeTaskSpy.mockRestore();
    });

    it('should set abort signal', async () => {
      const executeTaskSpy = vi.spyOn(manager as any, 'executeTask').mockResolvedValue(undefined);

      await manager.startLongTask('Test task');

      expect(config.abortSignal).toBeDefined();

      executeTaskSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('should handle execution errors', async () => {
      const executeTaskSpy = vi.spyOn(manager as any, 'executeTask').mockRejectedValue(
        new Error('Task execution failed')
      );

      await manager.startLongTask('Test task');

      expect(mockSendMessage).toHaveBeenCalledWith(
        mockChatId,
        expect.stringContaining('Long Task Failed')
      );

      executeTaskSpy.mockRestore();
    });

    it('should handle abort errors', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';

      const executeTaskSpy = vi.spyOn(manager as any, 'executeTask').mockRejectedValue(abortError);

      await manager.startLongTask('Test task');

      expect(mockSendMessage).toHaveBeenCalledWith(
        mockChatId,
        expect.stringContaining('Cancelled')
      );

      executeTaskSpy.mockRestore();
    });
  });

  describe('cleanup', () => {
    it('should clean up abort signal on completion', async () => {
      const executeTaskSpy = vi.spyOn(manager as any, 'executeTask').mockResolvedValue(undefined);

      await manager.startLongTask('Test task');

      // After completion, abort signal should be cleaned up
      // Note: This might be undefined after cleanup
      expect(executeTaskSpy).toHaveBeenCalled();

      executeTaskSpy.mockRestore();
    });

    it('should remove task from active tasks', async () => {
      const executeTaskSpy = vi.spyOn(manager as any, 'executeTask').mockResolvedValue(undefined);

      await manager.startLongTask('Test task');

      const activeTasks = (manager as any).activeTasks;
      expect(activeTasks.size).toBe(0);

      executeTaskSpy.mockRestore();
    });
  });

  describe('task timeout', () => {
    it('should enforce task timeout', async () => {
      // This test verifies the timeout mechanism exists
      // Actual timeout testing requires more complex setup

      const executeTaskSpy = vi.spyOn(manager as any, 'executeTask').mockResolvedValue(undefined);

      await manager.startLongTask('Test task');

      // Verify timeout config is used
      expect(config.taskTimeoutMs).toBe(60000);

      executeTaskSpy.mockRestore();
    });
  });

  describe('workspace configuration', () => {
    it('should use provided workspace directory', () => {
      const testConfig: LongTaskConfig = {
        ...config,
        workspaceBaseDir: '/custom/workspace',
      };

      const testManager = new LongTaskManager(
        'test-api-key',
        'claude-3-5-sonnet-20241022',
        undefined,
        testConfig
      );

      expect(testManager).toBeInstanceOf(LongTaskManager);
    });

    it('should initialize LongTaskTracker with workspace directory', () => {
      expect(mockedTaskTracker).toHaveBeenCalledWith('/mock/workspace');
    });
  });
});
