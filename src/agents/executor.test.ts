/**
 * Tests for Executor (src/agents/executor.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutorConfig, TaskProgressEvent, TaskResult } from './executor.js';

// Mock SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', content: 'Execution output' };
    },
  }),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    })),
    getGlobalEnv: vi.fn(() => ({})),
  },
}));

// Mock utils
vi.mock('../utils/sdk.js', () => ({
  parseSDKMessage: vi.fn((msg) => ({
    type: msg.type || 'text',
    content: msg.content || '',
    metadata: {},
  })),
  buildSdkEnv: vi.fn(() => ({})),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([
    { name: 'file1.txt', isFile: () => true },
    { name: 'summary.md', isFile: () => true },
  ]),
}));

// Mock TaskFileManager
vi.mock('../task/file-manager.js', () => ({
  TaskFileManager: vi.fn().mockImplementation(() => ({
    readEvaluation: vi.fn().mockResolvedValue('# Evaluation\nStatus: NEED_EXECUTE'),
    writeExecution: vi.fn().mockResolvedValue(undefined),
    getTaskSpecPath: vi.fn(() => '/test/workspace/tasks/task_123/task.md'),
    getEvaluationPath: vi.fn(() => '/test/workspace/tasks/task_123/iterations/iter-1/evaluation.md'),
    getExecutionPath: vi.fn(() => '/test/workspace/tasks/task_123/iterations/iter-1/execution.md'),
    getFinalResultPath: vi.fn(() => '/test/workspace/tasks/task_123/final_result.md'),
  })),
}));

describe('ExecutorConfig type', () => {
  it('should accept required fields', () => {
    const config: ExecutorConfig = {
      apiKey: 'test-key',
      model: 'test-model',
    };
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe('test-model');
  });

  it('should accept optional abortSignal', () => {
    const controller = new AbortController();
    const config: ExecutorConfig = {
      apiKey: 'test-key',
      model: 'test-model',
      abortSignal: controller.signal,
    };
    expect(config.abortSignal).toBe(controller.signal);
  });
});

describe('TaskProgressEvent types', () => {
  it('should support start event', () => {
    const event: TaskProgressEvent = {
      type: 'start',
      title: 'Test',
    };
    expect(event.type).toBe('start');
  });

  it('should support output event', () => {
    const event: TaskProgressEvent = {
      type: 'output',
      content: 'Working...',
      messageType: 'text',
    };
    expect(event.type).toBe('output');
  });

  it('should support complete event', () => {
    const event: TaskProgressEvent = {
      type: 'complete',
      summaryFile: '/path/to/summary.md',
      files: ['file1.txt'],
    };
    expect(event.type).toBe('complete');
  });

  it('should support error event', () => {
    const event: TaskProgressEvent = {
      type: 'error',
      error: 'Something went wrong',
    };
    expect(event.type).toBe('error');
  });
});

describe('TaskResult type', () => {
  it('should have success field', () => {
    const result: TaskResult = {
      success: true,
      summaryFile: '/path',
      files: [],
      output: '',
    };
    expect(result.success).toBe(true);
  });

  it('should have optional error field', () => {
    const result: TaskResult = {
      success: false,
      summaryFile: '/path',
      files: [],
      output: '',
      error: 'Failed',
    };
    expect(result.error).toBe('Failed');
  });
});

describe('Executor class', () => {
  let Executor: typeof import('./executor.js').Executor;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ Executor } = await import('./executor.js'));
  });

  it('should export Executor class', () => {
    expect(Executor).toBeDefined();
    expect(typeof Executor).toBe('function');
  });

  it('should create instance with config', () => {
    const executor = new Executor({
      apiKey: 'test-key',
      model: 'test-model',
    });
    expect(executor).toBeDefined();
  });

  it('should create instance with abortSignal', () => {
    const controller = new AbortController();
    const executor = new Executor({
      apiKey: 'test-key',
      model: 'test-model',
      abortSignal: controller.signal,
    });
    expect(executor).toBeDefined();
  });

  describe('executeTask', () => {
    it('should yield progress events', async () => {
      const executor = new Executor({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const events: TaskProgressEvent[] = [];
      const iterator = executor.executeTask('task_123', 1, '/test/workspace');

      // Collect all events
      let result = await iterator.next();
      while (!result.done) {
        events.push(result.value);
        result = await iterator.next();
      }

      // Should have start, output, and complete events
      expect(events.some(e => e.type === 'start')).toBe(true);
    });

    it('should throw on abort signal', async () => {
      const controller = new AbortController();
      controller.abort(); // Abort immediately

      const executor = new Executor({
        apiKey: 'test-key',
        model: 'test-model',
        abortSignal: controller.signal,
      });

      await expect(async () => {
        const iterator = executor.executeTask('task_123', 1, '/test/workspace');
        await iterator.next();
      }).rejects.toThrow('AbortError');
    });

    it('should return TaskResult when complete', async () => {
      const executor = new Executor({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const iterator = executor.executeTask('task_123', 1, '/test/workspace');

      // Consume all events
      let result = await iterator.next();
      while (!result.done) {
        result = await iterator.next();
      }

      // Final result should be TaskResult
      expect(result.value).toBeDefined();
      expect(result.value.success).toBe(true);
      expect(result.value.summaryFile).toBeDefined();
    });
  });
});
