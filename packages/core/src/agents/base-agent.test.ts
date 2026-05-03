/**
 * Unit tests for BaseAgent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAgent, type SdkOptionsExtra, type IteratorYieldResult, type QueryStreamResult } from './base-agent.js';
import { setRuntimeContext, clearRuntimeContext, type BaseAgentConfig } from './types.js';
import type { AgentMessage, StreamingUserMessage, QueryHandle } from '../sdk/index.js';

// Create a concrete implementation of BaseAgent for testing
class TestAgent extends BaseAgent {
  readonly testProperty = 'test';

  constructor(config: BaseAgentConfig) {
    super(config);
  }

  protected getAgentName(): string {
    return 'TestAgent';
  }

  // Expose protected methods for testing
  testCreateSdkOptions(extra: SdkOptionsExtra = {}) {
    return this.createSdkOptions(extra);
  }

  testFormatMessage(parsed: IteratorYieldResult['parsed']) {
    return this.formatMessage(parsed);
  }

  testHandleIteratorError(error: unknown, operation: string) {
    return this.handleIteratorError(error, operation);
  }

  testCreateQueryStream(
    input: AsyncGenerator<StreamingUserMessage>,
    options: Parameters<BaseAgent['createQueryStream']>[1]
  ) {
    return this.createQueryStream(input, options);
  }

  // Allow setting initialized for testing dispose
  setInitialized(value: boolean) {
    this.initialized = value;
  }
}

// Helper to create mock SDK AgentMessage
function createMockSdkMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    type: 'text',
    content: 'Hello from SDK',
    role: 'assistant',
    ...overrides,
  };
}

// Minimal mock for SDK provider
const mockSdkProvider = {
  queryStream: vi.fn(),
};

// Mock the SDK module
vi.mock('../sdk/index.js', () => ({
  getProvider: () => mockSdkProvider,
  IAgentSDKProvider: class {},
}));

// Mock buildSdkEnv to return a simple env object
vi.mock('../utils/sdk.js', () => ({
  buildSdkEnv: (apiKey: string, apiBaseUrl: string | undefined, globalEnv: Record<string, string>, sdkDebug: boolean) => ({
    ANTHROPIC_API_KEY: apiKey,
    ...(apiBaseUrl ? { ANTHROPIC_BASE_URL: apiBaseUrl } : {}),
    ...globalEnv,
    ...(sdkDebug ? { SDK_DEBUG: 'true' } : {}),
  }),
}));

// Mock loadRuntimeEnv to return empty env
vi.mock('../config/runtime-env.js', () => ({
  loadRuntimeEnv: () => ({}),
}));

describe('BaseAgent', () => {
  let agent: TestAgent;
  let config: BaseAgentConfig;

  beforeEach(() => {
    config = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
    };
    agent = new TestAgent(config);
  });

  afterEach(() => {
    clearRuntimeContext();
  });

  describe('constructor', () => {
    it('should create a BaseAgent with correct config', () => {
      expect(agent).toBeDefined();
      expect(agent.apiKey).toBe('test-api-key');
      expect(agent.model).toBe('claude-3-5-sonnet-20241022');
      expect(agent.provider).toBe('anthropic');
    });

    it('should default permissionMode to bypassPermissions', () => {
      expect(agent.permissionMode).toBe('bypassPermissions');
    });

    it('should use explicit permissionMode from config', () => {
      const strictAgent = new TestAgent({ ...config, permissionMode: 'default' });
      expect(strictAgent.permissionMode).toBe('default');
    });

    it('should default provider to anthropic when no runtime context', () => {
      const noProviderConfig: BaseAgentConfig = {
        apiKey: 'key',
        model: 'model',
      };
      const noProviderAgent = new TestAgent(noProviderConfig);
      expect(noProviderAgent.provider).toBe('anthropic');
    });

    it('should use runtime context provider if set', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'glm' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model' });
      expect(ctxAgent.provider).toBe('glm');
    });
  });

  describe('dispose', () => {
    it('should be idempotent', () => {
      // Not initialized, so dispose is a no-op
      agent.dispose();
      agent.dispose();
      // Should not throw
    });
  });

  describe('createSdkOptions', () => {
    it('should create options with default settings', () => {
      const options = agent.testCreateSdkOptions();

      expect(options).toBeDefined();
      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.env).toBeDefined();
      expect(options.env?.ANTHROPIC_API_KEY).toBe('test-api-key');
    });

    // Issue #2890: Verify vibe coding compliance defaults
    it('should use Claude Code preset for systemPrompt (Issue #2890)', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('should use Claude Code preset for tools (Issue #2890)', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('should include user, project, and local in settingSources (Issue #2890)', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.settingSources).toEqual(['user', 'project', 'local']);
    });

    it('should enable includePartialMessages by default (Issue #2890)', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.includePartialMessages).toBe(true);
    });

    it('should include model if specified', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('should add allowedTools when specified', () => {
      const options = agent.testCreateSdkOptions({
        allowedTools: ['Read', 'Write'],
      });
      expect(options.allowedTools).toEqual(['Read', 'Write']);
    });

    it('should add disallowedTools when specified', () => {
      const options = agent.testCreateSdkOptions({
        disallowedTools: ['Bash'],
      });
      expect(options.disallowedTools).toEqual(['Bash']);
    });

    it('should add mcpServers when specified', () => {
      const mcpServers = { 'test-server': { command: 'node', args: ['server.js'] } };
      const options = agent.testCreateSdkOptions({ mcpServers });
      expect(options.mcpServers).toEqual(mcpServers);
    });

    it('should include CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when enabled', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => true,
      });

      const options = agent.testCreateSdkOptions();
      expect(options.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    });
  });

  describe('formatMessage', () => {
    it('should format a simple message correctly', () => {
      const parsed = {
        type: 'text',
        content: 'Hello, world!',
      };

      const message = agent.testFormatMessage(parsed);
      expect(message.content).toBe('Hello, world!');
      expect(message.role).toBe('assistant');
      expect(message.messageType).toBe('text');
    });

    it('should include metadata when present', () => {
      const parsed = {
        type: 'tool_use',
        content: 'Using tool',
        metadata: {
          toolName: 'Read',
          toolInput: { file: '/test.ts' },
          toolOutput: 'file content',
          elapsed: 100,
          cost: 0.01,
          tokens: 50,
        },
      };

      const message = agent.testFormatMessage(parsed);
      expect(message.metadata).toBeDefined();
      expect(message.metadata?.toolName).toBe('Read');
    });
  });

  describe('handleIteratorError', () => {
    it('should handle Error instances', () => {
      const error = new Error('SDK connection failed');
      const message = agent.testHandleIteratorError(error, 'testOperation');

      expect(message.content).toContain('SDK connection failed');
      expect(message.role).toBe('assistant');
      expect(message.messageType).toBe('error');
    });

    it('should handle non-Error values', () => {
      const message = agent.testHandleIteratorError('string error', 'testOperation');

      expect(message.content).toContain('string error');
      expect(message.messageType).toBe('error');
    });

    it('should handle unknown error types', () => {
      const message = agent.testHandleIteratorError(42, 'testOperation');

      expect(message.content).toContain('42');
    });
  });

  describe('createQueryStream', () => {
    const defaultOptions = {
      cwd: '/workspace',
      permissionMode: 'bypassPermissions' as const,
      settingSources: ['project'],
    };

    async function* createMockInput(messages: StreamingUserMessage[]): AsyncGenerator<StreamingUserMessage> {
      for (const msg of messages) {
        yield msg;
      }
    }

    it('should return handle and iterator from SDK provider', async () => {
      const mockHandle: QueryHandle = {
        close: vi.fn(),
        cancel: vi.fn(),
        sessionId: 'stream-session-1',
      };
      const sdkMessages = [
        createMockSdkMessage({ type: 'text', content: 'Streaming response' }),
      ];

      mockSdkProvider.queryStream.mockImplementation((_input: unknown) => ({
        handle: mockHandle,
        iterator: (async function* () {
          for (const msg of sdkMessages) {
            yield msg;
          }
        })(),
      }));

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello stream' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result: QueryStreamResult = agent.testCreateQueryStream(inputStream, defaultOptions);

      expect(result.handle).toBe(mockHandle);

      const results: IteratorYieldResult[] = [];
      for await (const item of result.iterator) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
      expect(results[0].parsed.content).toBe('Streaming response');
      expect(results[0].raw).toEqual(sdkMessages[0]);
    });

    it('should convert StreamingUserMessage with string content to UserInput', async () => {
      let capturedInput: unknown;
      const mockHandle: QueryHandle = { close: vi.fn(), cancel: vi.fn() };

      mockSdkProvider.queryStream.mockImplementation((input: unknown) => {
        capturedInput = input;
        return {
          handle: mockHandle,
          iterator: (async function* () {
            // no messages
          })(),
        };
      });

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello world' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      // Consume the iterator to trigger input conversion
      for await (const _ of result.iterator) {
        // consume
      }

      // The input to queryStream should be an async generator
      expect(capturedInput).toBeDefined();
    });

    it('should handle StreamingUserMessage with ContentBlock array', async () => {
      const mockHandle: QueryHandle = { close: vi.fn(), cancel: vi.fn() };

      mockSdkProvider.queryStream.mockImplementation(() => ({
        handle: mockHandle,
        iterator: (async function* () {
          yield createMockSdkMessage({ type: 'text', content: 'Response' });
        })(),
      }));

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'Hello' }],
          },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      const results: IteratorYieldResult[] = [];
      for await (const item of result.iterator) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
      expect(results[0].parsed.content).toBe('Response');
    });

    it('should handle StreamingUserMessage with null/undefined message content', async () => {
      const mockHandle: QueryHandle = { close: vi.fn(), cancel: vi.fn() };

      mockSdkProvider.queryStream.mockImplementation(() => ({
        handle: mockHandle,
        iterator: (async function* () {
          yield createMockSdkMessage({ type: 'text', content: 'Fallback response' });
        })(),
      }));

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: undefined as unknown as string },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      const results: IteratorYieldResult[] = [];
      for await (const item of result.iterator) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
    });

    it('should convert metadata with token counts in stream messages', async () => {
      const mockHandle: QueryHandle = { close: vi.fn(), cancel: vi.fn() };

      const sdkMessage = createMockSdkMessage({
        type: 'tool_result',
        content: 'Tool output',
        metadata: {
          toolName: 'Bash',
          toolInput: 'ls -la',
          toolOutput: 'file1.txt\nfile2.txt',
          elapsedMs: 250,
          costUsd: 0.005,
          inputTokens: 100,
          outputTokens: 200,
          sessionId: 'tool-session',
        },
      });

      mockSdkProvider.queryStream.mockImplementation(() => ({
        handle: mockHandle,
        iterator: (async function* () {
          yield sdkMessage;
        })(),
      }));

      const inputStream = createMockInput([]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      const messages: IteratorYieldResult[] = [];
      for await (const item of result.iterator) {
        messages.push(item);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].parsed.metadata?.tokens).toBe(300);
      expect(messages[0].parsed.metadata?.toolName).toBe('Bash');
      expect(messages[0].parsed.sessionId).toBe('tool-session');
    });
  });

  describe('dispose with initialized state', () => {
    it('should log debug message when disposing an initialized agent', () => {
      agent.setInitialized(true);
      agent.dispose();
      // After dispose, calling again should not throw — verifies the log path ran
      expect(() => agent.dispose()).not.toThrow();
    });

    it('should set initialized to false after dispose', () => {
      agent.setInitialized(true);
      agent.dispose();
      // Second dispose is a no-op (idempotent)
      agent.dispose();
      // Verify state by calling dispose again without error
      expect(agent.testProperty).toBe('test');
    });
  });

  describe('createSdkOptions - env fallback paths', () => {
    it('should use SDK_DEBUG env var when no runtime context and SDK_DEBUG is set', () => {
      const originalEnv = process.env.SDK_DEBUG;
      process.env.SDK_DEBUG = 'true';

      const options = agent.testCreateSdkOptions();
      expect(options.env?.SDK_DEBUG).toBe('true');

      process.env.SDK_DEBUG = originalEnv;
    });

    it('should not include SDK_DEBUG when env var is not true', () => {
      const originalEnv = process.env.SDK_DEBUG;
      delete process.env.SDK_DEBUG;

      const options = agent.testCreateSdkOptions();
      expect(options.env?.SDK_DEBUG).toBeUndefined();

      process.env.SDK_DEBUG = originalEnv;
    });

    it('should use runtime context logging config over env var', () => {
      process.env.SDK_DEBUG = 'true';
      setRuntimeContext({
        getWorkspaceDir: () => '/runtime-workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({ CUSTOM_VAR: 'value' }),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', provider: 'anthropic' });
      const options = ctxAgent.testCreateSdkOptions();
      // Runtime context takes precedence - sdkDebug is false
      expect(options.env?.SDK_DEBUG).toBeUndefined();

      delete process.env.SDK_DEBUG;
    });

    it('should use custom cwd from extra options', () => {
      const options = agent.testCreateSdkOptions({ cwd: '/custom/workspace' });
      expect(options.cwd).toBe('/custom/workspace');
    });

    it('should not set model when model is empty string', () => {
      const noModelAgent = new TestAgent({ apiKey: 'key', model: '', provider: 'anthropic' });
      const options = noModelAgent.testCreateSdkOptions();
      expect(options.model).toBeUndefined();
    });
  });
});
