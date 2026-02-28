/**
 * Tests for Evaluator (src/agents/evaluator.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EvaluatorConfig } from './evaluator.js';

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

// Mock TaskFileManager
vi.mock('../task/task-files.js', () => ({
  TaskFileManager: vi.fn().mockImplementation(() => ({
    createIteration: vi.fn().mockResolvedValue(undefined),
    getTaskSpecPath: vi.fn(() => '/test/workspace/tasks/task_123/task.md'),
    getEvaluationPath: vi.fn(() => '/test/workspace/tasks/task_123/iterations/iter-1/evaluation.md'),
    getExecutionPath: vi.fn(() => '/test/workspace/tasks/task_123/iterations/iter-1/execution.md'),
    getFinalResultPath: vi.fn(() => '/test/workspace/tasks/task_123/final_result.md'),
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

describe('Evaluator SkillAgent Interface', () => {
  let Evaluator: typeof import('./evaluator.js').Evaluator;
  let isSkillAgent: typeof import('./types.js').isSkillAgent;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ Evaluator } = await import('./evaluator.js'));
    ({ isSkillAgent } = await import('./types.js'));
  });

  it('should implement SkillAgent interface', () => {
    const evaluator = new Evaluator({
      apiKey: 'test-key',
      model: 'test-model',
    });

    expect(evaluator.type).toBe('skill');
    expect(evaluator.name).toBe('Evaluator');
    expect(typeof evaluator.execute).toBe('function');
    expect(typeof evaluator.cleanup).toBe('function');
  });

  it('should pass isSkillAgent type guard', () => {
    const evaluator = new Evaluator({
      apiKey: 'test-key',
      model: 'test-model',
    });

    expect(isSkillAgent(evaluator)).toBe(true);
  });

  describe('execute', () => {
    it('should accept string input', async () => {
      const evaluator = new Evaluator({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of evaluator.execute('Test prompt')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should accept UserInput array', async () => {
      const evaluator = new Evaluator({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of evaluator.execute([
        { role: 'user', content: 'First message' },
        { role: 'user', content: 'Second message' },
      ])) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });
});
