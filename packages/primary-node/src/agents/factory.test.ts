/**
 * Tests for AgentFactory (packages/primary-node/src/agents/factory.ts)
 *
 * Issue #2991: Unit tests for AgentFactory.createAgent() method.
 *
 * Coverage areas:
 * 1. createAgent() — creates ChatAgent with correct config
 * 2. createChatAgent() — new pattern (chatId, callbacks, options) and legacy pattern
 * 3. Model resolution priority: explicit model > modelTier > default config
 * 4. toChatAgentCallbacks() — converts SchedulerCallbacks to ChatAgentCallbacks
 * 5. Error cases — unknown agent name
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock Setup
// ============================================================================
// vi.mock is hoisted to the top of the file, so we must use factory functions
// that don't reference outer-scope variables. Use vi.fn() inside the factory
// and access them via vi.mocked() after import.

vi.mock('./chat-agent.js', () => ({
  ChatAgent: vi.fn().mockImplementation(function(this: any, config: any) {
    this.config = config;
    this.getChatId = vi.fn(() => config.chatId);
    this.type = 'chat';
    this.name = 'ChatAgent';
    this.start = vi.fn().mockResolvedValue(undefined);
    this.dispose = vi.fn();
    this.processMessage = vi.fn();
    this.reset = vi.fn();
    this.stop = vi.fn(() => false);
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.hasActiveSession = vi.fn(() => false);
  }),
}));

vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'default-api-key',
      model: 'default-model',
      provider: 'anthropic',
    })),
    getModelForTier: vi.fn(() => undefined),
  },
}));

// Import after mocks are set up
import { AgentFactory, toChatAgentCallbacks } from './factory.js';
import type { ChatAgentCallbacks } from './types.js';
import { ChatAgent } from './chat-agent.js';
import { Config } from '@disclaude/core';

// ============================================================================
// Helpers to access mocked functions
// ============================================================================

const getChatAgentCalls = () => vi.mocked(ChatAgent).mock.calls;

const mockConfig = vi.mocked(Config);

// ============================================================================
// Test Helpers
// ============================================================================

const createMockCallbacks = (): ChatAgentCallbacks => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
});

// ============================================================================
// Tests
// ============================================================================

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.getAgentConfig.mockReturnValue({
      apiKey: 'default-api-key',
      model: 'default-model',
      provider: 'anthropic',
    });
    mockConfig.getModelForTier.mockReturnValue(undefined);
  });

  // ==========================================================================
  // createAgent()
  // ==========================================================================

  describe('createAgent', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('oc_test', callbacks);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledTimes(1);
    });

    it('should pass correct chatId to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_chat_123', callbacks);

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.chatId).toBe('oc_chat_123');
    });

    it('should pass callbacks to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks);

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.callbacks).toBe(callbacks);
    });

    it('should use default config when no options provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks);

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.apiKey).toBe('default-api-key');
      expect(config.model).toBe('default-model');
      expect(config.provider).toBe('anthropic');
    });

    it('should use default config when empty options provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, {});

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.apiKey).toBe('default-api-key');
      expect(config.model).toBe('default-model');
    });

    it('should override apiKey when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, { apiKey: 'custom-key' });

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.apiKey).toBe('custom-key');
    });

    it('should override provider when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, { provider: 'glm' });

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.provider).toBe('glm');
    });

    it('should override apiBaseUrl when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, { apiBaseUrl: 'https://custom.api.com' });

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should override permissionMode when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, { permissionMode: 'default' });

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.permissionMode).toBe('default');
    });

    it('should default permissionMode to bypassPermissions', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks);

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.permissionMode).toBe('bypassPermissions');
    });

    it('should pass messageBuilderOptions to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      const mbOptions = { buildHeader: () => 'Test header' };
      AgentFactory.createAgent('oc_test', callbacks, { messageBuilderOptions: mbOptions });

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.messageBuilderOptions).toBe(mbOptions);
    });
  });

  // ==========================================================================
  // Model Resolution Priority (Issue #3059)
  // ==========================================================================

  describe('model resolution priority', () => {
    it('should use explicit model when provided (highest priority)', () => {
      mockConfig.getModelForTier.mockReturnValue('tier-model');
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, {
        model: 'explicit-model',
        modelTier: 'high',
      });

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.model).toBe('explicit-model');
    });

    it('should use tier model when no explicit model but modelTier is set', () => {
      mockConfig.getModelForTier.mockReturnValue('claude-3-opus');
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, { modelTier: 'high' });

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.model).toBe('claude-3-opus');
      expect(mockConfig.getModelForTier).toHaveBeenCalledWith('high');
    });

    it('should fall back to default model when tier model returns undefined', () => {
      mockConfig.getModelForTier.mockReturnValue(undefined);
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, { modelTier: 'multimodal' });

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.model).toBe('default-model');
    });

    it('should use default model when neither model nor modelTier is provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks);

      const config = getChatAgentCalls()[0][0] as any;
      expect(config.model).toBe('default-model');
      expect(mockConfig.getModelForTier).not.toHaveBeenCalled();
    });

    it('should pass low tier to getModelForTier', () => {
      mockConfig.getModelForTier.mockReturnValue('low-tier-model');
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, { modelTier: 'low' });

      expect(mockConfig.getModelForTier).toHaveBeenCalledWith('low');
      const config = getChatAgentCalls()[0][0] as any;
      expect(config.model).toBe('low-tier-model');
    });

    it('should pass multimodal tier to getModelForTier', () => {
      mockConfig.getModelForTier.mockReturnValue('multimodal-model');
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test', callbacks, { modelTier: 'multimodal' });

      expect(mockConfig.getModelForTier).toHaveBeenCalledWith('multimodal');
      const config = getChatAgentCalls()[0][0] as any;
      expect(config.model).toBe('multimodal-model');
    });
  });

  // ==========================================================================
  // createChatAgent()
  // ==========================================================================

  describe('createChatAgent', () => {
    describe('new pattern: createChatAgent(name, chatId, callbacks, options)', () => {
      it('should create ChatAgent with chatId as first arg after name', () => {
        const callbacks = createMockCallbacks();
        const agent = AgentFactory.createChatAgent('pilot', 'oc_chat_456', callbacks);

        expect(agent).toBeDefined();
        expect(ChatAgent).toHaveBeenCalledTimes(1);
        const config = getChatAgentCalls()[0][0] as any;
        expect(config.chatId).toBe('oc_chat_456');
        expect(config.callbacks).toBe(callbacks);
      });

      it('should pass options when provided', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', 'oc_chat', callbacks, {
          model: 'custom-model',
          apiKey: 'custom-key',
        });

        const config = getChatAgentCalls()[0][0] as any;
        expect(config.model).toBe('custom-model');
        expect(config.apiKey).toBe('custom-key');
      });

      it('should apply model resolution priority correctly', () => {
        mockConfig.getModelForTier.mockReturnValue('tier-model');
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', 'oc_chat', callbacks, {
          modelTier: 'high',
        });

        const config = getChatAgentCalls()[0][0] as any;
        expect(config.model).toBe('tier-model');
      });
    });

    describe('legacy pattern: createChatAgent(name, callbacks, options)', () => {
      it('should create ChatAgent with default chatId when callbacks come first', () => {
        const callbacks = createMockCallbacks();
        const agent = AgentFactory.createChatAgent('pilot', callbacks);

        expect(agent).toBeDefined();
        expect(ChatAgent).toHaveBeenCalledTimes(1);
        const config = getChatAgentCalls()[0][0] as any;
        expect(config.chatId).toBe('default');
        expect(config.callbacks).toBe(callbacks);
      });

      it('should pass options in legacy pattern', () => {
        const callbacks = createMockCallbacks();
        AgentFactory.createChatAgent('pilot', callbacks, { model: 'legacy-model' });

        const config = getChatAgentCalls()[0][0] as any;
        expect(config.model).toBe('legacy-model');
      });
    });

    it('should throw for unknown agent name', () => {
      const callbacks = createMockCallbacks();
      expect(() => AgentFactory.createChatAgent('unknown', 'oc_chat', callbacks))
        .toThrow('Unknown ChatAgent: unknown');
    });

    it('should NOT throw for pilot agent name', () => {
      const callbacks = createMockCallbacks();
      expect(() => AgentFactory.createChatAgent('pilot', 'oc_chat', callbacks))
        .not.toThrow();
    });
  });

  // ==========================================================================
  // toChatAgentCallbacks()
  // ==========================================================================

  describe('toChatAgentCallbacks', () => {
    it('should preserve sendMessage from scheduler callbacks', () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const schedulerCallbacks = { sendMessage };
      const result = toChatAgentCallbacks(schedulerCallbacks);

      expect(result.sendMessage).toBe(sendMessage);
    });

    it('should provide no-op sendCard', async () => {
      const schedulerCallbacks = { sendMessage: vi.fn() };
      const result = toChatAgentCallbacks(schedulerCallbacks);

      // Should not throw
      await expect(result.sendCard('oc_chat', {} as any)).resolves.toBeUndefined();
    });

    it('should provide no-op sendFile', async () => {
      const schedulerCallbacks = { sendMessage: vi.fn() };
      const result = toChatAgentCallbacks(schedulerCallbacks);

      await expect(result.sendFile('oc_chat', '/tmp/file.txt')).resolves.toBeUndefined();
    });

    it('should provide no-op onDone', async () => {
      const schedulerCallbacks = { sendMessage: vi.fn() };
      const result = toChatAgentCallbacks(schedulerCallbacks);

      await expect(result.onDone!('oc_chat')).resolves.toBeUndefined();
    });

    it('should return an object with all 4 callback properties', () => {
      const schedulerCallbacks = { sendMessage: vi.fn() };
      const result = toChatAgentCallbacks(schedulerCallbacks);

      expect(result).toHaveProperty('sendMessage');
      expect(result).toHaveProperty('sendCard');
      expect(result).toHaveProperty('sendFile');
      expect(result).toHaveProperty('onDone');
    });
  });

  // ==========================================================================
  // Integration-style: createAgent with toChatAgentCallbacks
  // ==========================================================================

  describe('createAgent with toChatAgentCallbacks', () => {
    it('should work with scheduler callbacks converted via toChatAgentCallbacks', () => {
      const schedulerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      const chatCallbacks = toChatAgentCallbacks(schedulerCallbacks);
      const agent = AgentFactory.createAgent('oc_sched', chatCallbacks);

      expect(agent).toBeDefined();
      const config = getChatAgentCalls()[0][0] as any;
      expect(config.chatId).toBe('oc_sched');
      expect(config.callbacks).toBe(chatCallbacks);
    });
  });
});
