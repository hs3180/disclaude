/**
 * Tests for Executor (src/agents/executor.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskProgressEvent } from './executor.js';

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
    getLoggingConfig: vi.fn(() => ({
      level: 'info',
      pretty: true,
      rotate: false,
      sdkDebug: true,
    })),
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
vi.mock('../task/task-files.js', () => ({
  TaskFileManager: vi.fn().mockImplementation(() => ({
    readEvaluation: vi.fn().mockResolvedValue('# Evaluation\nStatus: NEED_EXECUTE'),
    writeExecution: vi.fn().mockResolvedValue(undefined),
    getTaskSpecPath: vi.fn(() => '/test/workspace/tasks/task_123/task.md'),
    getEvaluationPath: vi.fn(() => '/test/workspace/tasks/task_123/iterations/iter-1/evaluation.md'),
    getExecutionPath: vi.fn(() => '/test/workspace/tasks/task_123/iterations/iter-1/execution.md'),
    getFinalResultPath: vi.fn(() => '/test/workspace/tasks/task_123/final_result.md'),
  })),
}));

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

describe('Executor SkillAgent Interface', () => {
  let Executor: typeof import('./executor.js').Executor;
  let isSkillAgent: typeof import('./types.js').isSkillAgent;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ Executor } = await import('./executor.js'));
    ({ isSkillAgent } = await import('./types.js'));
  });

  it('should implement SkillAgent interface', () => {
    const executor = new Executor({
      apiKey: 'test-key',
      model: 'test-model',
    });

    expect(executor.type).toBe('skill');
    expect(executor.name).toBe('Executor');
    expect(typeof executor.execute).toBe('function');
    expect(typeof executor.cleanup).toBe('function');
  });

  it('should pass isSkillAgent type guard', () => {
    const executor = new Executor({
      apiKey: 'test-key',
      model: 'test-model',
    });

    expect(isSkillAgent(executor)).toBe(true);
  });

  describe('execute', () => {
    it('should accept string input', async () => {
      const executor = new Executor({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of executor.execute('Test prompt')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should accept UserInput array', async () => {
      const executor = new Executor({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of executor.execute([
        { role: 'user', content: 'First message' },
        { role: 'user', content: 'Second message' },
      ])) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });
});
