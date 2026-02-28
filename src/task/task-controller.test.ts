/**
 * Tests for TaskController (src/task/task-controller.ts)
 *
 * Tests the following functionality:
 * - Constructor and configuration
 * - Run loop execution
 * - Evaluate and Execute phases
 * - Completion detection via final_result.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskController, type TaskControllerConfig } from './task-controller.js';

// Mock Evaluator
vi.mock('../agents/evaluator.js', () => ({
  Evaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockImplementation(async function* () {
      yield { content: 'Evaluation result', role: 'assistant' };
    }),
    dispose: vi.fn(),
  })),
}));

// Mock Executor
vi.mock('../agents/executor.js', () => ({
  Executor: vi.fn().mockImplementation(() => ({
    executeTask: vi.fn().mockImplementation(async function* () {
      yield { type: 'output', content: 'Execution output', messageType: 'text' };
      return { success: true, summaryFile: '/test/execution.md', files: [], output: 'Done' };
    }),
  })),
}));

// Mock Reporter
vi.mock('../agents/reporter.js', () => ({
  Reporter: vi.fn().mockImplementation(() => ({
    processEvent: vi.fn().mockImplementation(async function* () {
      yield { content: 'Reporter output', role: 'assistant' };
    }),
    dispose: vi.fn(),
  })),
}));

// Mock TaskFileManager
vi.mock('./task-files.js', () => ({
  TaskFileManager: vi.fn().mockImplementation(() => ({
    hasFinalResult: vi.fn().mockResolvedValue(false),
    createIteration: vi.fn().mockResolvedValue(undefined),
    writeFinalSummary: vi.fn().mockResolvedValue(undefined),
    getTaskSpecPath: vi.fn(() => '/test/task.md'),
    getEvaluationPath: vi.fn(() => '/test/evaluation.md'),
    getExecutionPath: vi.fn(() => '/test/execution.md'),
    getFinalResultPath: vi.fn(() => '/test/final_result.md'),
  })),
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-key',
      model: 'test-model',
      apiBaseUrl: undefined,
    })),
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
  },
}));

// Mock constants
vi.mock('../config/constants.js', () => ({
  DIALOGUE: {
    MAX_ITERATIONS: 3,
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe('TaskController', () => {
  let controller: TaskController;
  let config: TaskControllerConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    config = {
      evaluatorConfig: {
        apiKey: 'test-api-key',
        model: 'test-model',
        permissionMode: 'bypassPermissions',
      },
    };

    controller = new TaskController(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create instance with config', () => {
      expect(controller).toBeInstanceOf(TaskController);
    });

    it('should use default max iterations from constants', () => {
      expect(controller.maxIterations).toBe(3);
    });

    it('should allow custom max iterations', () => {
      const customConfig = { ...config, maxIterations: 5 };
      const customController = new TaskController(customConfig);
      expect(customController.maxIterations).toBe(5);
    });
  });

  describe('run', () => {
    it('should yield messages from evaluate and execute phases', async () => {
      const messages: any[] = [];
      for await (const msg of controller.run('/test/tasks/test-task/task.md', 'chat-123')) {
        messages.push(msg);
      }

      // Should have messages from evaluate and execute phases
      expect(messages.length).toBeGreaterThan(0);
    });

    it('should stop when final_result.md exists', async () => {
      const { TaskFileManager } = await import('./task-files.js');
      const mockFileManager = vi.mocked(TaskFileManager).mock.results[0].value;

      // First call returns false (no final result), second call returns true (task complete)
      mockFileManager.hasFinalResult
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const messages: any[] = [];
      for await (const msg of controller.run('/test/tasks/test-task/task.md', 'chat-123')) {
        messages.push(msg);
      }

      // Should complete after detecting final_result.md
      expect(mockFileManager.hasFinalResult).toHaveBeenCalled();
    });

    it('should stop after max iterations', async () => {
      const customConfig = { ...config, maxIterations: 1 };
      const singleIterController = new TaskController(customConfig);

      const messages: any[] = [];
      for await (const msg of singleIterController.run('/test/tasks/test-task/task.md', 'chat-123')) {
        messages.push(msg);
      }

      expect(singleIterController.getIterationCount()).toBe(1);
    });
  });

  describe('stop', () => {
    it('should stop the running task', async () => {
      // Start the run but don't await it
      const runPromise = (async () => {
        const messages: any[] = [];
        for await (const msg of controller.run('/test/tasks/test-task/task.md', 'chat-123')) {
          messages.push(msg);
        }
        return messages;
      })();

      // Stop immediately
      controller.stop();

      // Wait for completion
      const messages = await runPromise;

      // Should have stopped
      expect(controller.isRunning()).toBe(false);
    });
  });

  describe('getIterationCount', () => {
    it('should return 0 before run', () => {
      expect(controller.getIterationCount()).toBe(0);
    });

    it('should return iteration count after run', async () => {
      const customConfig = { ...config, maxIterations: 2 };
      const twoIterController = new TaskController(customConfig);

      for await (const _ of twoIterController.run('/test/tasks/test-task/task.md', 'chat-123')) {
        // Just consume the messages
      }

      expect(twoIterController.getIterationCount()).toBe(2);
    });
  });

  describe('isRunning', () => {
    it('should return false before run', () => {
      expect(controller.isRunning()).toBe(false);
    });

    it('should return false after run completes', async () => {
      for await (const _ of controller.run('/test/tasks/test-task/task.md', 'chat-123')) {
        // Just consume the messages
      }

      expect(controller.isRunning()).toBe(false);
    });
  });
});
