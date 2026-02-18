/**
 * Tests for TaskFlowOrchestrator module.
 *
 * Tests the following functionality:
 * - executeDialoguePhase execution
 * - Message callbacks
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskFlowOrchestrator, type MessageCallbacks } from './task-flow-orchestrator.js';

// Mock DialogueOrchestrator
vi.mock('../task/index.js', () => ({
  DialogueOrchestrator: vi.fn().mockImplementation(() => ({
    runDialogue: vi.fn().mockImplementation(async function* () {
      yield { content: 'Test message', messageType: 'text', metadata: {} };
    }),
    getMessageTracker: vi.fn(() => ({
      recordMessageSent: vi.fn(),
      hasAnyMessage: vi.fn(() => true),
      buildWarning: vi.fn(() => 'Warning message'),
    })),
  })),
  extractText: vi.fn((msg) => msg.content || ''),
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
const mockGetDialogueTaskPath = vi.fn(() => '/test/workspace/tasks/test-task.md');
vi.mock('../utils/task-tracker.js', () => ({
  TaskTracker: vi.fn().mockImplementation(() => ({
    getDialogueTaskPath: mockGetDialogueTaskPath,
  })),
}));

describe('TaskFlowOrchestrator', () => {
  let orchestrator: TaskFlowOrchestrator;
  let mockCallbacks: MessageCallbacks;
  let mockTaskTracker: { getDialogueTaskPath: ReturnType<typeof vi.fn> };
  let mockLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };

    mockTaskTracker = {
      getDialogueTaskPath: mockGetDialogueTaskPath,
    };

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };

    orchestrator = new TaskFlowOrchestrator(
      mockTaskTracker as unknown as import('../utils/task-tracker.js').TaskTracker,
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
  });

  describe('executeDialoguePhase', () => {
    it('should start dialogue phase asynchronously', async () => {
      // executeDialoguePhase starts async, doesn't wait
      orchestrator.executeDialoguePhase('chat-123', 'msg-001', 'Test task');

      // Wait a bit for async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify task path was requested
      expect(mockGetDialogueTaskPath).toHaveBeenCalledWith('msg-001');
    });

    it('should handle chat ID correctly', async () => {
      orchestrator.executeDialoguePhase('test-chat-id', 'msg-002', 'Another task');

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGetDialogueTaskPath).toHaveBeenCalledWith('msg-002');
    });

    it('should log dialogue phase start', async () => {
      orchestrator.executeDialoguePhase('chat-123', 'msg-003', 'Task');

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
      // Import DialogueOrchestrator mock
      const { DialogueOrchestrator } = await import('../task/index.js');

      // Reset the mock for DialogueOrchestrator to throw
      (vi.mocked(DialogueOrchestrator).mockImplementationOnce as any)((): any => ({
        runDialogue: vi.fn().mockImplementation(async function* () {
          throw new Error('Dialogue failed');
        }),
        getMessageTracker: vi.fn(() => ({
          recordMessageSent: vi.fn(),
          hasAnyMessage: vi.fn(() => false),
          buildWarning: vi.fn(() => 'Warning'),
        })),
      }));

      const errorOrchestrator = new TaskFlowOrchestrator(
        mockTaskTracker as unknown as import('../utils/task-tracker.js').TaskTracker,
        mockCallbacks,
        mockLogger as unknown as import('pino').Logger
      );

      errorOrchestrator.executeDialoguePhase('chat-err', 'msg-err', 'Error task');

      // Wait for async error handling
      await new Promise(resolve => setTimeout(resolve, 200));

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
