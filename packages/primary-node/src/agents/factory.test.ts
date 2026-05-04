/**
 * Tests for AgentFactory (packages/primary-node/src/agents/factory.ts)
 *
 * Issue #2991: Unit tests for AgentFactory methods:
 * - createAgent(): creates a short-lived ChatAgent with correct config
 * - createChatAgent(): creates a long-lived ChatAgent (new + legacy patterns)
 * - getBaseConfig(): option merging and model resolution priority
 * - toChatAgentCallbacks(): SchedulerCallbacks → ChatAgentCallbacks conversion
 *
 * Note: createScheduleAgent/createTaskAgent were removed in PR #2959 (Issue #2941).
 * All agent creation now goes through createAgent() or createChatAgent().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track ChatAgent constructor calls to verify config
const constructorCalls: Array<{ config: any }> = [];
vi.mock('./chat-agent.js', () => ({
  ChatAgent: vi.fn().mockImplementation(function(this: any, config: any) {
    constructorCalls.push({ config });
    this.getChatId = vi.fn(() => config.chatId);
    this.type = 'chat';
    this.name = 'ChatAgent';
    this.dispose = vi.fn();
  }),
}));

// Mock @disclaude/core to provide deterministic Config values
const mockGetAgentConfig = vi.fn(() => ({
  apiKey: 'default-api-key',
  model: 'default-model',
  apiBaseUrl: 'https://default.api.com',
  provider: 'anthropic' as const,
}));

const mockGetModelForTier = vi.fn();

vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: () => mockGetAgentConfig(),
    getModelForTier: (tier: string) => mockGetModelForTier(tier),
  },
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
  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
    mockGetAgentConfig.mockReturnValue({
      apiKey: 'default-api-key',
      model: 'default-model',
      apiBaseUrl: 'https://default.api.com',
      provider: 'anthropic' as const,
    });
    mockGetModelForTier.mockReturnValue(undefined);
  });

  // ==========================================================================
  // createAgent() — short-lived ChatAgent creation
  // ==========================================================================

  describe('createAgent', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledTimes(1);
    });

    it('should pass correct chatId to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-456', callbacks);

      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0].config.chatId).toBe('chat-456');
    });

    it('should pass callbacks to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      expect(constructorCalls[0].config.callbacks).toBe(callbacks);
    });

    it('should use default config when no options provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      const [{ config }] = constructorCalls;
      expect(config.apiKey).toBe('default-api-key');
      expect(config.model).toBe('default-model');
      expect(config.provider).toBe('anthropic');
      expect(config.apiBaseUrl).toBe('https://default.api.com');
      expect(config.permissionMode).toBe('bypassPermissions');
    });

    it('should allow overriding apiKey', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { apiKey: 'custom-key' });

      expect(constructorCalls[0].config.apiKey).toBe('custom-key');
    });

    it('should allow overriding model', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { model: 'custom-model' });

      expect(constructorCalls[0].config.model).toBe('custom-model');
    });

    it('should allow overriding provider', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { provider: 'glm' });

      expect(constructorCalls[0].config.provider).toBe('glm');
    });

    it('should allow overriding apiBaseUrl', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { apiBaseUrl: 'https://custom.api.com' });

      expect(constructorCalls[0].config.apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should pass messageBuilderOptions when provided', () => {
      const callbacks = createMockCallbacks();
      const options = { messageBuilderOptions: { someOption: true } as any };
      AgentFactory.createAgent('chat-123', callbacks, options);

      expect(constructorCalls[0].config.messageBuilderOptions).toEqual({ someOption: true });
    });

    it('should not include messageBuilderOptions when not provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      expect(constructorCalls[0].config.messageBuilderOptions).toBeUndefined();
    });
  });

  // ==========================================================================
  // createChatAgent() — long-lived ChatAgent creation
  // ==========================================================================

  describe('createChatAgent', () => {
    describe('new pattern: (name, chatId, callbacks, options?)', () => {
      it('should create a ChatAgent when name is "pilot"', () => {
        const callbacks = createMockCallbacks();
        const agent = AgentFactory.createChatAgent('pilot', 'chat-789', callbacks);

        expect(agent).toBeDefined();
        expect(ChatAgent).toHaveBeenCalledTimes(1);
      });

      it('should pass chatId as string', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', 'chat-789', callbacks);

        expect(constructorCalls[0].config.chatId).toBe('chat-789');
      });

      it('should pass callbacks correctly', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', 'chat-789', callbacks);

        expect(constructorCalls[0].config.callbacks).toBe(callbacks);
      });

      it('should accept options as third argument', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', 'chat-789', callbacks, {
          model: 'custom-model',
        });

        expect(constructorCalls[0].config.model).toBe('custom-model');
      });

      it('should use default config when no options provided', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', 'chat-789', callbacks);

        const [{ config }] = constructorCalls;
        expect(config.apiKey).toBe('default-api-key');
        expect(config.model).toBe('default-model');
      });
    });

    describe('legacy pattern: (name, callbacks, options?)', () => {
      it('should create a ChatAgent with legacy callback-first pattern', () => {
        const callbacks = createMockCallbacks();
        const agent = AgentFactory.createChatAgent('pilot', callbacks);

        expect(agent).toBeDefined();
        expect(ChatAgent).toHaveBeenCalledTimes(1);
      });

      it('should use "default" as chatId when callbacks are passed as second arg', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', callbacks);

        expect(constructorCalls[0].config.chatId).toBe('default');
      });

      it('should accept options as third argument in legacy pattern', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', callbacks, {
          apiKey: 'legacy-key',
        });

        expect(constructorCalls[0].config.apiKey).toBe('legacy-key');
      });
    });

    it('should throw for unknown agent name', () => {
      const callbacks = createMockCallbacks();
      expect(() => AgentFactory.createChatAgent('unknown', callbacks)).toThrow(
        'Unknown ChatAgent: unknown'
      );
    });
  });

  // ==========================================================================
  // Model resolution priority (Issue #3059)
  // ==========================================================================

  describe('model resolution priority', () => {
    it('should use explicit model over modelTier and default', () => {
      const callbacks = createMockCallbacks();
      mockGetModelForTier.mockReturnValue('tier-model');

      AgentFactory.createAgent('chat-123', callbacks, {
        model: 'explicit-model',
        modelTier: 'high',
      });

      expect(constructorCalls[0].config.model).toBe('explicit-model');
      // getModelForTier should NOT be called when model is explicitly set (else-if branch)
      expect(mockGetModelForTier).not.toHaveBeenCalled();
    });

    it('should use modelTier when no explicit model', () => {
      const callbacks = createMockCallbacks();
      mockGetModelForTier.mockReturnValue('tier-model');

      AgentFactory.createAgent('chat-123', callbacks, { modelTier: 'high' });

      expect(constructorCalls[0].config.model).toBe('tier-model');
    });

    it('should fall back to default model when modelTier returns undefined', () => {
      const callbacks = createMockCallbacks();
      mockGetModelForTier.mockReturnValue(undefined);

      AgentFactory.createAgent('chat-123', callbacks, { modelTier: 'low' });

      expect(constructorCalls[0].config.model).toBe('default-model');
    });

    it('should use default model when no model or modelTier specified', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-123', callbacks);

      expect(constructorCalls[0].config.model).toBe('default-model');
      expect(mockGetModelForTier).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // toChatAgentCallbacks() helper
  // ==========================================================================

  describe('toChatAgentCallbacks', () => {
    it('should preserve sendMessage callback', () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const callbacks = toChatAgentCallbacks({ sendMessage });

      expect(callbacks.sendMessage).toBe(sendMessage);
    });

    it('should provide no-op sendCard', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const callbacks = toChatAgentCallbacks({ sendMessage });

      // Should not throw
      await expect(callbacks.sendCard('chat-123', {} as any)).resolves.toBeUndefined();
    });

    it('should provide no-op sendFile', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const callbacks = toChatAgentCallbacks({ sendMessage });

      // Should not throw
      await expect(callbacks.sendFile('chat-123', '/path/to/file')).resolves.toBeUndefined();
    });

    it('should provide no-op onDone', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const callbacks = toChatAgentCallbacks({ sendMessage });

      // Should not throw
      await expect(callbacks.onDone!('chat-123')).resolves.toBeUndefined();
    });
  });
});
