/**
 * Tests for Reporter (src/agents/reporter.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReporterConfig } from './reporter.js';

// Mock SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', content: 'Report output' };
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
    name: 'reporter',
    allowedTools: ['send_user_feedback', 'send_file_to_feishu'],
  }),
}));

// Mock feishu-context-mcp
vi.mock('../mcp/feishu-context-mcp.js', () => ({
  feishuSdkMcpServer: {},
}));

describe('ReporterConfig type', () => {
  it('should accept required fields', () => {
    const config: ReporterConfig = {
      apiKey: 'test-key',
      model: 'test-model',
    };
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe('test-model');
  });
});

describe('Reporter class', () => {
  let Reporter: typeof import('./reporter.js').Reporter;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ Reporter } = await import('./reporter.js'));
  });

  it('should export Reporter class', () => {
    expect(Reporter).toBeDefined();
    expect(typeof Reporter).toBe('function');
  });

  it('should create instance with config', () => {
    const reporter = new Reporter({
      apiKey: 'test-key',
      model: 'test-model',
    });
    expect(reporter).toBeDefined();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      const reporter = new Reporter({
        apiKey: 'test-key',
        model: 'test-model',
      });

      await expect(reporter.initialize()).resolves.not.toThrow();
    });

    it('should not reinitialize if already initialized', async () => {
      const reporter = new Reporter({
        apiKey: 'test-key',
        model: 'test-model',
      });

      await reporter.initialize();
      await reporter.initialize(); // Should not throw

      expect(true).toBe(true);
    });
  });

  describe('report', () => {
    it('should yield messages during report generation', async () => {
      const reporter = new Reporter({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of reporter.report('# Task', 1, undefined, 'Evaluation')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });

    it('should handle worker output', async () => {
      const reporter = new Reporter({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of reporter.report('# Task', 2, 'Previous output', 'Evaluation')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });

  describe('sendFeedback', () => {
    it('should yield messages from SDK', async () => {
      const reporter = new Reporter({
        apiKey: 'test-key',
        model: 'test-model',
      });

      const messages = [];
      for await (const msg of reporter.sendFeedback('Test feedback')) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThan(0);
    });
  });
});

describe('buildEventFeedbackPrompt', () => {
  let Reporter: typeof import('./reporter.js').Reporter;

  beforeEach(async () => {
    ({ Reporter } = await import('./reporter.js'));
  });

  it('should build start event prompt', () => {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event: { type: 'start', title: 'Test Task' },
      taskId: 'task-123',
      iteration: 1,
    });
    expect(prompt).toContain('Task Started');
    expect(prompt).toContain('task-123');
    expect(prompt).toContain('Test Task');
  });

  it('should build complete event prompt with chatId', () => {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event: { type: 'complete', summaryFile: 'summary.md', files: ['file1.ts'] },
      taskId: 'task-123',
      iteration: 2,
      chatId: 'chat-456',
    });
    expect(prompt).toContain('Task Completed');
    expect(prompt).toContain('chat-456');
    expect(prompt).toContain('send_user_feedback');
  });

  it('should build complete event prompt without chatId', () => {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event: { type: 'complete', summaryFile: 'summary.md', files: [] },
      taskId: 'task-123',
      iteration: 2,
    });
    expect(prompt).toContain('Task Completed');
    // CLI mode doesn't require send_user_feedback
  });

  it('should build error event prompt with chatId', () => {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event: { type: 'error', error: 'Something failed' },
      taskId: 'task-123',
      iteration: 1,
      chatId: 'chat-456',
    });
    expect(prompt).toContain('Task Failed');
    expect(prompt).toContain('Something failed');
    expect(prompt).toContain('send_user_feedback');
  });

  it('should build error event prompt without chatId', () => {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event: { type: 'error', error: 'Something failed' },
      taskId: 'task-123',
      iteration: 1,
    });
    expect(prompt).toContain('Task Failed');
    expect(prompt).toContain('Something failed');
    expect(prompt).not.toContain('send_user_feedback');
  });

  it('should build output event prompt with chatId', () => {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event: { type: 'output', content: 'Progress update', messageType: 'text' },
      taskId: 'task-123',
      iteration: 1,
      chatId: 'chat-456',
    });
    expect(prompt).toContain('Progress Update');
    expect(prompt).toContain('chat-456');
    expect(prompt).toContain('send_user_feedback');
  });

  it('should build output event prompt without chatId', () => {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event: { type: 'output', content: 'Progress update', messageType: 'text' },
      taskId: 'task-123',
      iteration: 1,
    });
    expect(prompt).toContain('Progress Update');
    expect(prompt).toContain('Progress update');
  });

  it('should escape quotes in error message', () => {
    const prompt = Reporter.buildEventFeedbackPrompt({
      event: { type: 'error', error: 'Error with "quotes"' },
      taskId: 'task-123',
      iteration: 1,
      chatId: 'chat-456',
    });
    expect(prompt).toContain('\\"quotes\\"');
  });
});

describe('buildReportPrompt', () => {
  let Reporter: typeof import('./reporter.js').Reporter;

  beforeEach(async () => {
    ({ Reporter } = await import('./reporter.js'));
  });

  it('should build report prompt with task content', () => {
    const prompt = Reporter.buildReportPrompt(
      '# Task Description',
      1,
      undefined,
      'Evaluation content'
    );

    expect(prompt).toContain('Task Description');
    expect(prompt).toContain('Current Iteration: 1');
    expect(prompt).toContain('Evaluation content');
    expect(prompt).toContain('send_user_feedback');
  });

  it('should include worker output when provided', () => {
    const prompt = Reporter.buildReportPrompt(
      '# Task Description',
      2,
      'Previous iteration output',
      'Evaluation content'
    );

    expect(prompt).toContain('Previous iteration output');
    expect(prompt).toContain("Executor's Previous Output");
  });

  it('should handle first iteration without worker output', () => {
    const prompt = Reporter.buildReportPrompt(
      '# Task Description',
      1,
      undefined,
      'Evaluation content'
    );

    expect(prompt).toContain('No Executor output yet');
    expect(prompt).toContain('first iteration');
  });

  it('should include reporting instructions', () => {
    const prompt = Reporter.buildReportPrompt(
      '# Task Description',
      1,
      undefined,
      'Evaluation content'
    );

    expect(prompt).toContain('Your Reporting Task');
    expect(prompt).toContain('DO NOT');
  });
});
