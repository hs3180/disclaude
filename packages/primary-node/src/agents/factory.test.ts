/**
 * Tests for AgentFactory - unified factory for creating ChatAgent instances.
 *
 * Issue #2991: Direct unit tests for AgentFactory.createAgent() method.
 *
 * Covers:
 * - createAgent() correctly creates a ChatAgent instance
 * - Configuration options are properly merged with defaults
 * - toChatAgentCallbacks() converts SchedulerCallbacks correctly
 * - createChatAgent() with both new and legacy patterns
 * - createChatAgent() error handling for unknown names
 *
 * Related: #2941, #2990
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentFactory, toChatAgentCallbacks, type AgentCreateOptions } from './factory.js';

// ============================================================================
// Mocks
// ============================================================================

// Track ChatAgent constructor calls to verify config
let lastChatAgentConfig: any;

vi.mock('./chat-agent.js', () => {
  return {
    ChatAgent: vi.fn().mockImplementation((config: any) => {
      lastChatAgentConfig = config;
      return {
        type: 'chat',
        name: `mock-agent-${config.chatId}`,
        config,
        dispose: vi.fn(),
        processMessage: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        handleInput: vi.fn(),
        reset: vi.fn(),
        stop: vi.fn().mockReturnValue(false),
        taskComplete: Promise.resolve(),
      };
    }),
  };
});

vi.mock('@disclaude/core', () => {
  return {
    Config: {
      getAgentConfig: vi.fn(() => ({
        apiKey: 'default-test-key',
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic' as const,
        apiBaseUrl: undefined,
      })),
    },
  };
});

// Import after mocks are set up
import { ChatAgent } from './chat-agent.js';
import { Config } from '@disclaude/core';

// ============================================================================
// Helpers
// ============================================================================

function createMockCallbacks() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastChatAgentConfig = undefined;
  });

  // ==========================================================================
  // createAgent() — short-lived ChatAgent creation
  // ==========================================================================

  describe('createAgent()', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledTimes(1);
    });

    it('should pass correct chatId to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-456', callbacks);

      expect(lastChatAgentConfig.chatId).toBe('chat-456');
    });

    it('should pass callbacks to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(lastChatAgentConfig.callbacks).toBe(callbacks);
    });

    it('should use default config when no options provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(Config.getAgentConfig).toHaveBeenCalledTimes(1);
      expect(lastChatAgentConfig.apiKey).toBe('default-test-key');
      expect(lastChatAgentConfig.model).toBe('claude-sonnet-4-20250514');
      expect(lastChatAgentConfig.provider).toBe('anthropic');
      expect(lastChatAgentConfig.apiBaseUrl).toBeUndefined();
    });

    it('should use default config when empty options provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, {});

      expect(lastChatAgentConfig.apiKey).toBe('default-test-key');
      expect(lastChatAgentConfig.model).toBe('claude-sonnet-4-20250514');
    });

    it('should default permissionMode to bypassPermissions', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(lastChatAgentConfig.permissionMode).toBe('bypassPermissions');
    });

    it('should override apiKey when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { apiKey: 'custom-key' });

      expect(lastChatAgentConfig.apiKey).toBe('custom-key');
    });

    it('should override model when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { model: 'glm-4-plus' });

      expect(lastChatAgentConfig.model).toBe('glm-4-plus');
    });

    it('should override provider when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { provider: 'glm' });

      expect(lastChatAgentConfig.provider).toBe('glm');
    });

    it('should override apiBaseUrl when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { apiBaseUrl: 'https://custom.api.com' });

      expect(lastChatAgentConfig.apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should override permissionMode when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { permissionMode: 'default' });

      expect(lastChatAgentConfig.permissionMode).toBe('default');
    });

    it('should pass messageBuilderOptions to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      const options = { messageBuilderOptions: { buildHeader: () => 'Test header' } };
      AgentFactory.createAgent('chat-1', callbacks, options);

      expect(lastChatAgentConfig.messageBuilderOptions).toEqual({ buildHeader: expect.any(Function) });
    });

    it('should set messageBuilderOptions to undefined when not provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(lastChatAgentConfig.messageBuilderOptions).toBeUndefined();
    });

    it('should apply multiple overrides simultaneously', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = {
        apiKey: 'multi-key',
        model: 'multi-model',
        provider: 'glm',
        apiBaseUrl: 'https://multi.api.com',
        permissionMode: 'default',
      };
      AgentFactory.createAgent('chat-1', callbacks, options);

      expect(lastChatAgentConfig.apiKey).toBe('multi-key');
      expect(lastChatAgentConfig.model).toBe('multi-model');
      expect(lastChatAgentConfig.provider).toBe('glm');
      expect(lastChatAgentConfig.apiBaseUrl).toBe('https://multi.api.com');
      expect(lastChatAgentConfig.permissionMode).toBe('default');
    });

    it('should fall back to default for non-overridden options', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { model: 'custom-model' });

      expect(lastChatAgentConfig.model).toBe('custom-model');
      expect(lastChatAgentConfig.apiKey).toBe('default-test-key');
      expect(lastChatAgentConfig.provider).toBe('anthropic');
    });

    it('should create distinct ChatAgent instances for each call', () => {
      const callbacks = createMockCallbacks();
      const agent1 = AgentFactory.createAgent('chat-1', callbacks);
      const agent2 = AgentFactory.createAgent('chat-2', callbacks);

      expect(agent1).not.toBe(agent2);
      expect(ChatAgent).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // createChatAgent() — long-lived ChatAgent creation (stored in AgentPool)
  // ==========================================================================

  describe('createChatAgent()', () => {
    describe('new pattern: createChatAgent("pilot", chatId, callbacks, options)', () => {
      it('should create a ChatAgent instance with chatId string', () => {
        const callbacks = createMockCallbacks();
        const agent = AgentFactory.createChatAgent('pilot', 'chat-789', callbacks);

        expect(agent).toBeDefined();
        expect(ChatAgent).toHaveBeenCalledTimes(1);
        expect(lastChatAgentConfig.chatId).toBe('chat-789');
        expect(lastChatAgentConfig.callbacks).toBe(callbacks);
      });

      it('should pass options when provided', () => {
        const callbacks = createMockCallbacks();
        const options: AgentCreateOptions = { model: 'custom-model', apiKey: 'custom-key' };
        AgentFactory.createChatAgent('pilot', 'chat-1', callbacks, options);

        expect(lastChatAgentConfig.model).toBe('custom-model');
        expect(lastChatAgentConfig.apiKey).toBe('custom-key');
      });

      it('should use default config when options omitted', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', 'chat-1', callbacks);

        expect(lastChatAgentConfig.apiKey).toBe('default-test-key');
        expect(lastChatAgentConfig.model).toBe('claude-sonnet-4-20250514');
      });
    });

    describe('legacy pattern: createChatAgent("pilot", callbacks, options)', () => {
      it('should create ChatAgent with "default" chatId', () => {
        const callbacks = createMockCallbacks();
        const agent = AgentFactory.createChatAgent('pilot', callbacks);

        expect(agent).toBeDefined();
        expect(lastChatAgentConfig.chatId).toBe('default');
        expect(lastChatAgentConfig.callbacks).toBe(callbacks);
      });

      it('should pass options when provided in legacy mode', () => {
        const callbacks = createMockCallbacks();
        const options: AgentCreateOptions = { model: 'legacy-model' };
        AgentFactory.createChatAgent('pilot', callbacks, options);

        expect(lastChatAgentConfig.model).toBe('legacy-model');
      });
    });

    describe('error handling', () => {
      it('should throw for unknown agent name', () => {
        const callbacks = createMockCallbacks();
        expect(() => AgentFactory.createChatAgent('unknown', callbacks))
          .toThrow('Unknown ChatAgent: unknown');
      });

      it('should throw for arbitrary agent name', () => {
        const callbacks = createMockCallbacks();
        expect(() => AgentFactory.createChatAgent('worker', 'chat-1', callbacks))
          .toThrow('Unknown ChatAgent: worker');
      });
    });
  });

  // ==========================================================================
  // getBaseConfig() — private static method tested via public API
  // ==========================================================================

  describe('config merging (via getBaseConfig)', () => {
    it('should call Config.getAgentConfig() for defaults', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(Config.getAgentConfig).toHaveBeenCalledTimes(1);
    });

    it('should use default apiKey when not overridden', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { model: 'x' });

      expect(lastChatAgentConfig.apiKey).toBe('default-test-key');
    });

    it('should use default model when not overridden', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { apiKey: 'x' });

      expect(lastChatAgentConfig.model).toBe('claude-sonnet-4-20250514');
    });

    it('should use default provider when not overridden', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { model: 'x' });

      expect(lastChatAgentConfig.provider).toBe('anthropic');
    });

    it('should have undefined apiBaseUrl when not overridden and default is undefined', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(lastChatAgentConfig.apiBaseUrl).toBeUndefined();
    });
  });
});

// ============================================================================
// toChatAgentCallbacks()
// ============================================================================

describe('toChatAgentCallbacks()', () => {
  it('should preserve sendMessage from SchedulerCallbacks', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = toChatAgentCallbacks({ sendMessage });

    expect(result.sendMessage).toBe(sendMessage);
  });

  it('should provide no-op sendCard', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = toChatAgentCallbacks({ sendMessage });

    // Should not throw
    await expect(result.sendCard('chat-1', {} as any)).resolves.toBeUndefined();
  });

  it('should provide no-op sendFile', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = toChatAgentCallbacks({ sendMessage });

    // Should not throw
    await expect(result.sendFile('chat-1', '/tmp/test.txt')).resolves.toBeUndefined();
  });

  it('should provide no-op onDone', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = toChatAgentCallbacks({ sendMessage });

    // Should not throw
    await expect(result.onDone!('chat-1')).resolves.toBeUndefined();
  });

  it('should return an object with all ChatAgentCallbacks methods', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = toChatAgentCallbacks({ sendMessage });

    expect(result).toHaveProperty('sendMessage');
    expect(result).toHaveProperty('sendCard');
    expect(result).toHaveProperty('sendFile');
    expect(result).toHaveProperty('onDone');
  });

  it('should not affect the original sendMessage behavior', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = toChatAgentCallbacks({ sendMessage });

    await result.sendMessage('chat-1', 'hello');

    expect(sendMessage).toHaveBeenCalledWith('chat-1', 'hello');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('each call should return a new object', () => {
    const sendMessage = vi.fn();
    const result1 = toChatAgentCallbacks({ sendMessage });
    const result2 = toChatAgentCallbacks({ sendMessage });

    expect(result1).not.toBe(result2);
  });
});
