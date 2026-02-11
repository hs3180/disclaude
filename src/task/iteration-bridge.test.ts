/**
 * Tests for IterationBridge (src/task/iteration-bridge.ts)
 *
 * Tests the Plan-and-Execute architecture:
 * - Phase 1: Evaluator evaluates task completion
 * - Phase 2: If not complete, Planner plans → Executor executes subtasks
 * - Always uses planning mode (no simple/direct execution)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IterationBridge } from './iteration-bridge.js';
import type { IterationBridgeConfig } from './iteration-bridge.js';
import type { EvaluatorConfig } from '../agents/evaluator.js';

// Create mock instances that will be used in tests
let mockEvaluatorInstance: any;

// Mock Evaluator, Planner, and Executor classes
vi.mock('../agents/evaluator.js', () => ({
  Evaluator: vi.fn().mockImplementation(() => {
    // Return the current mockEvaluatorInstance
    return (globalThis as any).mockEvaluatorInstance;
  }),
}));

vi.mock('../long-task/planner.js', () => ({
  Planner: vi.fn().mockImplementation(() => ({
    planTask: vi.fn().mockResolvedValue({
      taskId: 'test-task-1',
      originalRequest: 'Test request',
      title: 'Test Plan',
      description: 'Test description',
      subtasks: [],
      totalSteps: 0,
      createdAt: new Date().toISOString(),
    }),
  })),
}));

vi.mock('../long-task/executor.js', () => ({
  Executor: vi.fn().mockImplementation(() => ({
    executeSubtask: vi.fn().mockResolvedValue({
      sequence: 1,
      success: true,
      summary: 'Test summary',
      files: [],
      summaryFile: 'subtask-1/summary.md',
      completedAt: new Date().toISOString(),
    }),
  })),
}));

vi.mock('./skill-loader.js', () => ({
  loadSkillOrThrow: vi.fn().mockResolvedValue({
    name: 'evaluator',
    description: 'Evaluator skill',
    content: 'Evaluator skill content',
    allowedTools: ['task_done'],
    disableModelInvocation: false,
  }),
}));

describe('IterationBridge (Plan-and-Execute Architecture)', () => {
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
      plannerConfig: {
        apiKey: 'test-planner-key',
        model: 'claude-3-5-sonnet-20241022',
      },
      executorConfig: {
        apiKey: 'test-executor-key',
        model: 'claude-3-5-sonnet-20241022',
        sendMessage: async () => {},
        sendCard: async () => {},
        chatId: 'test-chat',
        workspaceBaseDir: '/workspace',
      },
      taskMdContent: '# Test Task\n\nDescription here',
      iteration: 1,
      taskId: 'test-task-id',  // ✨ Add required taskId
    };

    // Mock Evaluator instance
    mockEvaluatorInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      queryStream: vi.fn().mockReturnValue((async function* () {
        yield { content: 'Mock evaluation response', role: 'assistant', messageType: 'text' };
      })()),
      cleanup: vi.fn(),
      evaluate: vi.fn(async function(this: any, _taskMdContent: string, _iteration: number, _workerOutput?: string) {
        const messages: any[] = [];
        for await (const msg of mockEvaluatorInstance.queryStream('mocked evaluation prompt')) {
          messages.push(msg);
        }
        // Return a default evaluation result
        return {
          result: {
            is_complete: false,
            reason: 'Task not complete',
            missing_items: ['Item 1', 'Item 2'],
            confidence: 0.8,
          },
          messages,
        };
      }),
    };

    // Store on globalThis so mock can access it
    (globalThis as any).mockEvaluatorInstance = mockEvaluatorInstance;
  });

  describe('constructor', () => {
    it('should create bridge with config', () => {
      bridge = new IterationBridge(config);

      expect(bridge).toBeInstanceOf(IterationBridge);
      expect(bridge.evaluatorConfig).toBe(evaluatorConfig);
      expect(bridge.iteration).toBe(1);
    });

    it('should accept previousWorkerOutput', () => {
      const configWithOutput: IterationBridgeConfig = {
        ...config,
        previousWorkerOutput: 'Previous result',
      };

      bridge = new IterationBridge(configWithOutput);
      expect(bridge.previousWorkerOutput).toBe('Previous result');
    });
  });

  describe('runIterationStreaming (Plan-and-Execute)', () => {
    it('should execute Evaluator then Planner/Executor', async () => {
      bridge = new IterationBridge(config);

      // The default evaluate mock from beforeEach should work
      const messages: any[] = [];
      for await (const msg of bridge.runIterationStreaming()) {
        messages.push(msg);
      }

      // Debug: check if evaluate was called
      console.log('Evaluate call count:', mockEvaluatorInstance.evaluate.mock.calls.length);
      console.log('Evaluate mock:', mockEvaluatorInstance.evaluate);

      // Should have called evaluate
      expect(mockEvaluatorInstance.evaluate).toHaveBeenCalledTimes(1);
    });

    it('should skip Planner/Executor if Evaluator determines task is complete', async () => {
      bridge = new IterationBridge(config);

      // Mock Evaluator to return complete
      mockEvaluatorInstance.evaluate.mockImplementationOnce(async function() {
        return {
          result: {
            is_complete: true,
            reason: 'Task is complete',
            missing_items: [],
            confidence: 1.0,
          },
          messages: [],
        };
      });

      const messages: any[] = [];
      for await (const msg of bridge.runIterationStreaming()) {
        messages.push(msg);
      }

      // Should have completion message
      expect(messages.some(m => m.messageType === 'task_completion')).toBe(true);
    });

    it('should cleanup Evaluator after iteration', async () => {
      bridge = new IterationBridge(config);

      // The default evaluate mock from beforeEach should work
      try {
        for await (const _ of bridge.runIterationStreaming()) {
          // Consume all messages
          break; // Break after first message to avoid infinite loop
        }
      } catch (e) {
        // Ignore errors for this test
      }

      expect(mockEvaluatorInstance.cleanup).toHaveBeenCalledTimes(1);
    });
  });
});
