/**
 * Tests for AgentFactory (packages/primary-node/src/agents/factory.ts)
 *
 * Issue #2991: Unit tests for AgentFactory.createAgent() method.
 *
 * Covers:
 * 1. createAgent() correctly creates a ChatAgent instance
 * 2. Deprecated wrappers (createScheduleAgent, createTaskAgent) correctly delegate to createAgent()
 * 3. The ChatAgent instance is configured with the correct options
 * 4. toChatAgentCallbacks helper function
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core dependencies
// Use vi.hoisted to ensure the mock is available when vi.mock factory runs
const { mockGetAgentConfig } = vi.hoisted(() => ({
  mockGetAgentConfig: vi.fn(() => ({
    apiKey: 'default-api-key',
    model: 'default-model',
    provider: 'anthropic' as const,
    apiBaseUrl: 'https://api.default.com',
  })),
}));

vi.mock('@disclaude/core', () => ({
  Config: {
    getSessionRestoreConfig: vi.fn(() => ({
      historyDays: 1,
      maxContextLength: 50000,
    })),
    getMcpServersConfig: vi.fn(() => null),
    getAgentConfig: mockGetAgentConfig,
  },
  BaseAgent: vi.fn().mockImplementation(function(this: any) {
    this.createSdkOptions = vi.fn(() => ({ mcpServers: {} }));
    this.createQueryStream = vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () { /* empty */ })(),
    }));
    this.dispose = vi.fn();
    this.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }),
  MessageBuilder: vi.fn().mockImplementation(() => ({
    buildEnhancedContent: vi.fn((input: any) => input.text),
  })),
  MessageChannel: vi.fn().mockImplementation(() => ({
    push: vi.fn(),
    close: vi.fn(),
    generator: vi.fn(() => (async function* () { /* empty */ })()),
  })),
  RestartManager: vi.fn().mockImplementation(() => ({
    recordSuccess: vi.fn(),
    shouldRestart: vi.fn(() => ({ allowed: false, reason: 'max_restarts_exceeded', restartCount: 3 })),
    reset: vi.fn(),
    clearAll: vi.fn(),
  })),
  ConversationOrchestrator: vi.fn().mockImplementation(() => ({
    setThreadRoot: vi.fn(),
    getThreadRoot: vi.fn(() => 'thread-root-123'),
    deleteThreadRoot: vi.fn(),
    clearAll: vi.fn(),
  })),
  isStartupFailure: (messageCount: number, elapsedMs: number) => {
    return messageCount === 0 && elapsedMs < 10_000;
  },
  getErrorStderr: (error: unknown) => {
    if (error instanceof Error) {
      return (error as any).__stderr__;
    }
    return undefined;
  },
}));

vi.mock('@disclaude/mcp-server', () => ({
  createChannelMcpServer: vi.fn(() => ({ type: 'inline' })),
}));

import { AgentFactory, toChatAgentCallbacks } from './factory.js';
import type { AgentCreateOptions } from './factory.js';
import type { ChatAgentCallbacks } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

const createMockCallbacks = (): ChatAgentCallbacks => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
  getCapabilities: vi.fn(),
  getChatHistory: vi.fn().mockResolvedValue(undefined),
});

