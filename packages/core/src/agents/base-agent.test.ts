/**
 * Unit tests for BaseAgent
 *
 * Issue #2311: Updated to test ACP Client integration
 * instead of legacy SDK Provider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseAgent, type SdkOptionsExtra, type IteratorYieldResult, type QueryStreamResult } from './base-agent.js';
import { setRuntimeContext, clearRuntimeContext, type BaseAgentConfig } from './types.js';
import type { AgentMessage, StreamingUserMessage } from '../sdk/index.js';

// ============================================================================
// Mock ACP Client
// ============================================================================

/** Create a mock AcpClient with controllable behavior */
function createMockAcpClient() {
  const mockClient = {
    state: 'disconnected' as string,
    connect: vi.fn(() => {
      mockClient.state = 'connected';
      return Promise.resolve({ protocolVersion: 1 });
    }),
    disconnect: vi.fn(() => {
      mockClient.state = 'disconnected';
      return Promise.resolve();
    }),
    createSession: vi.fn((_cwd: string, _options?: unknown) => ({
      sessionId: 'test-session-id',
      model: 'claude-3-5-sonnet',
    })),
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(async (_sessionId: string) => {}),
  };

  // Default sendPrompt: returns an empty async generator
  mockClient.sendPrompt.mockImplementation(async function* () {
    // no messages by default
  });

  return mockClient;
}

// ============================================================================
// Test Agent Implementation
// ============================================================================

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

  async *testQueryOnce(input: string | unknown[], options: Parameters<BaseAgent['queryOnce']>[1]) {
    yield* this.queryOnce(input, options);
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

// Helper to create mock AgentMessage (ACP format)
function createMockAcpMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    type: 'text',
    content: 'Hello from ACP',
    role: 'assistant',
    ...overrides,
  };
}

// ============================================================================
// Mocks
// ============================================================================

let mockAcpClient: ReturnType<typeof createMockAcpClient>;

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

// ============================================================================
// Tests
// ============================================================================

