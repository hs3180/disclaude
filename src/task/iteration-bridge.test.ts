/**
 * Tests for IterationBridge (src/task/iteration-bridge.ts)
 *
 * Tests the DIRECT Evaluator → Worker architecture:
 * - Phase 1: Evaluator evaluates task completion
 * - Phase 2: If not complete, Worker executes with Evaluator's feedback
 * - Only ONE Evaluator-Worker exchange per iteration (no internal loop)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IterationBridge } from './iteration-bridge.js';
import type { IterationBridgeConfig, IterationResult } from './iteration-bridge.js';
import type { EvaluatorConfig } from './evaluator.js';
import type { WorkerConfig } from './worker.js';

// Mock Evaluator and Worker classes
vi.mock('./evaluator.js', () => {
  const mockBuildEvaluationPrompt = vi.fn(() => 'mocked evaluation prompt');
  return {
    Evaluator: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      queryStream: vi.fn(),
      cleanup: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({
        result: {
          is_complete: false,
          reason: 'Task not complete',
          missing_items: ['Item 1'],
          confidence: 0.8,
        },
      }),
    })),
    buildEvaluationPrompt: mockBuildEvaluationPrompt,
    type: {},
  };
});

vi.mock('./worker.js', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    queryStream: vi.fn(),
    cleanup: vi.fn(),
  })),
  type: {},
}));

vi.mock('../utils/sdk.js', () => ({
  extractText: vi.fn((msg) => {
    if (typeof msg.content === 'string') return msg.content;
    if (msg.content && typeof msg.content === 'object' && 'text' in msg.content) {
      return (msg.content as { text: string }).text;
    }
    return '';
  }),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('./mcp-utils.js', () => ({
  isTaskDoneTool: vi.fn((msg: any) =>
    msg.messageType === 'tool_use' && msg.metadata?.toolName === 'task_done'
  ),
}));

import { Evaluator } from './evaluator.js';
import { Worker } from './worker.js';
import { extractText } from '../utils/sdk.js';

const mockedEvaluator = vi.mocked(Evaluator);
const mockedWorker = vi.mocked(Worker);
const mockedExtractText = vi.mocked(extractText);

// Mock static methods
(Worker as any).buildPrompt = vi.fn(() => 'mocked worker prompt');

describe('IterationBridge (Direct Evaluator-Worker Architecture)', () => {
  let iterationBridge: IterationBridge;
  let config: IterationBridgeConfig;
  let evaluatorConfig: EvaluatorConfig;
  let workerConfig: WorkerConfig;
  let mockEvaluatorInstance: any;
  let mockWorkerInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();

    evaluatorConfig = {
      apiKey: 'test-evaluator-key',
      model: 'claude-3-5-sonnet-20241022',
    };

    workerConfig = {
      apiKey: 'test-worker-key',
      model: 'claude-3-5-sonnet-20241022',
    };

    config = {
      evaluatorConfig,
      workerConfig,
      taskMdContent: '# Test Task\n\nDescription here',
      iteration: 1,
    };

    // Mock Evaluator instance
    mockEvaluatorInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      queryStream: vi.fn(),
      cleanup: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({
        result: {
          is_complete: false,
          reason: 'Task not complete',
          missing_items: ['Item 1', 'Item 2'],
          confidence: 0.8,
        },
      }),
    };

    // Mock Worker instance
    mockWorkerInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      queryStream: vi.fn(),
      cleanup: vi.fn(),
    };

    mockedEvaluator.mockImplementation(() => mockEvaluatorInstance as any);
    mockedWorker.mockImplementation(() => mockWorkerInstance as any);

    // Default extractText implementation
    mockedExtractText.mockImplementation((msg) => {
      if (typeof msg.content === 'string') return msg.content;
      if (msg.content && typeof msg.content === 'object' && 'text' in msg.content) {
        return (msg.content as { text: string }).text;
      }
      return '';
    });

    iterationBridge = new IterationBridge(config);
  });

  describe('constructor', () => {
    it('should create IterationBridge with config', () => {
      expect(iterationBridge).toBeInstanceOf(IterationBridge);
      expect(iterationBridge.iteration).toBe(1);
    });

    it('should store taskMdContent', () => {
      expect(iterationBridge.taskMdContent).toBe('# Test Task\n\nDescription here');
    });

    it('should accept previousWorkerOutput', () => {
      const configWithOutput: IterationBridgeConfig = {
        ...config,
        iteration: 2,
        previousWorkerOutput: 'Previous result',
      };

      const bridge = new IterationBridge(configWithOutput);
      expect(bridge.iteration).toBe(2);
      expect(bridge.previousWorkerOutput).toBe('Previous result');
    });
  });

  describe('runIterationStreaming (direct Evaluator-Worker)', () => {
    it('should execute single Evaluator-Worker exchange', async () => {
      const evaluatorInstance = mockEvaluatorInstance;

      // Phase 1: Evaluator evaluates task (not complete, provides missing_items)
      evaluatorInstance.queryStream.mockReturnValueOnce(async function* () {
        yield {
          content: JSON.stringify({ is_complete: false, missing_items: ['Implement feature X'] }),
          messageType: 'text',
          metadata: {},
        };
      }());

      const workerInstance = mockWorkerInstance;
      workerInstance.queryStream.mockReturnValueOnce(async function* () {
        yield { content: 'Feature X implemented', messageType: 'result', metadata: {} };
      }());

      const messages: any[] = [];
      for await (const msg of iterationBridge.runIterationStreaming()) {
        messages.push(msg);
      }

      expect(messages).toBeDefined();
      expect(evaluatorInstance.queryStream).toHaveBeenCalledTimes(1);
      expect(workerInstance.queryStream).toHaveBeenCalledTimes(1);
    });

    it('should skip Worker if Evaluator determines task is complete', async () => {
      const evaluatorInstance = mockEvaluatorInstance;

      // Evaluator determines task is complete
      evaluatorInstance.queryStream.mockReturnValueOnce(async function* () {
        yield {
          content: '',
          messageType: 'tool_use',
          metadata: { toolName: 'task_done' },
        };
      }());

      const workerInstance = mockWorkerInstance;

      const messages: any[] = [];
      for await (const msg of iterationBridge.runIterationStreaming()) {
        messages.push(msg);
      }

      // Worker should not be initialized/queried
      expect(workerInstance.initialize).not.toHaveBeenCalled();
      expect(workerInstance.queryStream).not.toHaveBeenCalled();
    });

    it('should cleanup both Evaluator and Worker', async () => {
      const evaluatorInstance = mockEvaluatorInstance;

      evaluatorInstance.queryStream.mockReturnValueOnce(async function* () {
        yield {
          content: JSON.stringify({ is_complete: false, missing_items: ['Do work'] }),
          messageType: 'text',
          metadata: {},
        };
      }());

      const workerInstance = mockWorkerInstance;
      workerInstance.queryStream.mockReturnValueOnce(async function* () {
        yield { content: 'Done', messageType: 'result', metadata: {} };
      }());

      for await (const _msg of iterationBridge.runIterationStreaming()) {
        // consume
      }

      expect(evaluatorInstance.cleanup).toHaveBeenCalled();
      expect(workerInstance.cleanup).toHaveBeenCalled();
    });
  });
});
