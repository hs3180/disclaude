/**
 * Tests for BaseAgent (src/agents/base-agent.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseAgent, type BaseAgentConfig, type SdkOptionsExtra, type IteratorYieldResult } from './base-agent.js';
import { isDisposable } from './types.js';

// Mock SDK provider
vi.mock('../sdk/index.js', () => ({
  getProvider: vi.fn(() => ({
    queryOnce: vi.fn(async function* () {
      yield { type: 'text', content: 'Hello', role: 'assistant' };
    }),
    queryStream: vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () {
        yield { type: 'text', content: 'Hello', role: 'assistant' };
      })(),
    })),
  })),
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

// Create a concrete implementation for testing
class TestAgent extends BaseAgent {
  protected getAgentName(): string {
    return 'TestAgent';
  }

  // Expose protected methods for testing
  testCreateSdkOptions(extra?: SdkOptionsExtra) {
    return this.createSdkOptions(extra);
  }

  async *testQueryOnce(input: string) {
    yield* this.queryOnce(input, { settingSources: ['project'] });
  }

  testFormatMessage(parsed: IteratorYieldResult['parsed']) {
    return this.formatMessage(parsed);
  }

  testHandleIteratorError(error: unknown, operation: string) {
    return this.handleIteratorError(error, operation);
  }
}

describe('BaseAgent', () => {
  let agent: TestAgent;
  const config: BaseAgentConfig = {
    apiKey: 'test-api-key',
    model: 'test-model',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new TestAgent(config);
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(agent.apiKey).toBe('test-api-key');
      expect(agent.model).toBe('test-model');
    });

    it('should use default permissionMode', () => {
      expect(agent.permissionMode).toBe('bypassPermissions');
    });

    it('should accept custom permissionMode', () => {
      const customAgent = new TestAgent({
        ...config,
        permissionMode: 'default',
      });
      expect(customAgent.permissionMode).toBe('default');
    });

    it('should accept optional apiBaseUrl', () => {
      const customAgent = new TestAgent({
        ...config,
        apiBaseUrl: 'https://custom.api.com',
      });
      expect(customAgent.apiBaseUrl).toBe('https://custom.api.com');
    });
  });

  describe('createSdkOptions', () => {
    it('should create options with defaults', () => {
      const options = agent.testCreateSdkOptions();

      expect(options.cwd).toBeDefined();
      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.settingSources).toContain('project');
      expect(options.env).toBeDefined();
    });

    it('should include allowedTools when provided', () => {
      const options = agent.testCreateSdkOptions({
        allowedTools: ['Read', 'Write'],
      });

      expect(options.allowedTools).toEqual(['Read', 'Write']);
    });

    it('should include disallowedTools when provided', () => {
      const options = agent.testCreateSdkOptions({
        disallowedTools: ['Bash'],
      });

      expect(options.disallowedTools).toEqual(['Bash']);
    });

    it('should include mcpServers when provided', () => {
      const mcpServers = { 'test-server': { type: 'stdio' as const, command: 'test' } };
      const options = agent.testCreateSdkOptions({
        mcpServers,
      });

      expect(options.mcpServers).toEqual(mcpServers);
    });

    it('should use custom cwd when provided', () => {
      const options = agent.testCreateSdkOptions({
        cwd: '/custom/workspace',
      });

      expect(options.cwd).toBe('/custom/workspace');
    });

    it('should include model', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.model).toBe('test-model');
    });
  });

  describe('formatMessage', () => {
    it('should format parsed message as AgentMessage', () => {
      const parsed: IteratorYieldResult['parsed'] = {
        type: 'text',
        content: 'Hello, world!',
        metadata: { toolName: 'test' },
      };

      const message = agent.testFormatMessage(parsed);

      expect(message.content).toBe('Hello, world!');
      expect(message.role).toBe('assistant');
      expect(message.messageType).toBe('text');
      expect(message.metadata).toEqual({ toolName: 'test' });
    });
  });

  describe('handleIteratorError', () => {
    it('should create error message from Error object', () => {
      const error = new Error('Test error');
      const message = agent.testHandleIteratorError(error, 'test');

      expect(message.content).toContain('Error: Test error');
      expect(message.messageType).toBe('error');
      expect(message.role).toBe('assistant');
    });

    it('should handle non-Error objects', () => {
      const message = agent.testHandleIteratorError('string error', 'test');

      expect(message.content).toContain('string error');
      expect(message.messageType).toBe('error');
    });
  });

  describe('dispose', () => {
    it('should reset initialized flag', () => {
      agent['initialized'] = true;
      agent.dispose();

      expect(agent['initialized']).toBe(false);
    });

    it('should be idempotent', () => {
      agent['initialized'] = true;
      agent.dispose();
      expect(agent['initialized']).toBe(false);

      // Call again should not throw
      expect(() => agent.dispose()).not.toThrow();
      expect(agent['initialized']).toBe(false);
    });
  });

  describe('Disposable interface', () => {
    it('should implement Disposable interface', () => {
      expect(isDisposable(agent)).toBe(true);
    });

    it('should have dispose method', () => {
      expect(typeof agent.dispose).toBe('function');
    });
  });

  describe('getAgentName', () => {
    it('should return agent name', () => {
      expect(agent['getAgentName']()).toBe('TestAgent');
    });
  });
});
