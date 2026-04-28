/**
 * Tests for AgentFactory (packages/primary-node/src/agents/factory.ts)
 *
 * Issue #2991: PR #2959 introduced the unified AgentFactory.createAgent() method
 * but did not add dedicated unit tests. This file verifies:
 *
 * 1. createAgent() correctly creates a ChatAgent instance
 * 2. createAgent() applies configuration overrides (apiKey, model, provider, etc.)
 * 3. Deprecated wrappers (createScheduleAgent, createTaskAgent) correctly delegate to createAgent()
 * 4. createChatAgent() creates pilot agents with correct config
 * 5. toChatAgentCallbacks() correctly converts SchedulerCallbacks to ChatAgentCallbacks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures these are available in vi.mock factory (which is hoisted to top)
const { mockGetAgentConfig, mockMessageBuilder } = vi.hoisted(() => ({
  mockGetAgentConfig: vi.fn(() => ({
    apiKey: 'default-test-key',
    model: 'default-test-model',
    provider: 'anthropic' as const,
    apiBaseUrl: undefined,
  })),
  mockMessageBuilder: vi.fn().mockImplementation((options: any) => ({
    buildEnhancedContent: vi.fn((input: any) => input.text),
    _options: options,
  })),
}));

// Mock all @disclaude/core dependencies — same pattern as chat-agent.test.ts
vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: mockGetAgentConfig,
    getSessionRestoreConfig: vi.fn(() => ({
      historyDays: 1,
      maxContextLength: 50000,
    })),
    getMcpServersConfig: vi.fn(() => null),
  },
  BaseAgent: vi.fn().mockImplementation(function(this: any, config: any) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiBaseUrl = config.apiBaseUrl;
    this.permissionMode = config.permissionMode ?? 'bypassPermissions';
    this.provider = config.provider ?? 'anthropic';
    this.createSdkOptions = vi.fn(() => ({ mcpServers: {} }));
    this.createQueryStream = vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () { /* empty */ })(),
    }));
    this.queryOnce = vi.fn(() => (async function* () {
      yield { parsed: { type: 'result', content: 'done' } };
    })());
    this.dispose = vi.fn();
    this.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }),
  MessageBuilder: mockMessageBuilder,
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
}));

vi.mock('@disclaude/mcp-server', () => ({
  createChannelMcpServer: vi.fn(() => ({ type: 'inline' })),
}));

import { AgentFactory, toChatAgentCallbacks } from './factory.js';
import { ChatAgent } from './chat-agent.js';

const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
  getCapabilities: vi.fn(),
  getChatHistory: vi.fn().mockResolvedValue(undefined),
});

