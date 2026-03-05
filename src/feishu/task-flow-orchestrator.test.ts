/**
 * Tests for TaskFlowOrchestrator module.
 *
 * Tests the following functionality:
 * - TaskFileWatcher integration
 * - executeDialoguePhase execution
 * - Message callbacks
 * - Error handling
 *
 * Refactored (Issue #283): Uses ReflectionController instead of DialogueOrchestrator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskFlowOrchestrator, type MessageCallbacks } from './task-flow-orchestrator.js';

// Mock TaskFileWatcher
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();
vi.mock('../task/task-file-watcher.js', () => ({
  TaskFileWatcher: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    isRunning: vi.fn(() => true),
  })),
}));

// Mock ReflectionController and related modules
vi.mock('../task/index.js', () => ({
  ReflectionController: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockImplementation(async function* () {
      yield { content: 'Test message', messageType: 'text', metadata: {} };
    }),
    getMetrics: vi.fn(() => ({
      totalIterations: 1,
      successfulIterations: 1,
      failedIterations: 0,
    })),
  })),
  TerminationConditions: {
    isComplete: vi.fn(() => () => false),
    maxIterations: vi.fn(() => () => false),
    evaluationComplete: vi.fn(() => () => false),
    all: vi.fn(() => () => false),
    any: vi.fn(() => () => false),
  },
  DialogueMessageTracker: vi.fn().mockImplementation(() => ({
    recordMessageSent: vi.fn(),
    hasAnyMessage: vi.fn(() => true),
    buildWarning: vi.fn(() => 'Warning message'),
    reset: vi.fn(),
  })),
  extractText: vi.fn((msg) => msg.content || ''),
}));

// Mock Evaluator
vi.mock('../agents/evaluator.js', () => ({
  Evaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockImplementation(async function* () {
      yield { content: 'Evaluation message', messageType: 'text' };
    }),
    dispose: vi.fn(),
  })),
}));

// Mock Executor
vi.mock('../agents/executor.js', () => ({
  Executor: vi.fn().mockImplementation(() => ({
    executeTask: vi.fn().mockImplementation(async function* () {
      yield { type: 'output', content: 'Execution message', messageType: 'text' };
    }),
  })),
}));

// Mock TaskFileManager
vi.mock('../task/task-files.js', () => ({
  TaskFileManager: vi.fn().mockImplementation(() => ({
    hasFinalResult: vi.fn().mockResolvedValue(false),
    readExecution: vi.fn().mockResolvedValue(''),
  })),
}));

// Mock DIALOGUE constants
vi.mock('../config/constants.js', () => ({
  DIALOGUE: {
    MAX_ITERATIONS: 10,
  },
  MESSAGE_LOGGING: {
    LOGS_DIR: 'chat',
    MD_PARSE_REGEX: /message_id:\s*([^\]]+)/g,
  },
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

// Mock FeishuOutputAdapter
vi.mock('../utils/output-adapter.js', () => ({
  FeishuOutputAdapter: vi.fn().mockImplementation(() => ({
    write: vi.fn().mockResolvedValue(undefined),
    clearThrottleState: vi.fn(),
    resetMessageTracking: vi.fn(),
  })),
}));

// Mock feishu-context-mcp
vi.mock('../mcp/feishu-context-mcp.js', () => ({
  setMessageSentCallback: vi.fn(),
  feishuSdkMcpServer: {},
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

// Mock error-handler
vi.mock('../utils/error-handler.js', () => ({
  handleError: vi.fn((error) => ({
    message: error instanceof Error ? error.message : String(error),
    userMessage: 'Test error message',
  })),
  ErrorCategory: {
    SDK: 'sdk',
  },
}));

// Mock TaskTracker
vi.mock('../utils/task-tracker.js', () => ({
  TaskTracker: vi.fn().mockImplementation(() => ({
    getDialogueTaskPath: vi.fn(() => '/test/workspace/tasks/test-task.md'),
  })),
}));

// Mock messageLogger
vi.mock('./message-logger.js', () => ({
  messageLogger: {
    getChatHistory: vi.fn().mockResolvedValue('## Test chat history'),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('TaskFlowOrchestrator', () => {
  let orchestrator: TaskFlowOrchestrator;
  let mockCallbacks: MessageCallbacks;
  let mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };

    orchestrator = new TaskFlowOrchestrator(
      {} as any, // TaskTracker mock
      mockCallbacks,
      mockLogger as unknown as import('pino').Logger
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create instance with callbacks', () => {
      expect(orchestrator).toBeInstanceOf(TaskFlowOrchestrator);
    });

    it('should initialize TaskFileWatcher', () => {
      expect(mockStart).not.toHaveBeenCalled(); // Not started in constructor
    });
  });

  describe('start/stop', () => {
    it('should start file watcher', async () => {
      await orchestrator.start();

      expect(mockStart).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('started')
      );
    });

    it('should stop file watcher', () => {
      orchestrator.stop();

      expect(mockStop).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('stopped')
      );
    });
  });

  describe('executeDialoguePhase', () => {
    it('should start dialogue phase with task path', async () => {
      const taskPath = '/test/workspace/tasks/msg_123/task.md';

      void orchestrator.executeDialoguePhase('chat-123', 'msg-001', taskPath);

      // Wait a bit for async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should handle chat ID correctly', async () => {
      const taskPath = '/test/workspace/tasks/msg_456/task.md';

      void orchestrator.executeDialoguePhase('test-chat-id', 'msg-002', taskPath);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'test-chat-id' }),
        expect.any(String)
      );
    });

    it('should log dialogue phase start', async () => {
      const taskPath = '/test/workspace/tasks/msg_789/task.md';

      void orchestrator.executeDialoguePhase('chat-123', 'msg-003', taskPath);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockLogger.info).toHaveBeenCalled();
    });
  });

  describe('MessageCallbacks Interface', () => {
    it('should have sendMessage callback', () => {
      expect(mockCallbacks.sendMessage).toBeDefined();
      expect(typeof mockCallbacks.sendMessage).toBe('function');
    });

    it('should have sendCard callback', () => {
      expect(mockCallbacks.sendCard).toBeDefined();
      expect(typeof mockCallbacks.sendCard).toBe('function');
    });

    it('should have sendFile callback', () => {
      expect(mockCallbacks.sendFile).toBeDefined();
      expect(typeof mockCallbacks.sendFile).toBe('function');
    });
  });

  describe('Error Handling', () => {
    it('should handle errors in dialogue gracefully', async () => {
      // Import ReflectionController mock
      const { ReflectionController } = await import('../task/index.js');

      // Reset the mock for ReflectionController to throw
      (vi.mocked(ReflectionController).mockImplementationOnce as any)((): any => ({
        run: vi.fn().mockImplementation(async function* () {
          throw new Error('Reflection failed');
        }),
        getMetrics: vi.fn(() => ({ totalIterations: 0 })),
      }));

      const errorOrchestrator = new TaskFlowOrchestrator(
        {} as any,
        mockCallbacks,
        mockLogger as unknown as import('pino').Logger
      );

      const taskPath = '/test/workspace/tasks/msg_err/task.md';
      void errorOrchestrator.executeDialoguePhase('chat-err', 'msg-err', taskPath);

      // Wait for async error handling
      await new Promise(resolve => setTimeout(resolve, 200));

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
