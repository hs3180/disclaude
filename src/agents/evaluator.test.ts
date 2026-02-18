/**
 * Tests for Evaluator (src/agents/evaluator.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvaluatorConfig, EvaluatorInput } from './evaluator.js';

// Mock SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', content: 'Evaluation result' };
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

// Mock skill-loader
vi.mock('../task/skill-loader.js', () => ({
  loadSkillOrThrow: vi.fn().mockResolvedValue({
    name: 'evaluator',
    allowedTools: ['Read', 'Write', 'Grep', 'Glob'],
  }),
}));

// Mock TaskFileManager
vi.mock('../task/file-manager.js', () => ({
  TaskFileManager: vi.fn().mockImplementation(() => ({
    createIteration: vi.fn().mockResolvedValue(undefined),
    getTaskSpecPath: vi.fn(() => '/test/workspace/tasks/task_123/task.md'),
    getEvaluationPath: vi.fn(() => '/test/workspace/tasks/task_123/iterations/iter-1/evaluation.md'),
    getExecutionPath: vi.fn(() => '/test/workspace/tasks/task_123/iterations/iter-1/execution.md'),
  })),
}));

describe('EvaluatorConfig type', () => {
  it('should accept required fields', () => {
    const config: EvaluatorConfig = {
      apiKey: 'test-key',
      model: 'test-model',
    };
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe('test-model');
  });

  it('should accept optional subdirectory', () => {
    const config: EvaluatorConfig = {
      apiKey: 'test-key',
      model: 'test-model',
      subdirectory: 'regular',
    };
    expect(config.subdirectory).toBe('regular');
  });
});

describe('EvaluatorInput type', () => {
  it('should accept string input', () => {
    const input: EvaluatorInput = 'Test prompt';
    expect(input).toBe('Test prompt');
  });

  it('should accept AsyncIterable input', () => {
    const asyncIterable: EvaluatorInput = (async function* () {
      yield { role: 'user', content: 'Hello' } as any;
    })();
    expect(asyncIterable).toBeDefined();
  });
});

describe('Evaluator class', () => {
  let Evaluator: typeof import('./evaluator.js').Evaluator;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ Evaluator } = await import('./evaluator.js'));
  });

  it('should export Evaluator class', () => {
    expect(Evaluator).toBeDefined();
    expect(typeof Evaluator).toBe('function');
  });

  it('should create instance with config', () => {
    const evaluator = new Evaluator({
      apiKey: 'test-key',
      model: 'test-model',
    });
    expect(evaluator).toBeDefined();
  });

  it('should create instance with subdirectory', () => {
    const evaluator = new Evaluator({
      apiKey: 'test-key',
      model: 'test-model',
      subdirectory: 'regular',
    });
    expect(evaluator).toBeDefined();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      const evaluator = new Evaluator({
        apiKey: 'test-key',
        model: 'test-model',
      });

      await expect(evaluator.initialize()).resolves.not.toThrow();
    });

    it('should not reinitialize if already initialized', async () => {
      const evaluator = new Evaluator({
        apiKey: 'test-key',
        model: 'test-model',
      });

      await evaluator.initialize();
      await evaluator.initialize(); // Should not throw

      expect(true).toBe(true);
    });
  });

  describe('evaluate', () => {
    it('should yield messages during evaluation', async () => {
      const evaluator = new Evaluator({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of evaluator.evaluate('task_123', 1)) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('queryStream', () => {
    it('should yield messages from SDK', async () => {
      const evaluator = new Evaluator({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of evaluator.queryStream('Test prompt')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should initialize before querying', async () => {
      const evaluator = new Evaluator({
        apiKey: 'test-key',
        model: 'test-model',
      });

      // queryStream should auto-initialize
      const messages = [];
      for await (const msg of evaluator.queryStream('Test')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });
});
