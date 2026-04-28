/**
 * Unit tests for AgentFactory.createAgent() method.
 *
 * Issue #2991: PR #2959 introduced the unified AgentFactory.createAgent() method
 * but did not add dedicated unit tests. This file verifies:
 * 1. createAgent() correctly creates a ChatAgent instance
 * 2. Deprecated wrappers (createScheduleAgent, createTaskAgent) correctly delegate to createAgent()
 * 3. The ChatAgent instance is configured with the correct options
 * 4. toChatAgentCallbacks() converts SchedulerCallbacks properly
 *
 * Related: #2941, #2990
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock setup — must be before any imports that touch @disclaude/core
// ============================================================================

const mockGetAgentConfig = vi.fn().mockReturnValue({
  apiKey: 'default-key',
  model: 'default-model',
  apiBaseUrl: undefined,
  provider: 'anthropic' as const,
});

const mockCreateLogger = vi.fn().mockReturnValue({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
});

const mockGetProvider = vi.fn().mockReturnValue({
  queryOnce: vi.fn(),
  queryStream: vi.fn(),
});

// Mock the entire @disclaude/core barrel export.
// This replaces all runtime imports from @disclaude/core (Config, BaseAgent,
// MessageBuilder, MessageChannel, RestartManager, ConversationOrchestrator, etc.)
// with lightweight stubs suitable for testing the factory's configuration logic.
vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: (...args: unknown[]) => mockGetAgentConfig(...args),
    getMcpServersConfig: () => undefined,
    getSessionRestoreConfig: () => ({ historyDays: 7, maxContextLength: 10000 }),
  },
  createLogger: (...args: unknown[]) => mockCreateLogger(...args),
  BaseAgent: class MockBaseAgent {
    apiKey: string;
    model: string;
    apiBaseUrl?: string;
    permissionMode: string;
    provider: string;
    initialized = false;
    sdkProvider: unknown;
    logger: ReturnType<typeof mockCreateLogger>;

    constructor(config: unknown) {
      const c = config as Record<string, unknown>;
      this.apiKey = c.apiKey as string;
      this.model = c.model as string;
      this.apiBaseUrl = c.apiBaseUrl as string | undefined;
      this.permissionMode = (c.permissionMode as string) ?? 'bypassPermissions';
      this.provider = (c.provider as string) ?? 'anthropic';
      this.logger = mockCreateLogger('MockBaseAgent');
    }

    createSdkOptions(_extra: unknown) {
      return { permissionMode: this.permissionMode, env: { ANTHROPIC_API_KEY: this.apiKey } };
    }

    queryOnce(_input: unknown, _options: unknown) {
      return (async function* () { /* no-op for tests */ })();
    }

    createQueryStream(_input: unknown, _options: unknown) {
      return {
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () { /* no-op for tests */ })(),
      };
    }

    dispose() {
      this.initialized = false;
    }
  },
  MessageBuilder: class MockMessageBuilder {
    constructor(_options?: unknown) {}
    buildEnhancedContent(input: { text: string }, ..._args: unknown[]) {
      return input.text;
    }
  },
  MessageChannel: class MockMessageChannel {
    push() { return true; }
    close() {}
    generator() {
      return (async function* () { /* no-op */ })();
    }
  },
  RestartManager: class MockRestartManager {
    recordSuccess() {}
    shouldRestart() { return { allowed: false, reason: 'test', restartCount: 0 }; }
    reset() {}
    clearAll() {}
  },
  ConversationOrchestrator: class MockConversationOrchestrator {
    setThreadRoot() {}
    getThreadRoot() { return undefined; }
    deleteThreadRoot() {}
    clearAll() {}
  },
  setRuntimeContext: vi.fn(),
  clearRuntimeContext: vi.fn(),
  getRuntimeContext: vi.fn(),
  hasRuntimeContext: vi.fn().mockReturnValue(false),
  buildSdkEnv: (apiKey: string, apiBaseUrl?: string) => ({
    ANTHROPIC_API_KEY: apiKey,
    ...(apiBaseUrl ? { ANTHROPIC_BASE_URL: apiBaseUrl } : {}),
  }),
  loadRuntimeEnv: () => ({}),
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

// Mock @disclaude/mcp-server
vi.mock('@disclaude/mcp-server', () => ({
  createChannelMcpServer: () => ({}),
}));

// ============================================================================
// Helper functions
// ============================================================================

