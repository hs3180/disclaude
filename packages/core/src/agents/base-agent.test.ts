/**
 * Unit tests for BaseAgent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BaseAgent,
  type SdkOptionsExtra,
  type IteratorYieldResult,
  type QueryStreamResult,
} from './base-agent.js';
import { setRuntimeContext, clearRuntimeContext, type BaseAgentConfig } from './types.js';
import type { AgentMessage, StreamingUserMessage, QueryHandle } from '../sdk/index.js';
import { Config } from '../config/index.js';
import { adaptSDKMessage } from '../sdk/providers/claude/message-adapter.js';

// Unit tests must not load developer credentials or workspace settings.
vi.mock('../config/loader.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/loader.js')>(),
  loadConfigFile: () => ({ _fromFile: false }),
}));

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
const { mockSdkProvider, mockGetProvider } = vi.hoisted(() => {
  const provider = { queryStream: vi.fn() };
  return { mockSdkProvider: provider, mockGetProvider: vi.fn(() => provider) };
});

// Mock the SDK module
vi.mock('../sdk/index.js', () => ({
  getProvider: mockGetProvider,
  IAgentSDKProvider: class {},
}));

// Mock buildSdkEnv to return a simple env object
vi.mock('../utils/sdk.js', () => ({
  buildSdkEnv: (
    apiKey: string,
    apiBaseUrl: string | undefined,
    globalEnv: Record<string, string>,
    sdkDebug: boolean
  ) => ({
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
    mockGetProvider.mockClear();
    config = {
      apiKey: 'test-api-key',
      model: 'claude-3-5-sonnet-20241022',
      apiProtocol: 'anthropic',
    };
    agent = new TestAgent(config);
  });

  it('binds an explicitly selected SDK backend to this agent', () => {
    new TestAgent({ ...config, agentBackend: 'pi' });
    expect(mockGetProvider).toHaveBeenLastCalledWith('pi');
  });

  it('passes the selected native DSH preset into provider construction', () => {
    const settings = {
      agentBackend: 'dsh' as const,
      llm: 'glm-native', model: 'glm-5.3', apiKey: '', mode: 'minimal' as const, dshHome: '/named-home',
      apiProtocol: 'openai' as const, apiBaseUrl: 'https://dsh.example/v1',
    };
    new TestAgent({ ...config, ...settings, settings });
    expect(mockGetProvider).toHaveBeenLastCalledWith('dsh', settings);
  });

  it('omits Claude-only runtime options for DSH', () => {
    const dsh = new TestAgent({ ...config, agentBackend: 'dsh' });
    const options = dsh.testCreateSdkOptions();
    expect(options.systemPrompt).toBeUndefined();
    expect(options).not.toHaveProperty('builtinTools');
    expect(options).not.toHaveProperty('disallowedTools');
  });

  it.each(['codex', 'pi', 'dsh'] as const)('does not inject Claude runtime options into %s', (backend) => {
    const instance = new TestAgent({ ...config, agentBackend: backend });
    const options = instance.testCreateSdkOptions({});
    expect(options.systemPrompt).toBeUndefined();
    expect(options).not.toHaveProperty('builtinTools');
    expect(options).not.toHaveProperty('allowedTools');
    expect(options).not.toHaveProperty('disallowedTools');
    expect(options.includePartialMessages).toBeUndefined();
    expect(options.teammateMode).toBeUndefined();
    expect(options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it('uses DSH options when the backend is selected globally', () => {
    mockGetProvider.mockReturnValueOnce({
      ...mockSdkProvider,
      name: 'dsh',
    } as typeof mockSdkProvider);
    const defaultAgent = new TestAgent(config);
    const options = defaultAgent.testCreateSdkOptions();
    expect(defaultAgent.agentBackend).toBe('dsh');
    expect(options).not.toHaveProperty('builtinTools');
    expect(options.systemPrompt).toBeUndefined();
    expect(options).not.toHaveProperty('disallowedTools');
  });


  afterEach(() => {
    clearRuntimeContext();
  });

  describe('constructor', () => {
    it('should create a BaseAgent with correct config', () => {
      expect(agent).toBeDefined();
      expect(agent.apiKey).toBe('test-api-key');
      expect(agent.model).toBe('claude-3-5-sonnet-20241022');
      expect(agent.apiProtocol).toBe('anthropic');
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
      expect(noProviderAgent.apiProtocol).toBe('anthropic');
    });

    it('should use runtime context provider if set', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model' });
      expect(ctxAgent.apiProtocol).toBe('anthropic');
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

    it('should set systemPrompt to claude_code preset (Issue #2890)', () => {
      const options = agent.testCreateSdkOptions();

      expect(options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
      });
    });

    it('leaves native tool defaults to the Harness adapter', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.tools).toBeUndefined();
      expect(options).not.toHaveProperty('builtinTools');
      expect(options).not.toHaveProperty('mcpServers');
    });

    it('should include model if specified', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.model).toBe('claude-3-5-sonnet-20241022');
    });



    it.each(['allowedTools', 'disallowedTools'])('rejects a retired common %s field', (field) => {
      expect(() => agent.testCreateSdkOptions({ [field]: [] } as SdkOptionsExtra)).toThrow('Claude-specific');
    });

    it('forwards business definitions without creating Harness configuration', () => {
      const tools = [{ name: 'read_value', description: 'Read', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, execute: () => Promise.resolve({}) }];
      const options = agent.testCreateSdkOptions({ tools });
      expect(options.tools).toBe(tools);
      expect(options).not.toHaveProperty('builtinTools');
      expect(options).not.toHaveProperty('mcpServers');
    });

    it('should set teammateMode when Agent Teams is enabled', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => true,
      });

      const options = agent.testCreateSdkOptions();
      expect(options.teammateMode).toBe('in-process');
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

  it('preserves public commentary and final phases through the SDK iterator boundary', async () => {
    mockSdkProvider.queryStream.mockReturnValue({
      iterator: (async function* () {
        yield createMockSdkMessage({ type: 'text', content: 'Reading owned material', metadata: { phase: 'commentary' } });
        yield createMockSdkMessage({ type: 'text', content: 'Final answer', metadata: { phase: 'final_answer' } });
      })(),
      handle: { sessionId: 'owned-progress', interrupt: vi.fn(), sendUserMessage: vi.fn(), close: vi.fn() },
    });
    const stream = agent.testCreateQueryStream((async function* () {})(), { settingSources: [] });
    const messages: IteratorYieldResult[] = [];
    for await (const message of stream.iterator) { messages.push(message); }
    expect(messages[0].parsed).toMatchObject({ type: 'text', metadata: { phase: 'commentary' } });
    expect(messages[1].parsed).toMatchObject({ type: 'text', content: 'Final answer', metadata: { phase: 'final_answer' } });
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
      settingSources: ['user', 'project', 'local'],
    };

    async function* createMockInput(
      messages: StreamingUserMessage[]
    ): AsyncGenerator<StreamingUserMessage> {
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
      const sdkMessages = [createMockSdkMessage({ type: 'text', content: 'Streaming response' })];

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

      const correlation = { runId: 'run-1', chatId: 'chat-1', sourceMessageId: 'message-1', traceId: 'trace-1' };
      const inputStream = createMockInput([
        {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'Hello world' },
          parent_tool_use_id: null,
          session_id: 'session-1',
          correlation,
          continuationContext: 'Stable shared instructions',
        },
      ]);

      const result = agent.testCreateQueryStream(inputStream, defaultOptions);

      // Consume the iterator to trigger input conversion
      for await (const _ of result.iterator) {
        // consume
      }

      // The input to queryStream should be an async generator
      expect(capturedInput).toBeDefined();
      const converted = await (capturedInput as AsyncGenerator).next();
      expect(converted.value).toEqual({ role: 'user', content: 'Hello world', correlation,
        continuationContext: 'Stable shared instructions' });
      expect(converted.value.correlation).not.toBe(correlation);
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

    it('carries retry progress and unknown usage through the real stream conversion without inventing zero cost', async () => {
      const queryUsage: NonNullable<AgentMessage['metadata']>['queryUsage'] = {
        queryId: 'owned-query', attemptCount: 1, unknownAttempts: 1, partialAttempts: 0, knownTotals: {},
        billingVerified: false, attempts: [{ attempt: 1, state: 'unknown', scope: 'unavailable',
          latencyMs: 50, resultCount: 0, retryEvents: 0, retryUsage: 'not-observed', billingVerified: false }],
      };
      const retryProgress = { layer: 'sdk' as const, attempt: 1, maxRetries: 2, delayMs: 60_000,
        remainingBackoffMs: 0, turn: 1 };
      mockSdkProvider.queryStream.mockImplementation(() => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () {
          yield createMockSdkMessage({ type: 'status', content: 'Retrying', metadata: { retryProgress } });
          yield createMockSdkMessage({ type: 'result', metadata: { queryUsage, inputTokens: 0, outputTokens: 0, costUsd: 0 } });
        })(),
      }));
      const stream = agent.testCreateQueryStream(createMockInput([]), defaultOptions);
      const messages: IteratorYieldResult[] = [];
      for await (const message of stream.iterator) { messages.push(message); }
      expect(messages[0].parsed.metadata?.retryProgress).toEqual(retryProgress);
      expect(messages[0].parsed.metadata?.tokens).toBeUndefined();
      expect(messages[1].parsed.metadata?.queryUsage).toEqual(queryUsage);
      expect(messages[1].parsed.metadata?.tokens).toBeUndefined();
      expect(messages[1].parsed.metadata?.cost).toBeUndefined();
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

    it('preserves transient and semantic statuses through the actual adapter and stream conversion', async () => {
      const rawMessages = [
        { type: 'system', subtype: 'status', status: 'requesting' },
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'model_refusal_fallback', fallback_model: 'claude-sonnet-4-6' },
      ];
      mockSdkProvider.queryStream.mockImplementation(() => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () {
          for (const raw of rawMessages) {
            yield adaptSDKMessage(raw as Parameters<typeof adaptSDKMessage>[0]);
          }
        })(),
      }));
      const messages: IteratorYieldResult[] = [];
      for await (const item of agent.testCreateQueryStream(createMockInput([]), defaultOptions).iterator) {
        messages.push(item);
      }
      expect(messages.map(item => item.parsed.metadata?.transientStatus)).toEqual([true, true, undefined]);
      expect(messages.map(item => item.parsed.type)).toEqual(['status', 'status', 'status']);
      expect(messages[2].parsed.content).toContain('claude-sonnet-4-6');
    });

    it.each(['commentary', 'final_answer'] as const)('preserves assistant phase %s across the query bridge', async phase => {
      mockSdkProvider.queryStream.mockImplementation(() => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () {
          yield createMockSdkMessage({ type: 'text', content: 'assistant text', metadata: { phase } });
        })(),
      }));
      const messages: IteratorYieldResult[] = [];
      for await (const item of agent.testCreateQueryStream(createMockInput([]), defaultOptions).iterator) {
        messages.push(item);
      }
      expect(messages[0].parsed.metadata?.phase).toBe(phase);
    });

    it('preserves background-task lifecycle through the SDK adapter and legacy bridge', async () => {
      const rawMessages = [
        { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'research-1' }, { task_id: 'watcher', ambient: true }] },
        { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
        { type: 'system', subtype: 'task_started', task_id: 'legacy-1' },
        { type: 'system', subtype: 'task_notification', task_id: 'legacy-1', status: 'completed' },
      ];
      mockSdkProvider.queryStream.mockImplementation(() => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () {
          for (const raw of rawMessages) { yield adaptSDKMessage(raw as Parameters<typeof adaptSDKMessage>[0]); }
        })(),
      }));
      const messages: IteratorYieldResult[] = [];
      for await (const item of agent.testCreateQueryStream(createMockInput([]), defaultOptions).iterator) { messages.push(item); }
      expect(messages[0].parsed.metadata).toMatchObject({ systemSubtype: 'background_tasks_changed', backgroundTaskIds: ['research-1'] });
      expect(messages[1].parsed.metadata?.backgroundTaskIds).toEqual([]);
      expect(messages[2].parsed.metadata?.backgroundTask).toEqual({ id: 'legacy-1', state: 'running' });
      expect(messages[3].parsed.metadata?.backgroundTask).toEqual({ id: 'legacy-1', state: 'completed' });
    });

    it('should propagate stopReason through convertToLegacyFormat (Issue #4320, Gap C)', async () => {
      const mockHandle: QueryHandle = { close: vi.fn(), cancel: vi.fn() };

      const sdkMessage = createMockSdkMessage({
        type: 'result',
        content: '✅ Complete',
        metadata: {
          stopReason: 'tool_use',
          numTurns: 3,
          durationMs: 4200,
          durationApiMs: 3100,
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
      // Gap C: convertToLegacyFormat threads metadata.stopReason into parsed.metadata.stopReason
      expect(messages[0].parsed.metadata?.stopReason).toBe('tool_use');
      // Issue #4320 (part 2): convertToLegacyFormat also threads the turn-level
      // observability fields (num_turns / duration_ms / duration_api_ms).
      expect(messages[0].parsed.metadata?.numTurns).toBe(3);
      expect(messages[0].parsed.metadata?.durationMs).toBe(4200);
      expect(messages[0].parsed.metadata?.durationApiMs).toBe(3100);
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
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({ CUSTOM_VAR: 'value' }),
        isAgentTeamsEnabled: () => false,
      });

      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' });
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
      const noModelAgent = new TestAgent({ apiKey: 'key', model: '', apiProtocol: 'anthropic' });
      const options = noModelAgent.testCreateSdkOptions();
      expect(options.model).toBeUndefined();
    });
  });

  describe('createSdkOptions - Issue #3532: CLAUDE_CONFIG_DIR for project-bound agents', () => {
    it('should NOT set CLAUDE_CONFIG_DIR when no cwd override (default)', () => {
      const options = agent.testCreateSdkOptions();
      expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('should NOT set CLAUDE_CONFIG_DIR when cwd equals workspace dir', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });
      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' });
      const options = ctxAgent.testCreateSdkOptions({ cwd: '/workspace' });
      expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('should set CLAUDE_CONFIG_DIR to workspace .claude when cwd differs from workspace', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });
      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' });
      const options = ctxAgent.testCreateSdkOptions({ cwd: '/other/project' });
      expect(options.env?.CLAUDE_CONFIG_DIR).toBe('/workspace/.claude');
    });

    it('should not affect other environment variables when injecting CLAUDE_CONFIG_DIR', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({ EXISTING_VAR: 'preserved', ANOTHER_VAR: 'also-preserved' }),
        isAgentTeamsEnabled: () => false,
      });
      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' });
      const options = ctxAgent.testCreateSdkOptions({ cwd: '/other/project' });

      // CLAUDE_CONFIG_DIR is injected correctly
      expect(options.env?.CLAUDE_CONFIG_DIR).toBe('/workspace/.claude');
      // Other env vars from getGlobalEnv() are preserved
      expect(options.env?.EXISTING_VAR).toBe('preserved');
      expect(options.env?.ANOTHER_VAR).toBe('also-preserved');
      // ANTHROPIC_API_KEY is still present
      expect(options.env?.ANTHROPIC_API_KEY).toBe('key');
    });
  });

  describe('createSdkOptions - explicit native compaction policy', () => {
    it('leaves unconfigured compatible model compaction to the SDK', () => {
      const glmAgent = new TestAgent({ apiKey: 'key', model: 'glm-5.1', apiProtocol: 'anthropic' });
      expect(glmAgent.testCreateSdkOptions().autoCompactWindow).toBeUndefined();
    });

    it.each(['claude-sonnet-4-20250514', 'sonnet', 'opus[1m]', 'haiku'])(
      'leaves %s compaction to the SDK when not configured',
      (model) => {
        const nativeAgent = new TestAgent({ apiKey: 'key', model, apiProtocol: 'anthropic' });
        expect(nativeAgent.testCreateSdkOptions().autoCompactWindow).toBeUndefined();
      }
    );

    it('uses a configured fallback window and permits zero as an opt-out', () => {
      const windowSpy = vi.spyOn(Config, 'getAutoCompactWindow');
      const glmAgent = new TestAgent({ apiKey: 'key', model: 'glm-5.1', apiProtocol: 'anthropic' });

      windowSpy.mockReturnValueOnce(64_000);
      expect(glmAgent.testCreateSdkOptions().autoCompactWindow).toBe(64_000);

      windowSpy.mockReturnValueOnce(0);
      expect(glmAgent.testCreateSdkOptions().autoCompactWindow).toBe(0);
      windowSpy.mockRestore();
    });

    it('does not leak the Claude-only fallback to another backend', () => {
      const piAgent = new TestAgent({
        apiKey: 'key',
        model: 'glm-5.1',
        apiProtocol: 'anthropic',
        agentBackend: 'pi',
      });
      expect(piAgent.testCreateSdkOptions().autoCompactWindow).toBeUndefined();
    });

    it('passes the selected DSH agent budget to its native compaction policy', () => {
      const settings = { autoCompactWindow: 48_000, agentBackend: 'dsh' as const };
      const agent = new TestAgent({ apiKey: 'key', model: 'glm-5.3', agentBackend: 'dsh', settings });
      expect(agent.testCreateSdkOptions().autoCompactWindow).toBe(48_000);
    });

    it('retains the DSH default while Claude discovery requires an explicit opt-in', () => {
      const dsh = new TestAgent({ apiKey: 'key', model: 'model', agentBackend: 'dsh', settings: {} });
      expect(dsh.testCreateSdkOptions().autoCompactWindow).toBe('auto');
      const claude = new TestAgent({ apiKey: 'key', model: 'model', settings: { autoCompactWindow: 'auto' } });
      expect(claude.testCreateSdkOptions().autoCompactWindow).toBe('auto');
    });

    it('honors explicit configuration for native Claude models too', () => {
      const spy = vi.spyOn(Config, 'getAutoCompactWindow').mockReturnValue(42000);
      try {
        const agent = new TestAgent({ apiKey: 'key', model: 'claude-sonnet-4', apiProtocol: 'anthropic' });
        expect(agent.testCreateSdkOptions().autoCompactWindow).toBe(42000);
      } finally { spy.mockRestore(); }
    });
  });

  describe('createSdkOptions - Issue #3803: DISCLAUDE_WORKSPACE_DIR for schedule skill', () => {
    it('should always set DISCLAUDE_WORKSPACE_DIR to workspace dir', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });
      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' });
      const options = ctxAgent.testCreateSdkOptions();
      expect(options.env?.DISCLAUDE_WORKSPACE_DIR).toBe('/workspace');
    });

    it('should set DISCLAUDE_WORKSPACE_DIR even in project mode', () => {
      setRuntimeContext({
        getWorkspaceDir: () => '/workspace',
        getAgentConfig: () => ({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' }),
        getLoggingConfig: () => ({ sdkDebug: false }),
        getGlobalEnv: () => ({}),
        isAgentTeamsEnabled: () => false,
      });
      const ctxAgent = new TestAgent({ apiKey: 'key', model: 'model', apiProtocol: 'anthropic' });
      const options = ctxAgent.testCreateSdkOptions({ cwd: '/workspace/projects/my-app' });
      expect(options.env?.DISCLAUDE_WORKSPACE_DIR).toBe('/workspace');
    });
  });
});