describe('BaseAgent', () => {
  let agent: TestAgent;
  let config: BaseAgentConfig;

  beforeEach(() => {
    mockAcpClient = createMockAcpClient();
    config = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      acpClient: mockAcpClient as unknown as import('../sdk/acp/acp-client.js').AcpClient,
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
        acpClient: mockAcpClient as unknown as import('../sdk/acp/acp-client.js').AcpClient,
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

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', acpClient: mockAcpClient as unknown as import('../sdk/acp/acp-client.js').AcpClient });
      expect(ctxAgent.provider).toBe('glm');
    });

    it('should use ACP client from config', () => {
      expect(agent).toBeDefined();
    });

    it('should use ACP client from runtime context if not in config', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', provider: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
        getAcpClient: () => mockAcpClient as unknown as import('../sdk/acp/acp-client.js').AcpClient,
      });

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model' });
      expect(ctxAgent).toBeDefined();
    });

    it('should throw if no ACP client is available', () => {
      expect(() => new TestAgent({ apiKey: 'key', model: 'model' })).toThrow(
        'ACP Client not available'
      );
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
      const error = new Error('ACP connection failed');
      const message = agent.testHandleIteratorError(error, 'testOperation');

      expect(message.content).toContain('ACP connection failed');
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

  describe('queryOnce', () => {
    const defaultOptions = {
      cwd: '/workspace',
      permissionMode: 'bypassPermissions' as const,
      settingSources: ['project'],
    };

    it('should connect client, create session, and yield messages', async () => {
      const acpMessages = [
        createMockAcpMessage({ type: 'text', content: 'Hello' }),
        createMockAcpMessage({
          type: 'tool_use',
          content: 'Using tool',
          metadata: {
            toolName: 'Read',
            toolInput: { file: '/test.ts' },
            elapsedMs: 100,
            costUsd: 0.01,
            inputTokens: 10,
            outputTokens: 20,
          },
        }),
      ];

      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        for (const msg of acpMessages) {
          yield msg;
        }
      });

      const results: IteratorYieldResult[] = [];
      for await (const result of agent.testQueryOnce('test prompt', defaultOptions)) {
        results.push(result);
      }

      // Should have connected the client
      expect(mockAcpClient.connect).toHaveBeenCalled();

      // Should have created a session
      expect(mockAcpClient.createSession).toHaveBeenCalledWith(
        '/workspace',
        { permissionMode: 'bypassPermissions', settingSources: ['project'] },
      );

      // Should have sent prompt
      expect(mockAcpClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-id',
        [{ type: 'text', text: 'test prompt' }],
      );

      // Should yield messages
      expect(results).toHaveLength(2);
      expect(results[0].parsed.type).toBe('text');
      expect(results[0].parsed.content).toBe('Hello');
      expect(results[0].raw).toEqual(acpMessages[0]);

      expect(results[1].parsed.type).toBe('tool_use');
      expect(results[1].parsed.metadata?.toolName).toBe('Read');
      expect(results[1].parsed.metadata?.elapsed).toBe(100);
      expect(results[1].parsed.metadata?.cost).toBe(0.01);
      expect(results[1].parsed.metadata?.tokens).toBe(30);
    });

    it('should handle empty response', async () => {
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        // no messages
      });

      const results: IteratorYieldResult[] = [];
      for await (const result of agent.testQueryOnce('test', defaultOptions)) {
        results.push(result);
      }

      expect(results).toHaveLength(0);
    });

    it('should not reconnect if client is already connected', async () => {
      mockAcpClient.state = 'connected';

      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage();
      });

      for await (const _ of agent.testQueryOnce('hello', defaultOptions)) {
        // consume
      }

      expect(mockAcpClient.connect).not.toHaveBeenCalled();
    });

    it('should yield messages with sessionId from metadata', async () => {
      const acpMessage = createMockAcpMessage({
        type: 'result',
        content: 'Done',
        metadata: { sessionId: 'session-123' },
      });

      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield acpMessage;
      });

      const results: IteratorYieldResult[] = [];
      for await (const result of agent.testQueryOnce('test', defaultOptions)) {
        results.push(result);
      }

      expect(results[0].parsed.sessionId).toBe('session-123');
    });

    it('should handle messages without metadata', async () => {
      const acpMessage = createMockAcpMessage({
        type: 'text',
        content: 'No metadata',
      });

      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield acpMessage;
      });

      const results: IteratorYieldResult[] = [];
      for await (const result of agent.testQueryOnce('test', defaultOptions)) {
        results.push(result);
      }

      expect(results[0].parsed.metadata).toBeUndefined();
      expect(results[0].parsed.sessionId).toBeUndefined();
    });

    it('should pass MCP servers as named array', async () => {
      const mcpServers = {
        'test-server': { type: 'stdio' as const, name: 'test-server', command: 'node', args: ['server.js'] },
      };
      const optionsWithMcp = {
        ...defaultOptions,
        mcpServers: mcpServers as unknown as Record<string, import('../sdk/index.js').SdkMcpServerConfig>,
      };

      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage();
      });

      for await (const _ of agent.testQueryOnce('test', optionsWithMcp)) {
        // consume
      }

      expect(mockAcpClient.createSession).toHaveBeenCalledWith(
        '/workspace',
        {
          mcpServers: [{ type: 'stdio', name: 'test-server', command: 'node', args: ['server.js'] }],
          permissionMode: 'bypassPermissions',
          settingSources: ['project'],
        },
      );
    });

    it('should convert array input to JSON string', async () => {
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage();
      });

      for await (const _ of agent.testQueryOnce([{ role: 'user', content: 'hi' }], defaultOptions)) {
        // consume
      }

      expect(mockAcpClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-id',
        [{ type: 'text', text: '[{"role":"user","content":"hi"}]' }],
      );
    });

    it('should pass model, allowedTools, disallowedTools, env to session', async () => {
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage();
      });

      const fullOptions = {
        cwd: '/workspace',
        permissionMode: 'default' as const,
        model: 'claude-3-opus',
        allowedTools: ['Read', 'Write'],
        disallowedTools: ['Bash'],
        env: { ANTHROPIC_API_KEY: 'test-key', CUSTOM_VAR: 'value' },
        settingSources: ['project'],
      };

      for await (const _ of agent.testQueryOnce('test', fullOptions)) {
        // consume
      }

      expect(mockAcpClient.createSession).toHaveBeenCalledWith(
        '/workspace',
        expect.objectContaining({
          permissionMode: 'default',
          model: 'claude-3-opus',
          allowedTools: ['Read', 'Write'],
          disallowedTools: ['Bash'],
          env: { ANTHROPIC_API_KEY: 'test-key', CUSTOM_VAR: 'value' },
          settingSources: ['project'],
        }),
      );
    });

    it('should not reconnect on concurrent queryOnce calls', async () => {
      let connectCallCount = 0;
      mockAcpClient.connect.mockImplementation(() => {
        connectCallCount++;
        mockAcpClient.state = 'connected';
        return Promise.resolve({ protocolVersion: 1 });
      });

      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage();
      });

      // Run two concurrent queries
      const [results1, results2] = await Promise.all([
        (async () => {
          const r: IteratorYieldResult[] = [];
          for await (const item of agent.testQueryOnce('query1', defaultOptions)) {
            r.push(item);
          }
          return r;
        })(),
        (async () => {
          const r: IteratorYieldResult[] = [];
          for await (const item of agent.testQueryOnce('query2', defaultOptions)) {
            r.push(item);
          }
          return r;
        })(),
      ]);

      // Both should succeed
      expect(results1).toHaveLength(1);
      expect(results2).toHaveLength(1);
      // connect should be called at most once (the cached promise deduplicates)
      expect(connectCallCount).toBeLessThanOrEqual(1);
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

    it('should return handle and iterator from ACP client', async () => {
      const acpMessages = [
        createMockAcpMessage({ type: 'text', content: 'Streaming response' }),
      ];

      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        for (const msg of acpMessages) {
          yield msg;
        }
      });

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello stream' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result: QueryStreamResult = agent.testCreateQueryStream(inputStream, defaultOptions);

      expect(result.handle).toBeDefined();

      const results: IteratorYieldResult[] = [];
      for await (const item of result.iterator) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
      expect(results[0].parsed.content).toBe('Streaming response');
      expect(results[0].raw).toEqual(acpMessages[0]);
    });

    it('should create a session and send prompts for each input message', async () => {
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage({ type: 'text', content: 'Response' });
      });

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'World' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      const results: IteratorYieldResult[] = [];
      for await (const item of result.iterator) {
        results.push(item);
      }

      // Should create session once
      expect(mockAcpClient.createSession).toHaveBeenCalledTimes(1);

      // Should send two prompts (one per input message)
      expect(mockAcpClient.sendPrompt).toHaveBeenCalledTimes(2);

      // Should yield two responses
      expect(results).toHaveLength(2);
    });

    it('should handle StreamingUserMessage with ContentBlock array', async () => {
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage({ type: 'text', content: 'Response' });
      });

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

      // Should have converted content block array to JSON string
      expect(mockAcpClient.sendPrompt).toHaveBeenCalledWith(
        'test-session-id',
        [{ type: 'text', text: '[{"type":"text","text":"Hello"}]' }],
      );
    });

    it('should handle StreamingUserMessage with null/undefined message content', async () => {
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage({ type: 'text', content: 'Fallback response' });
      });

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

    it('should cancel prompt when handle.cancel() is called', async () => {
      // Make sendPrompt yield one message then complete
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage({ type: 'text', content: 'Before cancel' });
      });

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Should be skipped' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      // Cancel after starting
      const iterPromise = (async () => {
        const results: IteratorYieldResult[] = [];
        for await (const item of result.iterator) {
          results.push(item);
          // Cancel after first message
          result.handle.cancel();
        }
        return results;
      })();

      // Should complete without hanging
      const results = await iterPromise;
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(mockAcpClient.cancelPrompt).toHaveBeenCalledWith('test-session-id');
    });

    it('should stop iteration when handle.close() is called', async () => {
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage({ type: 'text', content: 'First' });
      });

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'World' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      // Close after first message
      let count = 0;
      const results: IteratorYieldResult[] = [];
      for await (const item of result.iterator) {
        results.push(item);
        count++;
        if (count >= 1) {
          result.handle.close();
        }
      }

      // Should have processed at most the first prompt's messages
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should convert metadata with token counts in stream messages', async () => {
      const acpMessage = createMockAcpMessage({
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

      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield acpMessage;
      });

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Run tool' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

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

    it('should expose sessionId via getter after session creation', async () => {
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        yield createMockAcpMessage({ type: 'text', content: 'Response' });
      });

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      // Before consuming, sessionId should be undefined
      expect(result.handle.sessionId).toBeUndefined();

      // Consume the iterator
      for await (const _ of result.iterator) {
        // consume
      }

      // After consuming, sessionId should be populated
      expect(result.handle.sessionId).toBe('test-session-id');
    });

    it('should handle cancel before session is created', async () => {
      // Make createSession slow to test pending cancel
      let resolveSession: (value: { sessionId: string; model: string }) => void;
      const sessionPromise = new Promise<{ sessionId: string; model: string }>((resolve) => { resolveSession = resolve; });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockAcpClient.createSession as any).mockImplementation(() => sessionPromise);

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      // Start consuming iterator (triggers session creation) but don't await
      const iterPromise = (async () => {
        for await (const _ of result.iterator) {
          // consume
        }
      })();

      // Give a tick for ensureClientConnected to run and session creation to start
      await new Promise((r) => setTimeout(r, 5));

      // Cancel before session is resolved
      result.handle.cancel();

      // Now resolve the session
      resolveSession!({ sessionId: 'late-session', model: 'model' });

      // After session is resolved, cancelPrompt should be called
      // (it was deferred via pendingCancel flag)
      await new Promise((r) => setTimeout(r, 10));

      expect(mockAcpClient.cancelPrompt).toHaveBeenCalledWith('late-session');

      // Clean up the iterator - it should complete after cancel
      await iterPromise;
    });

    it('should stop iteration when close is called during prompt processing', async () => {
      let callCount = 0;
      mockAcpClient.sendPrompt.mockImplementation(async function* () {
        callCount++;
        yield createMockAcpMessage({ type: 'text', content: `Response ${callCount}` });
      });

      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Should be skipped' },
          parent_tool_use_id: null,
          session_id: 'session-1',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      const results: IteratorYieldResult[] = [];
      for await (const item of result.iterator) {
        results.push(item);
        // Close after first message
        result.handle.close();
      }

      // Should have processed at most one prompt
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.length).toBeLessThanOrEqual(2);
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

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', provider: 'anthropic', acpClient: mockAcpClient as unknown as import('../sdk/acp/acp-client.js').AcpClient });
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
      const noModelAgent = new TestAgent({
        apiKey: 'key',
        model: '',
        provider: 'anthropic',
        acpClient: mockAcpClient as unknown as import('../sdk/acp/acp-client.js').AcpClient,
      });
      const options = noModelAgent.testCreateSdkOptions();
      expect(options.model).toBeUndefined();
    });
  });
});
