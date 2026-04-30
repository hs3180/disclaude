/**
 * Tests for AgentFactory (packages/primary-node/src/agents/factory.ts)
 *
 * Verifies the AgentFactory class and related helpers:
 * - createAgent() creates ChatAgent with correct configuration
 * - createChatAgent() creates long-lived ChatAgent by name
 * - Deprecated wrappers (createScheduleAgent, createTaskAgent) delegate to createAgent()
 * - toChatAgentCallbacks() converts SchedulerCallbacks to ChatAgentCallbacks
 * - Configuration override behavior
 *
 * Issue #2991: Add unit tests for AgentFactory.createAgent() method.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture constructor calls
let lastChatAgentConfig: Record<string, unknown> | null = null;

// Mock @disclaude/core dependencies
vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'default-test-key',
      model: 'default-test-model',
      provider: 'anthropic' as const,
      apiBaseUrl: 'https://default-api.example.com',
    })),
  },
}));

// Mock ChatAgent to capture constructor arguments
vi.mock('./chat-agent.js', () => ({
  ChatAgent: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    lastChatAgentConfig = config;
    return {
      type: 'chat',
      name: 'ChatAgent',
      getChatId: () => config.chatId,
      dispose: vi.fn(),
    };
  }),
}));

import { AgentFactory, toChatAgentCallbacks } from './factory.js';
import { ChatAgent } from './chat-agent.js';
import type { ChatAgentCallbacks } from './types.js';
import { Config } from '@disclaude/core';

/**
 * Create a mock ChatAgentCallbacks object with all required methods.
 */