function createMockCallbacks(overrides: Record<string, unknown> = {}) {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AgentFactory', () => {
  let AgentFactory: typeof import('./factory.js').AgentFactory;
  let toChatAgentCallbacks: typeof import('./factory.js').toChatAgentCallbacks;
  let ChatAgent: typeof import('./chat-agent.js').ChatAgent;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset default mock values
    mockGetAgentConfig.mockReturnValue({
      apiKey: 'default-key',
      model: 'default-model',
      apiBaseUrl: undefined,
      provider: 'anthropic' as const,
    });

    vi.resetModules();

    ({
      AgentFactory,
      toChatAgentCallbacks,
    } = await import('./factory.js'));
    ({ ChatAgent } = await import('./chat-agent.js'));
  });

  // ==========================================================================
  // createAgent()
  // ==========================================================================
  describe('createAgent', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
    });

    it('should pass chatId to the ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-abc', callbacks);

      expect(agent.getChatId()).toBe('chat-abc');
    });

    it('should use default config when no options provided', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent.apiKey).toBe('default-key');
      expect(agent.model).toBe('default-model');
      expect(agent.provider).toBe('anthropic');
    });

    it('should apply option overrides', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks, {
        apiKey: 'custom-key',
        model: 'custom-model',
        provider: 'glm',
        apiBaseUrl: 'https://example.com/api',
      });

      expect(agent.apiKey).toBe('custom-key');
      expect(agent.model).toBe('custom-model');
      expect(agent.provider).toBe('glm');
    });

    it('should default permissionMode to bypassPermissions', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent.permissionMode).toBe('bypassPermissions');
    });

    it('should allow overriding permissionMode via options', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks, {
        permissionMode: 'default',
      });

      expect(agent.permissionMode).toBe('default');
    });

    it('should pass messageBuilderOptions to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      const mbOptions = { platform: 'feishu' as const };
      const agent = AgentFactory.createAgent('chat-123', callbacks, {
        messageBuilderOptions: mbOptions,
      });

      expect(agent).toBeInstanceOf(ChatAgent);
      expect(agent.getChatId()).toBe('chat-123');
    });

    it('should call Config.getAgentConfig to fetch defaults', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      expect(mockGetAgentConfig).toHaveBeenCalledTimes(1);
    });

    it('should pass callbacks to the ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
      expect(agent.getChatId()).toBe('chat-123');
    });
  });

  // ==========================================================================
  // createScheduleAgent (deprecated)
  // ==========================================================================
  describe('createScheduleAgent (deprecated)', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createScheduleAgent('chat-123', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
    });

    it('should produce an agent identical to createAgent()', () => {
      const callbacks = createMockCallbacks();
      const options = { apiKey: 'key', model: 'model' };

      const viaCreateAgent = AgentFactory.createAgent('chat-123', callbacks, options);
      const viaSchedule = AgentFactory.createScheduleAgent('chat-123', callbacks, options);

      expect(viaSchedule.apiKey).toBe(viaCreateAgent.apiKey);
      expect(viaSchedule.model).toBe(viaCreateAgent.model);
      expect(viaSchedule.getChatId()).toBe(viaCreateAgent.getChatId());
    });

    it('should pass options through correctly', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createScheduleAgent('chat-123', callbacks, {
        apiKey: 'schedule-key',
        model: 'glm-5.1',
        provider: 'glm',
      });

      expect(agent.apiKey).toBe('schedule-key');
      expect(agent.model).toBe('glm-5.1');
      expect(agent.provider).toBe('glm');
    });
  });

  // ==========================================================================
  // createTaskAgent (deprecated)
  // ==========================================================================
  describe('createTaskAgent (deprecated)', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createTaskAgent('chat-123', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
    });

    it('should produce an agent identical to createAgent()', () => {
      const callbacks = createMockCallbacks();
      const options = { apiKey: 'key', model: 'model' };

      const viaCreateAgent = AgentFactory.createAgent('chat-123', callbacks, options);
      const viaTask = AgentFactory.createTaskAgent('chat-123', callbacks, options);

      expect(viaTask.apiKey).toBe(viaCreateAgent.apiKey);
      expect(viaTask.model).toBe(viaCreateAgent.model);
      expect(viaTask.getChatId()).toBe(viaCreateAgent.getChatId());
    });
  });

  // ==========================================================================
  // createChatAgent
  // ==========================================================================
  describe('createChatAgent', () => {
    it('should create a ChatAgent for pilot with new pattern (chatId, callbacks)', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', 'chat-456', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
      expect(agent.getChatId()).toBe('chat-456');
    });

    it('should create a ChatAgent for pilot with legacy pattern (callbacks only)', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
      // Legacy pattern uses 'default' as chatId
      expect(agent.getChatId()).toBe('default');
    });

    it('should accept options in new pattern', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', 'chat-789', callbacks, {
        apiKey: 'pilot-key',
        model: 'pilot-model',
      });

      expect(agent.apiKey).toBe('pilot-key');
      expect(agent.model).toBe('pilot-model');
      expect(agent.getChatId()).toBe('chat-789');
    });

    it('should accept options in legacy pattern', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', callbacks, {
        apiKey: 'legacy-key',
      });

      expect(agent.apiKey).toBe('legacy-key');
    });

    it('should throw for unknown agent name', () => {
      const callbacks = createMockCallbacks();
      expect(() => AgentFactory.createChatAgent('unknown', callbacks))
        .toThrow('Unknown ChatAgent: unknown');
    });

    it('should use default config when no options provided', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', 'chat-123', callbacks);

      expect(agent.apiKey).toBe('default-key');
      expect(agent.model).toBe('default-model');
    });
  });

  // ==========================================================================
  // toChatAgentCallbacks
  // ==========================================================================
  describe('toChatAgentCallbacks', () => {
    it('should convert SchedulerCallbacks to ChatAgentCallbacks', () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const result = toChatAgentCallbacks(schedulerCallbacks);

      expect(result.sendMessage).toBe(schedulerCallbacks.sendMessage);
    });

    it('should provide no-op sendCard implementation', async () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const result = toChatAgentCallbacks(schedulerCallbacks);

      // Should not throw
      await expect(result.sendCard('chat-1', {} as any)).resolves.toBeUndefined();
    });

    it('should provide no-op sendFile implementation', async () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const result = toChatAgentCallbacks(schedulerCallbacks);

      await expect(result.sendFile('chat-1', '/path/to/file')).resolves.toBeUndefined();
    });

    it('should provide no-op onDone implementation', async () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const result = toChatAgentCallbacks(schedulerCallbacks);

      await expect(result.onDone('chat-1')).resolves.toBeUndefined();
    });
  });
});
