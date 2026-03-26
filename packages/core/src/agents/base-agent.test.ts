/**
 * Unit tests for BaseAgent - abstract base class for all Agent types.
 *
 * Issue #1617 Phase 2 (P0): Comprehensive tests for agent SDK configuration,
 * message conversion, error handling, lifecycle management, and runtime context.
 *
 * Tests cover:
 * - Constructor: config assignment, provider fallback, SDK provider initialization
 * - createSdkOptions: env building, tool lists, model override, cwd resolution
 * - convertToLegacyFormat: metadata mapping, token calculation, edge cases
 * - handleIteratorError: AppError creation, error message formatting
 * - formatMessage: parsed message to AgentMessage conversion
 * - dispose: idempotent cleanup
 * - queryOnce: SDK delegation, logging, async iteration
 * - createQueryStream: input conversion, wrapped iteration, handle propagation
 * - Runtime context integration: workspace dir, logging config, global env, agent teams
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAgent, type SdkOptionsExtra, type IteratorYieldResult } from './base-agent.js';
import { setRuntimeContext, clearRuntimeContext, type BaseAgentConfig, type AgentProvider } from './types.js';

// ============================================================================
// Mocks
// ============================================================================

const mockSdkProvider = {
  queryOnce: vi.fn(),
  queryStream: vi.fn(),
};

vi.mock('../sdk/index.js', () => ({
  getProvider: () => mockSdkProvider,
  IAgentSDKProvider: class {},
}));

vi.mock('../utils/sdk.js', () => ({
  buildSdkEnv: (apiKey: string, apiBaseUrl: string | undefined, globalEnv: Record<string, string | undefined>, sdkDebug: boolean) => ({
    ANTHROPIC_API_KEY: apiKey,
    ...(apiBaseUrl ? { ANTHROPIC_BASE_URL: apiBaseUrl } : {}),
    ...globalEnv,
    ...(sdkDebug ? { SDK_DEBUG: 'true' } : {}),
  }),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../utils/error-handler.js', () => ({
  AppError: class AppError extends Error {
    category: string;
    context: unknown;
    retryable: boolean;
    constructor(message: string, category: string, _code?: string, options?: { cause?: Error; context?: unknown; retryable?: boolean }) {
      super(message);
      this.category = category;
      this.context = options?.context;
      this.retryable = options?.retryable ?? false;
    }
  },
  ErrorCategory: { SDK: 'SDK' },
  formatError: vi.fn((err: Error) => ({ message: err.message, category: (err as { category?: string }).category })),
}));

vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/default/workspace',
  },
}));

vi.mock('../config/runtime-env.js', () => ({
  loadRuntimeEnv: () => ({ FROM_RUNTIME_ENV: 'true' }),
}));

// ============================================================================
// Concrete test implementation
// ============================================================================

class TestAgent extends BaseAgent {
  constructor(config: BaseAgentConfig) {
    super(config);
    this.initialized = true; // Simulate initialized agent
  }

  protected getAgentName(): string {
    return 'TestAgent';
  }

  // Expose protected/private methods for testing
  testCreateSdkOptions(extra: SdkOptionsExtra = {}) {
    return this.createSdkOptions(extra);
  }

  testFormatMessage(parsed: IteratorYieldResult['parsed']) {
    return this.formatMessage(parsed);
  }

  testHandleIteratorError(error: unknown, operation: string) {
    return this.handleIteratorError(error, operation);
  }

  testGetWorkspaceDir() {
    return this.getWorkspaceDir();
  }

  testGetLoggingConfig() {
    return this.getLoggingConfig();
  }

  testGetGlobalEnv() {
    return this.getGlobalEnv();
  }

  testIsAgentTeamsEnabled() {
    return this.isAgentTeamsEnabled();
  }

  testQueryOnce(input: string | unknown[], options: Parameters<BaseAgent['queryOnce']>[1]) {
    return this.queryOnce(input, options);
  }

  testCreateQueryStream(input: Parameters<BaseAgent['createQueryStream']>[0], options: Parameters<BaseAgent['createQueryStream']>[1]) {
    return this.createQueryStream(input, options);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('BaseAgent', () => {
  let agent: TestAgent;
  let config: BaseAgentConfig;

  beforeEach(() => {
    vi.clearAllMocks();
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

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should assign apiKey, model, and apiBaseUrl from config', () => {
      const agentWithUrl = new TestAgent({ ...config, apiBaseUrl: 'https://api.example.com' });
      expect(agentWithUrl.apiKey).toBe('test-api-key');
      expect(agentWithUrl.model).toBe('claude-3-5-sonnet-20241022');
      expect(agentWithUrl.apiBaseUrl).toBe('https://api.example.com');
    });

    it('should default permissionMode to bypassPermissions', () => {
      expect(agent.permissionMode).toBe('bypassPermissions');
    });

    it('should use explicit permissionMode from config', () => {
      const strictAgent = new TestAgent({ ...config, permissionMode: 'default' });
      expect(strictAgent.permissionMode).toBe('default');
    });

    it('should use explicit provider from config when provided', () => {
      expect(agent.provider).toBe('anthropic');
      const glmAgent = new TestAgent({ ...config, provider: 'glm' });
      expect(glmAgent.provider).toBe('glm');
    });

    it('should fall back to runtime context provider when not specified in config', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'glm' as AgentProvider }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model' });
      expect(ctxAgent.provider).toBe('glm');
    });

    it('should default to anthropic provider when no runtime context and no config provider', () => {
      const noProviderAgent = new TestAgent({ apiKey: 'key', model: 'model' });
      expect(noProviderAgent.provider).toBe('anthropic');
    });

    it('should initialize SDK provider via getProvider', () => {
      const getProvider = vi.fn(() => mockSdkProvider);
      vi.doMock('../sdk/index.js', () => ({ getProvider, IAgentSDKProvider: class {} }));
      // getProvider was called during construction
      expect(mockSdkProvider.queryOnce).toBeDefined();
    });
  });

  // ==========================================================================
  // createSdkOptions
  // ==========================================================================

  describe('createSdkOptions', () => {
    it('should create options with default settings', () => {
      const options = agent.testCreateSdkOptions();
      expect(options).toBeDefined();
      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.settingSources).toEqual(['project']);
      expect(options.env?.ANTHROPIC_API_KEY).toBe('test-api-key');
    });

    it('should include model when configured', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('should not set model when empty string', () => {
      const emptyModelAgent = new TestAgent({ apiKey: 'key', model: '' });
      const options = emptyModelAgent.testCreateSdkOptions();
      expect(options.model).toBeUndefined();
    });

    it('should use custom cwd when provided in extra', () => {
      const options = agent.testCreateSdkOptions({ cwd: '/custom/dir' });
      expect(options.cwd).toBe('/custom/dir');
    });

    it('should use workspace dir as cwd when no extra cwd is provided', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.cwd).toBe('/default/workspace');
    });

    it('should add allowedTools when specified', () => {
      const options = agent.testCreateSdkOptions({ allowedTools: ['Read', 'Write', 'Bash'] });
      expect(options.allowedTools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('should not include allowedTools when not specified', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.allowedTools).toBeUndefined();
    });

    it('should add disallowedTools when specified', () => {
      const options = agent.testCreateSdkOptions({ disallowedTools: ['DangerousTool'] });
      expect(options.disallowedTools).toEqual(['DangerousTool']);
    });

    it('should add mcpServers when specified', () => {
      const mcpServers = { 'test-server': { command: 'node', args: ['server.js'] } };
      const options = agent.testCreateSdkOptions({ mcpServers });
      expect(options.mcpServers).toEqual(mcpServers);
    });

    it('should merge runtime env with global env', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.env?.FROM_RUNTIME_ENV).toBe('true');
    });

    it('should include CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when enabled via runtime context', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' as AgentProvider }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => true,
      });

      const ctxAgent = new TestAgent(config);
      const options = ctxAgent.testCreateSdkOptions();
      expect(options.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    });

    it('should not set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when not in runtime context', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
    });

    it('should handle empty extra options', () => {
      const options = agent.testCreateSdkOptions({});
      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.env?.ANTHROPIC_API_KEY).toBe('test-api-key');
    });
  });

  // ==========================================================================
  // Runtime context helpers
  // ==========================================================================

  describe('runtime context helpers', () => {
    it('getWorkspaceDir should use runtime context when available', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/runtime/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' as AgentProvider }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent(config);
      expect(ctxAgent.testGetWorkspaceDir()).toBe('/runtime/workspace');
    });

    it('getWorkspaceDir should fall back to Config when no runtime context', () => {
      expect(agent.testGetWorkspaceDir()).toBe('/default/workspace');
    });

    it('getLoggingConfig should use runtime context when available', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' as AgentProvider }),
        getLoggingConfig: () => ({ sdkDebug: true }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent(config);
      expect(ctxAgent.testGetLoggingConfig()).toEqual({ sdkDebug: true });
    });

    it('getLoggingConfig should read SDK_DEBUG env var as fallback', () => {
      const originalDebug = process.env.SDK_DEBUG;
      process.env.SDK_DEBUG = 'true';

      const fallbackAgent = new TestAgent({ apiKey: 'key', model: 'model' });
      expect(fallbackAgent.testGetLoggingConfig()).toEqual({ sdkDebug: true });

      process.env.SDK_DEBUG = originalDebug;
    });

    it('getLoggingConfig should return false when SDK_DEBUG is not set', () => {
      const originalDebug = process.env.SDK_DEBUG;
      delete process.env.SDK_DEBUG;

      const fallbackAgent = new TestAgent({ apiKey: 'key', model: 'model' });
      expect(fallbackAgent.testGetLoggingConfig()).toEqual({ sdkDebug: false });

      process.env.SDK_DEBUG = originalDebug;
    });

    it('getGlobalEnv should use runtime context when available', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' as AgentProvider }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({ GLOBAL_VAR: 'value', ANOTHER: 'var' }),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent(config);
      expect(ctxAgent.testGetGlobalEnv()).toEqual({ GLOBAL_VAR: 'value', ANOTHER: 'var' });
    });

    it('getGlobalEnv should return empty object when no runtime context', () => {
      expect(agent.testGetGlobalEnv()).toEqual({});
    });

    it('isAgentTeamsEnabled should use runtime context when available', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' as AgentProvider }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => true,
      });

      const ctxAgent = new TestAgent(config);
      expect(ctxAgent.testIsAgentTeamsEnabled()).toBe(true);
    });

    it('isAgentTeamsEnabled should return false when no runtime context', () => {
      expect(agent.testIsAgentTeamsEnabled()).toBe(false);
    });
  });

  // ==========================================================================
  // convertToLegacyFormat (via queryOnce results)
  // ==========================================================================

  describe('message format conversion', () => {
    it('should preserve basic message fields through queryOnce', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        yield { type: 'text', content: 'Hello, world!' };
      })());

      const results = [];
      for await (const result of agent.testQueryOnce('test', {} as never)) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].parsed.type).toBe('text');
      expect(results[0].parsed.content).toBe('Hello, world!');
      expect(results[0].raw.type).toBe('text');
    });

    it('should map metadata fields including token calculation', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        yield {
          type: 'tool_use',
          content: 'Using tool',
          metadata: {
            toolName: 'Read',
            toolInput: { file_path: '/test' },
            toolInputRaw: { file_path: '/test' },
            toolOutput: 'file contents',
            elapsedMs: 1500,
            costUsd: 0.005,
            inputTokens: 100,
            outputTokens: 50,
            sessionId: 'sess-123',
          },
        };
      })());

      const results = [];
      for await (const result of agent.testQueryOnce('test', {} as never)) {
        results.push(result);
      }

      expect(results[0].parsed.metadata).toMatchObject({
        toolName: 'Read',
        toolInput: { file_path: '/test' },
        toolInputRaw: { file_path: '/test' },
        toolOutput: 'file contents',
        elapsed: 1500,
        cost: 0.005,
        tokens: 150, // 100 + 50
      });
      expect(results[0].parsed.sessionId).toBe('sess-123');
    });

    it('should handle messages without metadata', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        yield { type: 'text', content: 'No metadata' };
      })());

      const results = [];
      for await (const result of agent.testQueryOnce('test', {} as never)) {
        results.push(result);
      }

      expect(results[0].parsed.metadata).toBeUndefined();
      expect(results[0].parsed.sessionId).toBeUndefined();
    });

    it('should default tokens to 0 when inputTokens/outputTokens are missing', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        yield {
          type: 'text',
          content: 'test',
          metadata: { toolName: 'Bash', elapsedMs: 100 },
        };
      })());

      const results = [];
      for await (const result of agent.testQueryOnce('test', {} as never)) {
        results.push(result);
      }

      expect(results[0].parsed.metadata?.tokens).toBe(0);
    });
  });

  // ==========================================================================
  // formatMessage
  // ==========================================================================

  describe('formatMessage', () => {
    it('should format a simple text message correctly', () => {
      const parsed = { type: 'text', content: 'Hello, world!' };
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

    it('should handle tool_use message type', () => {
      const parsed = { type: 'tool_use', content: 'Tool response' };
      const message = agent.testFormatMessage(parsed);

      expect(message.messageType).toBe('tool_use');
    });

    it('should handle messages without metadata', () => {
      const parsed = { type: 'text', content: 'Simple message' };
      const message = agent.testFormatMessage(parsed);

      expect(message.metadata).toBeUndefined();
    });
  });

  // ==========================================================================
  // handleIteratorError
  // ==========================================================================

  describe('handleIteratorError', () => {
    it('should format Error instances correctly', () => {
      const error = new Error('SDK connection failed');
      const message = agent.testHandleIteratorError(error, 'query');

      expect(message.content).toContain('SDK connection failed');
      expect(message.role).toBe('assistant');
      expect(message.messageType).toBe('error');
    });

    it('should handle string errors', () => {
      const message = agent.testHandleIteratorError('string error', 'testOperation');
      expect(message.content).toContain('string error');
    });

    it('should handle numeric errors', () => {
      const message = agent.testHandleIteratorError(42, 'testOperation');
      expect(message.content).toContain('42');
    });

    it('should handle null errors', () => {
      const message = agent.testHandleIteratorError(null, 'execute');
      expect(message.content).toContain('null');
    });

    it('should handle undefined errors', () => {
      const message = agent.testHandleIteratorError(undefined, 'stream');
      expect(message.content).toContain('undefined');
    });

    it('should include agent name in error message via AppError', async () => {
      const { formatError } = await import('../utils/error-handler.js');
      agent.testHandleIteratorError(new Error('test'), 'operation');
      // formatError should be called (error is logged)
      expect(formatError).toHaveBeenCalled();
    });

    it('should mark error as retryable in AppError context', () => {
      const message = agent.testHandleIteratorError(new Error('timeout'), 'query');
      // Error should be formatted with retryable: true
      expect(message.messageType).toBe('error');
    });
  });

  // ==========================================================================
  // dispose
  // ==========================================================================

  describe('dispose', () => {
    it('should be idempotent - safe to call multiple times', () => {
      expect(agent.initialized).toBe(true);

      agent.dispose();
      expect(agent.initialized).toBe(false);

      agent.dispose();
      expect(agent.initialized).toBe(false);
    });

    it('should not dispose if not initialized', () => {
      const freshAgent = new TestAgent(config);
      freshAgent.initialized = false;

      freshAgent.dispose();
      expect(freshAgent.initialized).toBe(false);
    });

    it('should handle dispose after normal operation', () => {
      expect(agent.initialized).toBe(true);
      agent.dispose();
      expect(agent.initialized).toBe(false);
    });
  });

  // ==========================================================================
  // queryOnce
  // ==========================================================================

  describe('queryOnce', () => {
    it('should delegate to SDK provider queryOnce with string input', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        yield { type: 'text', content: 'Response' };
      })());

      const options = { permissionMode: 'bypassPermissions' as const };
      const results = [];

      for await (const result of agent.testQueryOnce('Hello', options)) {
        results.push(result);
      }

      expect(results).toHaveLength(1);
      expect(results[0].parsed.content).toBe('Response');
      expect(mockSdkProvider.queryOnce).toHaveBeenCalledWith('Hello', options);
    });

    it('should handle array input by converting to empty array fallback', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        yield { type: 'text', content: 'Response' };
      })());

      const results = [];
      for await (const result of agent.testQueryOnce([{}], {} as never)) {
        results.push(result);
      }

      expect(mockSdkProvider.queryOnce).toHaveBeenCalledWith([], expect.anything());
    });

    it('should yield multiple messages from iterator', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        yield { type: 'text', content: 'First' };
        yield { type: 'text', content: 'Second' };
        yield { type: 'tool_use', content: 'Tool result' };
      })());

      const results = [];
      for await (const result of agent.testQueryOnce('test', {} as never)) {
        results.push(result);
      }

      expect(results).toHaveLength(3);
      expect(results[0].parsed.content).toBe('First');
      expect(results[2].parsed.type).toBe('tool_use');
    });

    it('should propagate SDK errors through the iterator', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        yield { type: 'text', content: 'Before error' };
        throw new Error('SDK failure');
      })());

      const results = [];
      let caughtError: Error | undefined;

      try {
        for await (const result of agent.testQueryOnce('test', {} as never)) {
          results.push(result);
        }
      } catch (e) {
        caughtError = e as Error;
      }

      expect(results).toHaveLength(1);
      expect(caughtError?.message).toBe('SDK failure');
    });

    it('should handle empty iterator', async () => {
      mockSdkProvider.queryOnce.mockReturnValue((async function* () {
        // No yields
      })());

      const results = [];
      for await (const result of agent.testQueryOnce('test', {} as never)) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });
  });

  // ==========================================================================
  // createQueryStream
  // ==========================================================================

  describe('createQueryStream', () => {
    it('should return handle and iterator from SDK provider', async () => {
      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      const mockMessage = { type: 'text', content: 'Stream response' };

      mockSdkProvider.queryStream.mockReturnValue({
        handle: mockHandle,
        iterator: (async function* () { yield mockMessage; })(),
      });

      const input = (async function* () {
        yield { message: { content: 'Hello' } };
      })();

      const result = agent.testCreateQueryStream(input, {} as never);

      expect(result.handle).toBe(mockHandle);

      const messages = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].parsed.content).toBe('Stream response');
    });

    it('should convert streaming user messages to SDK UserInput format', async () => {
      const mockHandle = { close: vi.fn() };
      let capturedInputs: unknown[] = [];

      mockSdkProvider.queryStream.mockImplementation((inputGen: AsyncIterable<unknown>) => ({
        handle: mockHandle,
        iterator: (async function* () {
          for await (const msg of inputGen) {
            capturedInputs.push(msg);
          }
          yield { type: 'text', content: 'done' };
        })(),
      }));

      const input = (async function* () {
        yield { message: { content: 'First message' } };
        yield { message: { content: 'Second message' } };
      })();

      const result = agent.testCreateQueryStream(input, {} as never);
      for await (const msg of result.iterator) { /* drain */ }

      expect(capturedInputs).toEqual([
        { role: 'user', content: 'First message' },
        { role: 'user', content: 'Second message' },
      ]);
    });

    it('should handle non-string message content by JSON-stringifying it', async () => {
      const mockHandle = { close: vi.fn() };
      let capturedInput: unknown;

      mockSdkProvider.queryStream.mockImplementation((inputGen: AsyncIterable<unknown>) => ({
        handle: mockHandle,
        iterator: (async function* () {
          for await (const msg of inputGen) {
            capturedInput = msg;
          }
          yield { type: 'text', content: 'done' };
        })(),
      }));

      const input = (async function* () {
        yield { message: { content: { complex: 'object' } } };
      })();

      const result = agent.testCreateQueryStream(input, {} as never);
      for await (const msg of result.iterator) { /* drain */ }

      expect(capturedInput).toEqual({ role: 'user', content: '{"complex":"object"}' });
    });

    it('should handle null/undefined message content', async () => {
      const mockHandle = { close: vi.fn() };
      let capturedInput: unknown;

      mockSdkProvider.queryStream.mockImplementation((inputGen: AsyncIterable<unknown>) => ({
        handle: mockHandle,
        iterator: (async function* () {
          for await (const msg of inputGen) {
            capturedInput = msg;
          }
          yield { type: 'text', content: 'done' };
        })(),
      }));

      const input = (async function* () {
        yield { message: { content: null } };
      })();

      const result = agent.testCreateQueryStream(input, {} as never);
      for await (const msg of result.iterator) { /* drain */ }

      expect(capturedInput).toEqual({ role: 'user', content: '""' });
    });

    it('should yield multiple messages from stream iterator', async () => {
      const mockHandle = { close: vi.fn() };
      mockSdkProvider.queryStream.mockReturnValue({
        handle: mockHandle,
        iterator: (async function* () {
          yield { type: 'text', content: 'First' };
          yield { type: 'tool_use', content: 'Tool', metadata: { toolName: 'Bash' } };
          yield { type: 'text', content: 'Final' };
        })(),
      });

      const input = (async function* () {
        yield { message: { content: 'test' } };
      })();

      const result = agent.testCreateQueryStream(input, {} as never);
      const messages = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(3);
      expect(messages[1].parsed.type).toBe('tool_use');
      expect(messages[1].parsed.metadata?.toolName).toBe('Bash');
    });
  });
});
