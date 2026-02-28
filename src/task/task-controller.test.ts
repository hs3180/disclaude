/**
 * Tests for TaskController (Issue #283).
 *
 * Tests the following functionality:
 * - TaskController initialization
 * - Message tracker access
 * - State management
 * - Stop functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskController, type TaskControllerConfig } from './task-controller.js';

// Mock Evaluator
vi.mock('../agents/evaluator.js', () => ({
  Evaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockImplementation(async function* () {
      yield { content: 'Evaluation message', role: 'assistant' };
    }),
    dispose: vi.fn(),
  })),
}));

// Mock Executor
vi.mock('../agents/executor.js', () => ({
  Executor: vi.fn().mockImplementation(() => ({
    executeTask: vi.fn().mockImplementation(async function* () {
      yield { type: 'output', content: 'Execution output', messageType: 'text' };
    }),
  })),
}));

// Mock Reporter
vi.mock('../agents/reporter.js', () => ({
  Reporter: vi.fn().mockImplementation(() => ({
    processEvent: vi.fn().mockImplementation(async function* () {
      yield { content: 'Report message', role: 'assistant' };
    }),
    dispose: vi.fn(),
  })),
}));

// Mock TaskFileManager
vi.mock('./task-files.js', () => ({
  TaskFileManager: vi.fn().mockImplementation(() => ({
    hasFinalResult: vi.fn().mockResolvedValue(false),
    writeFinalSummary: vi.fn().mockResolvedValue(undefined),
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

  describe('getMessageTracker', () => {
    it('should return message tracker instance', () => {
      const tracker = controller.getMessageTracker();
      expect(tracker).toBeDefined();
    });

    it('should return same tracker instance on multiple calls', () => {
      const tracker1 = controller.getMessageTracker();
      const tracker2 = controller.getMessageTracker();
      expect(tracker1).toBe(tracker2);
    });
  });

  describe('getIterationCount', () => {
    it('should return 0 before run', () => {
      expect(controller.getIterationCount()).toBe(0);
    });
  });

  describe('isRunning', () => {
    it('should return false before run', () => {
      expect(controller.isRunning()).toBe(false);
    });
  });

  describe('stop', () => {
    it('should not throw when called before run', () => {
      expect(() => controller.stop()).not.toThrow();
    });
  });
});
