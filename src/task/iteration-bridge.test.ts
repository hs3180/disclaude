/**
 * Tests for IterationBridge (src/agent/iteration-bridge.ts)
 *
 * Tests the DUAL-COROUTINE architecture:
 * - Phase 1: Manager starts, produces instruction for Worker
 * - Phase 2: Worker executes with Manager's instruction
 * - Phase 3: Manager waits for Worker, processes result
 * - Only ONE Manager-Worker exchange per iteration (no internal loop)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IterationBridge } from './iteration-bridge.js';
import type { IterationBridgeConfig, IterationResult } from './iteration-bridge.js';
import type { ManagerConfig } from './manager.js';
import type { WorkerConfig } from './worker.js';

// Mock Manager and Worker classes
const mockBuildGenerateInstructionPrompt = vi.fn(() => 'mocked prompt');
const mockBuildFollowupPrompt = vi.fn(() => 'mocked followup');
const mockBuildPrompt = vi.fn(() => 'mocked worker prompt');

vi.mock('./manager.js', () => ({
  Manager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    queryStream: vi.fn(),
    cleanup: vi.fn(),
  })),
  type: {},
}));

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
  isUserFeedbackTool: vi.fn((msg: any) =>
    msg.messageType === 'tool_use' && msg.metadata?.toolName === 'send_user_feedback'
  ),
  isTaskDoneTool: vi.fn((msg: any) =>
    msg.messageType === 'tool_use' && msg.metadata?.toolName === 'task_done'
  ),
}));

import { Manager } from './manager.js';
import { Worker } from './worker.js';
import { extractText } from '../utils/sdk.js';

// Assign static method mocks
(Manager as any).buildGenerateInstructionPrompt = mockBuildGenerateInstructionPrompt;
(Manager as any).buildFollowupPrompt = mockBuildFollowupPrompt;
(Worker as any).buildPrompt = mockBuildPrompt;

const mockedManager = vi.mocked(Manager);
const mockedWorker = vi.mocked(Worker);
const mockedExtractText = vi.mocked(extractText);

describe('IterationBridge (Dual-Coroutine Architecture)', () => {
  let iterationBridge: IterationBridge;
  let config: IterationBridgeConfig;
  let managerConfig: ManagerConfig;
  let workerConfig: WorkerConfig;
  let mockManagerInstance: any;
  let mockWorkerInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();

    managerConfig = {
      apiKey: 'test-manager-key',
      model: 'claude-3-5-sonnet-20241022',
    };

    workerConfig = {
      apiKey: 'test-worker-key',
      model: 'claude-3-5-sonnet-20241022',
    };

    config = {
      managerConfig,
      workerConfig,
      taskMdContent: '# Test Task\n\nDescription here',
      iteration: 1,
    };

    // Mock Manager instance
    mockManagerInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      queryStream: vi.fn(),
      cleanup: vi.fn(),
    };

    // Mock Worker instance
    mockWorkerInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      queryStream: vi.fn(),
      cleanup: vi.fn(),
    };

    mockedManager.mockImplementation(() => mockManagerInstance as any);
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
        previousWorkerOutput: 'Previous worker result',
      };

      const bridge = new IterationBridge(configWithOutput);
      expect(bridge).toBeInstanceOf(IterationBridge);
    });
  });

  describe('runIterationStreaming (dual-coroutine)', () => {
    it('should execute single Manager-Worker exchange', async () => {
      const managerInstance = mockManagerInstance;

      // Phase 1: Manager produces instruction
      // Phase 3: Manager processes Worker result
      let callCount = 0;
      managerInstance.queryStream.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          // Phase 1: Manager instruction
          yield { content: 'Execute this task', messageType: 'text', metadata: {} };
        } else {
          // Phase 3: Manager processes result
          yield { content: 'Task complete', messageType: 'text', metadata: {} };
        }
      });

      const workerInstance = mockWorkerInstance;
      // Phase 2: Worker executes and returns result
      workerInstance.queryStream.mockReturnValueOnce(async function* () {
        yield { content: 'Worker result here', messageType: 'result', metadata: {} };
      }());

      // Collect all yielded messages
      const messages: any[] = [];
      for await (const msg of iterationBridge.runIterationStreaming()) {
        messages.push(msg);
      }

      expect(messages).toBeDefined();
      expect(callCount).toBe(2); // Manager called twice (instruction + process result)
      expect(workerInstance.queryStream).toHaveBeenCalledTimes(1); // Worker called once
    });

    it('should yield send_user_feedback messages from Manager', async () => {
      const managerInstance = mockManagerInstance;

      let callCount = 0;
      managerInstance.queryStream.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          // Phase 1: Manager sends feedback and produces instruction
          yield {
            content: '',
            messageType: 'tool_use',
            metadata: {
              toolName: 'send_user_feedback',
              toolInputRaw: { content: 'Starting task...', format: 'text' },
            },
          };
          yield { content: 'Execute task', messageType: 'text', metadata: {} };
        } else {
          // Phase 3: Manager processes result
          yield { content: 'Done', messageType: 'text', metadata: {} };
        }
      });

      const workerInstance = mockWorkerInstance;
      workerInstance.queryStream.mockReturnValueOnce(async function* () {
        yield { content: 'Result', messageType: 'result', metadata: {} };
      }());

      const messages: any[] = [];
      for await (const msg of iterationBridge.runIterationStreaming()) {
        messages.push(msg);
      }

      const feedbackMessages = messages.filter(
        (m) => m.metadata?.toolName === 'send_user_feedback'
      );
      expect(feedbackMessages.length).toBeGreaterThan(0);
    });

    it('should skip Worker if Manager calls task_done directly', async () => {
      const managerInstance = mockManagerInstance;

      // Manager calls task_done immediately
      managerInstance.queryStream.mockReturnValueOnce(async function* () {
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

    it('should cleanup both Manager and Worker', async () => {
      const managerInstance = mockManagerInstance;

      let callCount = 0;
      managerInstance.queryStream.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          yield { content: 'Do work', messageType: 'text', metadata: {} };
        } else {
          yield { content: 'Finished', messageType: 'text', metadata: {} };
        }
      });

      const workerInstance = mockWorkerInstance;
      workerInstance.queryStream.mockReturnValueOnce(async function* () {
        yield { content: 'Done', messageType: 'result', metadata: {} };
      }());

      for await (const _msg of iterationBridge.runIterationStreaming()) {
        // consume
      }

      expect(managerInstance.cleanup).toHaveBeenCalled();
      expect(workerInstance.cleanup).toHaveBeenCalled();
    });
  });

  describe('runIteration (legacy)', () => {
    it('should return buffered results from streaming', async () => {
      const managerInstance = mockManagerInstance;

      let callCount = 0;
      managerInstance.queryStream.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          // Phase 1: Manager produces instruction (not yielded, only stored)
          yield { content: 'Instruction', messageType: 'text', metadata: {} };
        } else {
          // Phase 3: Manager processes result
          yield { content: 'Complete', messageType: 'text', metadata: {} };
        }
      });

      const workerInstance = mockWorkerInstance;
      workerInstance.queryStream.mockReturnValueOnce(async function* () {
        yield { content: 'Worker result', messageType: 'result', metadata: {} };
      }());

      const result = await iterationBridge.runIteration();

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
      // Manager's text output in Phase 3 should be collected
      expect(result.managerOutput).toContain('Complete');
      // Worker output should be collected from queue
      expect(result.workerOutput).toContain('Worker result');
    });

    it('should handle Manager task_done', async () => {
      const managerInstance = mockManagerInstance;

      managerInstance.queryStream.mockReturnValueOnce(async function* () {
        yield {
          content: '',
          messageType: 'tool_use',
          metadata: { toolName: 'task_done' },
        };
      }());

      const result = await iterationBridge.runIteration();

      expect(result.taskDone).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle Manager query errors', async () => {
      const managerInstance = mockManagerInstance;

      managerInstance.queryStream.mockImplementation(() => {
        throw new Error('Manager error');
      });

      // Should throw error
      await expect(iterationBridge.runIteration()).rejects.toThrow('Manager error');
    });

    it('should cleanup on error', async () => {
      const managerInstance = mockManagerInstance;

      managerInstance.queryStream.mockImplementation(() => {
        throw new Error('Error');
      });

      try {
        await iterationBridge.runIteration();
      } catch (e) {
        // Expected
      }

      // Cleanup should still happen
      expect(managerInstance.cleanup).toHaveBeenCalled();
    });
  });
});