describe('AgentFactory', () => {
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    callbacks = createMockCallbacks();
    vi.clearAllMocks();
  });

  // ==========================================================================
  // createAgent() — short-lived ChatAgent for task execution
  // ==========================================================================

  describe('createAgent()', () => {
    it('should create a ChatAgent instance', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
    });

    it('should bind the correct chatId', () => {
      const agent = AgentFactory.createAgent('chat-456', callbacks);

      expect(agent.getChatId()).toBe('chat-456');
    });

    it('should use default config when no options provided', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      // Verify that Config.getAgentConfig was called to get defaults
      expect(mockGetAgentConfig).toHaveBeenCalled();

      // Verify BaseAgent received the default config values
      expect(agent.apiKey).toBe('default-test-key');
      expect(agent.model).toBe('default-test-model');
    });

    it('should apply apiKey override', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks, {
        apiKey: 'custom-key',
      });

      expect(agent.apiKey).toBe('custom-key');
    });

    it('should apply model override', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks, {
        model: 'custom-model',
      });

      expect(agent.model).toBe('custom-model');
    });

    it('should apply provider override', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks, {
        provider: 'glm',
      });

      expect(agent.provider).toBe('glm');
    });

    it('should apply apiBaseUrl override', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks, {
        apiBaseUrl: 'https://custom-api.example.com',
      });

      expect(agent.apiBaseUrl).toBe('https://custom-api.example.com');
    });

    it('should apply permissionMode override', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks, {
        permissionMode: 'default',
      });

      expect(agent.permissionMode).toBe('default');
    });

    it('should default permissionMode to bypassPermissions', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent.permissionMode).toBe('bypassPermissions');
    });

    it('should pass messageBuilderOptions to ChatAgent config', () => {
      const messageBuilderOptions = {
        buildHeader: vi.fn((_ctx: any) => '[header]'),
      };
      const options = { messageBuilderOptions };
      AgentFactory.createAgent('chat-123', callbacks, options);

      // Verify MessageBuilder was constructed with the options
      expect(mockMessageBuilder).toHaveBeenCalledWith(messageBuilderOptions);
    });

    it('should pass undefined messageBuilderOptions when not provided', () => {
      AgentFactory.createAgent('chat-123', callbacks);

      // Verify MessageBuilder was constructed with undefined
      expect(mockMessageBuilder).toHaveBeenCalledWith(undefined);
    });

    it('should apply multiple overrides simultaneously', () => {
      const agent = AgentFactory.createAgent('chat-789', callbacks, {
        apiKey: 'multi-key',
        model: 'multi-model',
        provider: 'glm',
        apiBaseUrl: 'https://multi.example.com',
        permissionMode: 'default',
      });

      expect(agent.apiKey).toBe('multi-key');
      expect(agent.model).toBe('multi-model');
      expect(agent.provider).toBe('glm');
      expect(agent.apiBaseUrl).toBe('https://multi.example.com');
      expect(agent.permissionMode).toBe('default');
      expect(agent.getChatId()).toBe('chat-789');
    });
  });

  // ==========================================================================
  // createScheduleAgent() — deprecated wrapper
  // ==========================================================================

  describe('createScheduleAgent()', () => {
    it('should create a ChatAgent instance (delegates to createAgent)', () => {
      const agent = AgentFactory.createScheduleAgent('chat-sched', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
      expect(agent.getChatId()).toBe('chat-sched');
    });

    it('should pass through options to createAgent', () => {
      const agent = AgentFactory.createScheduleAgent('chat-sched', callbacks, {
        apiKey: 'sched-key',
        model: 'sched-model',
      });

      expect(agent.apiKey).toBe('sched-key');
      expect(agent.model).toBe('sched-model');
    });
  });

  // ==========================================================================
  // createTaskAgent() — deprecated wrapper
  // ==========================================================================

  describe('createTaskAgent()', () => {
    it('should create a ChatAgent instance (delegates to createAgent)', () => {
      const agent = AgentFactory.createTaskAgent('chat-task', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
      expect(agent.getChatId()).toBe('chat-task');
    });

    it('should pass through options to createAgent', () => {
      const agent = AgentFactory.createTaskAgent('chat-task', callbacks, {
        apiKey: 'task-key',
        model: 'task-model',
      });

      expect(agent.apiKey).toBe('task-key');
      expect(agent.model).toBe('task-model');
    });
  });

  // ==========================================================================
  // createChatAgent() — long-lived ChatAgent by name
  // ==========================================================================

  describe('createChatAgent()', () => {
    it('should create a ChatAgent when name is "pilot" with chatId', () => {
      const agent = AgentFactory.createChatAgent('pilot', 'chat-pilot', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
      expect(agent.getChatId()).toBe('chat-pilot');
    });

    it('should support legacy pattern (callbacks without chatId)', () => {
      // Legacy pattern: createChatAgent('pilot', callbacks, options)
      const agent = AgentFactory.createChatAgent('pilot', callbacks);

      expect(agent).toBeInstanceOf(ChatAgent);
      expect(agent.getChatId()).toBe('default');
    });

    it('should apply options in new pattern', () => {
      const agent = AgentFactory.createChatAgent('pilot', 'chat-pilot', callbacks, {
        apiKey: 'pilot-key',
        model: 'pilot-model',
      });

      expect(agent.apiKey).toBe('pilot-key');
      expect(agent.model).toBe('pilot-model');
    });

    it('should apply options in legacy pattern', () => {
      const agent = AgentFactory.createChatAgent('pilot', callbacks, {
        apiKey: 'legacy-key',
      });

      expect(agent.apiKey).toBe('legacy-key');
    });

    it('should throw error for unknown agent name', () => {
      expect(() => {
        AgentFactory.createChatAgent('unknown', 'chat-123', callbacks);
      }).toThrow('Unknown ChatAgent: unknown');
    });

    it('should pass messageBuilderOptions to ChatAgent config', () => {
      const messageBuilderOptions = {
        buildHeader: vi.fn((_ctx: any) => '[header]'),
      };
      const options = { messageBuilderOptions };
      AgentFactory.createChatAgent('pilot', 'chat-pilot', callbacks, options);

      expect(mockMessageBuilder).toHaveBeenCalledWith(messageBuilderOptions);
    });
  });
});

// ==========================================================================
// toChatAgentCallbacks() — helper function
// ==========================================================================

describe('toChatAgentCallbacks()', () => {
  it('should preserve sendMessage from SchedulerCallbacks', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const schedulerCallbacks = { sendMessage };
    const result = toChatAgentCallbacks(schedulerCallbacks);

    expect(result.sendMessage).toBe(sendMessage);
  });

  it('should provide no-op sendCard', async () => {
    const schedulerCallbacks = { sendMessage: vi.fn() };
    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.sendCard('chat-123', {} as any)).resolves.toBeUndefined();
  });

  it('should provide no-op sendFile', async () => {
    const schedulerCallbacks = { sendMessage: vi.fn() };
    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.sendFile('chat-123', '/tmp/file.txt')).resolves.toBeUndefined();
  });

  it('should provide no-op onDone', async () => {
    const schedulerCallbacks = { sendMessage: vi.fn() };
    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.onDone!('chat-123')).resolves.toBeUndefined();
  });
});