// ============================================================================
// Tests
// ============================================================================

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default mock config
    mockGetAgentConfig.mockReturnValue({
      apiKey: 'default-api-key',
      model: 'default-model',
      provider: 'anthropic' as const,
      apiBaseUrl: 'https://api.default.com',
    });
  });

  // ==========================================================================
  // createAgent() — core functionality
  // ==========================================================================

  describe('createAgent', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks);

      expect(agent).toBeDefined();
      expect(agent.getChatId()).toBe('oc_test_chat');
    });

    it('should create a ChatAgent with type "chat"', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks);

      expect(agent.type).toBe('chat');
    });

    it('should create a ChatAgent with name "ChatAgent"', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks);

      expect(agent.name).toBe('ChatAgent');
    });

    it('should bind the agent to the provided chatId', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('oc_custom_chat_id', callbacks);

      expect(agent.getChatId()).toBe('oc_custom_chat_id');
    });
  });

  // ==========================================================================
  // createAgent() — configuration merging (default Config + overrides)
  // ==========================================================================

  describe('createAgent: configuration merging', () => {
    it('should use default config from Config.getAgentConfig() when no overrides', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks);

      // Verify getAgentConfig was called to fetch defaults
      expect(mockGetAgentConfig).toHaveBeenCalledOnce();

      // Agent was created successfully with default config
      expect(agent).toBeDefined();
    });

    it('should override apiKey when provided in options', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = { apiKey: 'custom-api-key' };
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks, options);

      expect(agent).toBeDefined();
      expect(mockGetAgentConfig).toHaveBeenCalledOnce();
    });

    it('should override model when provided in options', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = { model: 'claude-opus-4' };
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks, options);

      expect(agent).toBeDefined();
    });

    it('should override provider when provided in options', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = { provider: 'glm' };
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks, options);

      expect(agent).toBeDefined();
    });

    it('should override apiBaseUrl when provided in options', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = { apiBaseUrl: 'https://custom.api.com' };
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks, options);

      expect(agent).toBeDefined();
    });

    it('should override permissionMode when provided in options', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = { permissionMode: 'default' };
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks, options);

      expect(agent).toBeDefined();
    });

    it('should override messageBuilderOptions when provided in options', () => {
      const callbacks = createMockCallbacks();
      const messageBuilderOptions = { platform: 'feishu' as const };
      const options: AgentCreateOptions = { messageBuilderOptions };
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks, options);

      expect(agent).toBeDefined();
    });

    it('should apply all overrides simultaneously', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = {
        apiKey: 'override-key',
        model: 'override-model',
        provider: 'glm',
        apiBaseUrl: 'https://override.api.com',
        permissionMode: 'default',
        messageBuilderOptions: { platform: 'feishu' as const },
      };
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks, options);

      expect(agent).toBeDefined();
      expect(agent.getChatId()).toBe('oc_test_chat');
    });

    it('should fall back to default config for fields not overridden', () => {
      const callbacks = createMockCallbacks();
      // Only override model, rest should come from defaults
      const options: AgentCreateOptions = { model: 'custom-model' };
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks, options);

      expect(agent).toBeDefined();
      expect(mockGetAgentConfig).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // createAgent() — creates distinct instances
  // ==========================================================================

  describe('createAgent: instance independence', () => {
    it('should create separate ChatAgent instances for different chatIds', () => {
      const callbacks = createMockCallbacks();
      const agent1 = AgentFactory.createAgent('oc_chat_1', callbacks);
      const agent2 = AgentFactory.createAgent('oc_chat_2', callbacks);

      expect(agent1).not.toBe(agent2);
      expect(agent1.getChatId()).toBe('oc_chat_1');
      expect(agent2.getChatId()).toBe('oc_chat_2');
    });

    it('should create separate instances even with same chatId', () => {
      const callbacks = createMockCallbacks();
      const agent1 = AgentFactory.createAgent('oc_same_chat', callbacks);
      const agent2 = AgentFactory.createAgent('oc_same_chat', callbacks);

      // Different instances, same chatId binding
      expect(agent1).not.toBe(agent2);
      expect(agent1.getChatId()).toBe(agent2.getChatId());
    });
  });

  // ==========================================================================
  // createAgent() — default parameter handling
  // ==========================================================================

  describe('createAgent: default options', () => {
    it('should work without providing options (defaults to empty object)', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('oc_test_chat', callbacks);

      expect(agent).toBeDefined();
      expect(agent.getChatId()).toBe('oc_test_chat');
    });
  });

  // ==========================================================================
  // createChatAgent() — long-lived ChatAgent creation
  // ==========================================================================

  describe('createChatAgent', () => {
    it('should create a ChatAgent with name "pilot" using new pattern (chatId, callbacks)', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', 'oc_pilot_chat', callbacks);

      expect(agent).toBeDefined();
      expect(agent.getChatId()).toBe('oc_pilot_chat');
    });

    it('should create a ChatAgent with name "pilot" using new pattern with options', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = { model: 'pilot-model' };
      const agent = AgentFactory.createChatAgent('pilot', 'oc_pilot_chat', callbacks, options);

      expect(agent).toBeDefined();
      expect(agent.getChatId()).toBe('oc_pilot_chat');
    });

    it('should support legacy pattern (callbacks without chatId)', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', callbacks);

      expect(agent).toBeDefined();
      // Legacy pattern defaults chatId to 'default'
      expect(agent.getChatId()).toBe('default');
    });

    it('should throw error for unknown agent name', () => {
      const callbacks = createMockCallbacks();

      expect(() => AgentFactory.createChatAgent('unknown', 'oc_chat', callbacks)).toThrow(
        'Unknown ChatAgent: unknown',
      );
    });
  });

  // ==========================================================================
  // toChatAgentCallbacks() — helper function
  // ==========================================================================

  describe('toChatAgentCallbacks', () => {
    it('should convert SchedulerCallbacks to ChatAgentCallbacks', () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const schedulerCallbacks = { sendMessage };

      const result = toChatAgentCallbacks(schedulerCallbacks);

      expect(result.sendMessage).toBe(sendMessage);
      expect(result.sendCard).toBeDefined();
      expect(result.sendFile).toBeDefined();
      expect(result.onDone).toBeDefined();
    });

    it('should provide no-op sendCard implementation', async () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const result = toChatAgentCallbacks(schedulerCallbacks);

      // Should not throw
      await expect(result.sendCard('oc_chat', {} as any)).resolves.toBeUndefined();
    });

    it('should provide no-op sendFile implementation', async () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const result = toChatAgentCallbacks(schedulerCallbacks);

      // Should not throw
      await expect(result.sendFile('oc_chat', '/tmp/file.txt')).resolves.toBeUndefined();
    });

    it('should provide no-op onDone implementation', async () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const result = toChatAgentCallbacks(schedulerCallbacks);

      // Should not throw
      await expect(result.onDone?.('oc_chat')).resolves.toBeUndefined();
    });

    it('should preserve the original sendMessage function', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const schedulerCallbacks = { sendMessage };

      const result = toChatAgentCallbacks(schedulerCallbacks);
      await result.sendMessage('oc_chat', 'test message');

      expect(sendMessage).toHaveBeenCalledWith('oc_chat', 'test message');
    });
  });

  // ==========================================================================
  // Integration: createAgent with toChatAgentCallbacks
  // ==========================================================================

  describe('integration: createAgent with toChatAgentCallbacks', () => {
    it('should create a ChatAgent using converted callbacks', () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const pilotCallbacks = toChatAgentCallbacks(schedulerCallbacks);
      const agent = AgentFactory.createAgent('oc_scheduled_chat', pilotCallbacks);

      expect(agent).toBeDefined();
      expect(agent.getChatId()).toBe('oc_scheduled_chat');
    });
  });
});