function createMockCallbacks(): ChatAgentCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AgentFactory', () => {
  let callbacks: ChatAgentCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    lastChatAgentConfig = null;
    callbacks = createMockCallbacks();
  });

  // ===========================================================================
  // createAgent()
  // ===========================================================================

  describe('createAgent', () => {
    it('should create a ChatAgent instance', () => {
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(ChatAgent).toHaveBeenCalledTimes(1);
      expect(agent).toBeDefined();
    });

    it('should pass chatId and callbacks to ChatAgent config', () => {
      AgentFactory.createAgent('chat-456', callbacks);

      expect(lastChatAgentConfig).not.toBeNull();
      expect(lastChatAgentConfig!.chatId).toBe('chat-456');
      expect(lastChatAgentConfig!.callbacks).toBe(callbacks);
    });

    it('should use default config when no options provided', () => {
      AgentFactory.createAgent('chat-1', callbacks);

      expect(lastChatAgentConfig).toMatchObject({
        apiKey: 'default-test-key',
        model: 'default-test-model',
        provider: 'anthropic',
        apiBaseUrl: 'https://default-api.example.com',
        permissionMode: 'bypassPermissions',
      });
      expect(Config.getAgentConfig).toHaveBeenCalledTimes(1);
    });

    it('should use default config when empty options provided', () => {
      AgentFactory.createAgent('chat-1', callbacks, {});

      expect(lastChatAgentConfig).toMatchObject({
        apiKey: 'default-test-key',
        model: 'default-test-model',
      });
    });

    it('should override apiKey when provided', () => {
      AgentFactory.createAgent('chat-1', callbacks, { apiKey: 'custom-key' });

      expect(lastChatAgentConfig!.apiKey).toBe('custom-key');
    });

    it('should override model when provided', () => {
      AgentFactory.createAgent('chat-1', callbacks, { model: 'claude-sonnet-4-20250514' });

      expect(lastChatAgentConfig!.model).toBe('claude-sonnet-4-20250514');
    });

    it('should override provider when provided', () => {
      AgentFactory.createAgent('chat-1', callbacks, { provider: 'glm' });

      expect(lastChatAgentConfig!.provider).toBe('glm');
    });

    it('should override apiBaseUrl when provided', () => {
      AgentFactory.createAgent('chat-1', callbacks, { apiBaseUrl: 'https://custom.api.com' });

      expect(lastChatAgentConfig!.apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should override permissionMode when provided', () => {
      AgentFactory.createAgent('chat-1', callbacks, { permissionMode: 'default' });

      expect(lastChatAgentConfig!.permissionMode).toBe('default');
    });

    it('should default permissionMode to bypassPermissions when not provided', () => {
      AgentFactory.createAgent('chat-1', callbacks);

      expect(lastChatAgentConfig!.permissionMode).toBe('bypassPermissions');
    });

    it('should pass messageBuilderOptions when provided', () => {
      const buildHeader = (ctx: any) => `Header for ${ctx.chatId}`;
      const options = { messageBuilderOptions: { buildHeader } };
      AgentFactory.createAgent('chat-1', callbacks, options);

      expect(lastChatAgentConfig!.messageBuilderOptions).toEqual({ buildHeader });
    });

    it('should set messageBuilderOptions to undefined when not provided', () => {
      AgentFactory.createAgent('chat-1', callbacks);

      expect(lastChatAgentConfig!.messageBuilderOptions).toBeUndefined();
    });

    it('should apply all overrides simultaneously', () => {
      const buildHeader = () => 'Custom Header';
      AgentFactory.createAgent('chat-multi', callbacks, {
        apiKey: 'key-override',
        model: 'model-override',
        provider: 'glm',
        apiBaseUrl: 'https://override.api.com',
        permissionMode: 'default',
        messageBuilderOptions: { buildHeader },
      });

      expect(lastChatAgentConfig).toMatchObject({
        chatId: 'chat-multi',
        apiKey: 'key-override',
        model: 'model-override',
        provider: 'glm',
        apiBaseUrl: 'https://override.api.com',
        permissionMode: 'default',
      });
      expect(lastChatAgentConfig!.messageBuilderOptions).toEqual({ buildHeader });
    });

    it('should call Config.getAgentConfig() exactly once', () => {
      AgentFactory.createAgent('chat-1', callbacks);

      expect(Config.getAgentConfig).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // createScheduleAgent() (deprecated wrapper)
  // ===========================================================================

  describe('createScheduleAgent (deprecated)', () => {
    it('should delegate to createAgent with same arguments', () => {
      const options = { apiKey: 'schedule-key', model: 'schedule-model' };
      const agent = AgentFactory.createScheduleAgent('chat-s1', callbacks, options);

      expect(ChatAgent).toHaveBeenCalledTimes(1);
      expect(agent).toBeDefined();
      expect(lastChatAgentConfig).toMatchObject({
        chatId: 'chat-s1',
        apiKey: 'schedule-key',
        model: 'schedule-model',
      });
    });

    it('should work without options', () => {
      AgentFactory.createScheduleAgent('chat-s2', callbacks);

      expect(ChatAgent).toHaveBeenCalledTimes(1);
      expect(lastChatAgentConfig!.chatId).toBe('chat-s2');
    });
  });

  // ===========================================================================
  // createTaskAgent() (deprecated wrapper)
  // ===========================================================================

  describe('createTaskAgent (deprecated)', () => {
    it('should delegate to createAgent with same arguments', () => {
      const options = { apiKey: 'task-key', model: 'task-model' };
      const agent = AgentFactory.createTaskAgent('chat-t1', callbacks, options);

      expect(ChatAgent).toHaveBeenCalledTimes(1);
      expect(agent).toBeDefined();
      expect(lastChatAgentConfig).toMatchObject({
        chatId: 'chat-t1',
        apiKey: 'task-key',
        model: 'task-model',
      });
    });

    it('should work without options', () => {
      AgentFactory.createTaskAgent('chat-t2', callbacks);

      expect(ChatAgent).toHaveBeenCalledTimes(1);
      expect(lastChatAgentConfig!.chatId).toBe('chat-t2');
    });
  });

  // ===========================================================================
  // createChatAgent() (long-lived agent by name)
  // ===========================================================================

  describe('createChatAgent', () => {
    describe('new pattern: createChatAgent("pilot", chatId, callbacks, options)', () => {
      it('should create a ChatAgent for pilot with chatId', () => {
        const agent = AgentFactory.createChatAgent('pilot', 'chat-pilot', callbacks);

        expect(ChatAgent).toHaveBeenCalledTimes(1);
        expect(agent).toBeDefined();
        expect(lastChatAgentConfig!.chatId).toBe('chat-pilot');
        expect(lastChatAgentConfig!.callbacks).toBe(callbacks);
      });

      it('should pass options to pilot ChatAgent', () => {
        const buildHeader = () => 'Pilot Header';
        const options = {
          apiKey: 'pilot-key',
          model: 'pilot-model',
          messageBuilderOptions: { buildHeader },
        };
        AgentFactory.createChatAgent('pilot', 'chat-p1', callbacks, options);

        expect(lastChatAgentConfig).toMatchObject({
          chatId: 'chat-p1',
          apiKey: 'pilot-key',
          model: 'pilot-model',
        });
        expect(lastChatAgentConfig!.messageBuilderOptions).toEqual({ buildHeader });
      });

      it('should use default config when no options provided', () => {
        AgentFactory.createChatAgent('pilot', 'chat-p2', callbacks);

        expect(lastChatAgentConfig).toMatchObject({
          apiKey: 'default-test-key',
          model: 'default-test-model',
          permissionMode: 'bypassPermissions',
        });
      });
    });

    describe('legacy pattern: createChatAgent("pilot", callbacks, options)', () => {
      it('should create a ChatAgent with default chatId', () => {
        const agent = AgentFactory.createChatAgent('pilot', callbacks);

        expect(ChatAgent).toHaveBeenCalledTimes(1);
        expect(agent).toBeDefined();
        expect(lastChatAgentConfig!.chatId).toBe('default');
        expect(lastChatAgentConfig!.callbacks).toBe(callbacks);
      });

      it('should pass options in legacy pattern', () => {
        const options = { apiKey: 'legacy-key', model: 'legacy-model' };
        AgentFactory.createChatAgent('pilot', callbacks, options);

        expect(lastChatAgentConfig).toMatchObject({
          chatId: 'default',
          apiKey: 'legacy-key',
          model: 'legacy-model',
        });
      });

      it('should use default config when no options provided in legacy pattern', () => {
        AgentFactory.createChatAgent('pilot', callbacks);

        expect(lastChatAgentConfig).toMatchObject({
          apiKey: 'default-test-key',
          model: 'default-test-model',
          permissionMode: 'bypassPermissions',
        });
      });
    });

    describe('error handling', () => {
      it('should throw for unknown agent name', () => {
        expect(() => AgentFactory.createChatAgent('unknown-agent', callbacks)).toThrow(
          'Unknown ChatAgent: unknown-agent'
        );
      });

      it('should not create ChatAgent for unknown name', () => {
        try {
          AgentFactory.createChatAgent('unknown', callbacks);
        } catch {
          // Expected
        }

        expect(ChatAgent).not.toHaveBeenCalled();
      });
    });
  });
});

// ===========================================================================
// toChatAgentCallbacks()
// ===========================================================================

describe('toChatAgentCallbacks', () => {
  it('should convert SchedulerCallbacks to ChatAgentCallbacks', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const schedulerCallbacks = { sendMessage };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    expect(result.sendMessage).toBe(sendMessage);
    expect(typeof result.sendCard).toBe('function');
    expect(typeof result.sendFile).toBe('function');
    expect(typeof result.onDone).toBe('function');
  });

  it('should provide no-op sendCard implementation', async () => {
    const schedulerCallbacks = { sendMessage: vi.fn() };
    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.sendCard('chat-1', {} as any)).resolves.toBeUndefined();
  });

  it('should provide no-op sendFile implementation', async () => {
    const schedulerCallbacks = { sendMessage: vi.fn() };
    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.sendFile('chat-1', '/path/to/file')).resolves.toBeUndefined();
  });

  it('should provide no-op onDone implementation', async () => {
    const schedulerCallbacks = { sendMessage: vi.fn() };
    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.onDone!('chat-1')).resolves.toBeUndefined();
  });

  it('should preserve sendMessage from SchedulerCallbacks', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const schedulerCallbacks = { sendMessage };
    const result = toChatAgentCallbacks(schedulerCallbacks);

    await result.sendMessage('chat-1', 'hello');

    expect(sendMessage).toHaveBeenCalledWith('chat-1', 'hello');
  });
});
