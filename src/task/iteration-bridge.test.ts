/**
 * Tests for IterationBridge (src/task/iteration-bridge.ts)
 *
 * Tests the file-driven Evaluation-Execution architecture:
 * - Phase 1: Evaluator writes evaluation.md
 * - Phase 2: If final_result.md not present, Executor executes tasks
 * - File-driven communication without JSON parsing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IterationBridge, type IterationBridgeConfig } from './iteration-bridge.js';
import type { EvaluatorConfig } from '../agents/evaluator.js';

// Create mock instances that will be used in tests
let mockEvaluatorInstance: Record<string, unknown>;

// Mock Evaluator and Executor classes
vi.mock('../agents/evaluator.js', () => ({
  Evaluator: vi.fn().mockImplementation(() => {
    return (globalThis as unknown as { mockEvaluatorInstance: Record<string, unknown> }).mockEvaluatorInstance;
  }),
}));

vi.mock('../agents/executor.js', () => ({
  Executor: vi.fn().mockImplementation(() => ({
    executeTask: vi.fn().mockImplementation(async function* () {
      yield { type: 'start', title: 'Test' };
      yield { type: 'output', content: 'Test output', messageType: 'text' };
      yield { type: 'complete', summaryFile: 'test.md', files: [] };
      return { success: true, summaryFile: 'test.md', files: [], output: 'Test output' };
    }),
  })),
}));

vi.mock('../agents/reporter.js', () => {
  const MockReporter = vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    sendFeedback: vi.fn().mockImplementation(async function* () {
      yield { content: 'Reporter output', role: 'assistant', messageType: 'text' };
    }),
    processEvent: vi.fn().mockImplementation(async function* () {
      yield { content: 'Reporter output', role: 'assistant', messageType: 'text' };
    }),
    cleanup: vi.fn(),
  }));

  // Add static method as a regular function (not a mock)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MockReporter as any).buildEventFeedbackPrompt = vi.fn().mockReturnValue('Mock prompt for event feedback');

  return { Reporter: MockReporter };
});

vi.mock('./file-manager.js', () => ({
  TaskFileManager: vi.fn().mockImplementation(() => ({
    hasFinalResult: vi.fn().mockResolvedValue(false),
    readEvaluation: vi.fn().mockResolvedValue('# Evaluation\n\n## Status\nNEED_EXECUTE'),
    getExecutionPath: vi.fn().mockReturnValue('tasks/test/iterations/iter-1/execution.md'),
    writeExecution: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./skill-loader.js', () => ({
  loadSkillOrThrow: vi.fn().mockResolvedValue({
    name: 'evaluator',
    description: 'Evaluator skill',
    content: 'Evaluator skill content',
    allowedTools: ['Read', 'Grep', 'Glob', 'Write'],
    disableModelInvocation: false,
  }),
}));

describe('IterationBridge (File-Driven Architecture)', () => {
  let bridge: IterationBridge;
  let config: IterationBridgeConfig;
  let evaluatorConfig: EvaluatorConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    evaluatorConfig = {
      apiKey: 'test-evaluator-key',
      model: 'claude-3-5-sonnet-20241022',
    };

    config = {
      evaluatorConfig,
      iteration: 1,
      taskId: 'test-task-id',
    };

    // Mock Evaluator instance with streaming evaluate method
    mockEvaluatorInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      queryStream: vi.fn().mockReturnValue((async function* () {
        yield { content: 'Mock evaluation response', role: 'assistant', messageType: 'text' };
      })()),
      cleanup: vi.fn(),
      evaluate: vi.fn().mockImplementation(async function* (_taskId: string, _iteration: number) {
        yield { content: 'Evaluating...', role: 'assistant', messageType: 'text' };
        yield { content: 'Evaluation complete', role: 'assistant', messageType: 'text' };
      }),
    };

    // Store on globalThis so mock can access it
    (globalThis as unknown as { mockEvaluatorInstance: Record<string, unknown> }).mockEvaluatorInstance = mockEvaluatorInstance;
  });

  describe('constructor', () => {
    it('should create bridge with config', () => {
      bridge = new IterationBridge(config);

      expect(bridge).toBeInstanceOf(IterationBridge);
      expect(bridge.evaluatorConfig).toBe(evaluatorConfig);
      expect(bridge.iteration).toBe(1);
    });

    it('should accept chatId', () => {
      const configWithChatId: IterationBridgeConfig = {
        ...config,
        chatId: 'test-chat-id',
      };

      bridge = new IterationBridge(configWithChatId);
      expect(bridge.chatId).toBe('test-chat-id');
    });
  });

  describe('runIterationStreaming', () => {
    it('should stream Evaluator output', async () => {
      bridge = new IterationBridge(config);

      const messages: unknown[] = [];
      for await (const msg of bridge.runIterationStreaming()) {
        messages.push(msg);
      }

      // Should have called evaluate
      expect(mockEvaluatorInstance.evaluate).toHaveBeenCalledTimes(1);
    });

    it('should cleanup Evaluator after iteration', async () => {
      bridge = new IterationBridge(config);

      try {
        for await (const _ of bridge.runIterationStreaming()) {
          // Consume first message only
          break;
        }
      } catch (_e) {
        // Ignore errors for this test
      }

      expect(mockEvaluatorInstance.cleanup).toHaveBeenCalled();
    });
  });
});
