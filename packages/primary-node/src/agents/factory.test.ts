/**
 * Tests for AgentFactory (packages/primary-node/src/agents/factory.ts)
 *
 * Issue #2991: Unit tests for AgentFactory.createAgent() and related methods.
 *
 * Test coverage:
 * - createAgent(): creates ChatAgent with correct configuration
 * - createChatAgent(): long-lived agent creation (new + legacy patterns)
 * - toChatAgentCallbacks(): SchedulerCallbacks → ChatAgentCallbacks conversion
 * - Model resolution priority: model > modelTier > default
 * - Configuration override merging
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the config passed to ChatAgent constructor for assertions
let capturedConfig: any = null;

// Mock @disclaude/core — only what AgentFactory uses
vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'default-api-key',
      model: 'default-model',
      provider: 'anthropic',
      apiBaseUrl: 'https://api.default.com',
    })),
    getModelForTier: vi.fn(() => undefined),
  },
}));

// Mock ChatAgent constructor to capture config
vi.mock('./chat-agent.js', () => ({
  ChatAgent: vi.fn().mockImplementation((config: any) => {
    capturedConfig = config;
    return {
      getChatId: () => config.chatId,
      type: 'chat',
      name: 'ChatAgent',
      dispose: vi.fn(),
    };
  }),
}));

import { AgentFactory, toChatAgentCallbacks } from './factory.js';
import { ChatAgent } from './chat-agent.js';
import { Config } from '@disclaude/core';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
});

const createMockSchedulerCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
});

// ============================================================================
// Tests
// ============================================================================

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedConfig = null;

    // Reset Config mocks to default values
    vi.mocked(Config.getAgentConfig).mockReturnValue({
      apiKey: 'default-api-key',
      model: 'default-model',
      provider: 'anthropic' as const,
      apiBaseUrl: 'https://api.default.com',
    });
    vi.mocked(Config.getModelForTier).mockReturnValue(undefined);
  });

  // ==========================================================================
  // createAgent()
  // ==========================================================================

  describe('createAgent', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledOnce();
    });

    it('should pass correct chatId to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('oc_test_chat', callbacks);

      expect(capturedConfig.chatId).toBe('oc_test_chat');
    });

    it('should pass callbacks to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      expect(capturedConfig.callbacks).toBe(callbacks);
    });

    it('should use default config when no options provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      expect(capturedConfig.apiKey).toBe('default-api-key');
      expect(capturedConfig.model).toBe('default-model');
      expect(capturedConfig.provider).toBe('anthropic');
      expect(capturedConfig.apiBaseUrl).toBe('https://api.default.com');
    });

    it('should use default config when empty options provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, {});

      expect(capturedConfig.apiKey).toBe('default-api-key');
      expect(capturedConfig.model).toBe('default-model');
    });

    it('should override apiKey when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { apiKey: 'custom-key' });

      expect(capturedConfig.apiKey).toBe('custom-key');
    });

    it('should override model when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { model: 'claude-opus-4' });

      expect(capturedConfig.model).toBe('claude-opus-4');
    });

    it('should override provider when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { provider: 'glm' });

      expect(capturedConfig.provider).toBe('glm');
    });

    it('should override apiBaseUrl when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { apiBaseUrl: 'https://custom.api.com' });

      expect(capturedConfig.apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should override permissionMode when provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, { permissionMode: 'default' });

      expect(capturedConfig.permissionMode).toBe('default');
    });

    it('should default permissionMode to bypassPermissions', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      expect(capturedConfig.permissionMode).toBe('bypassPermissions');
    });

    it('should pass messageBuilderOptions when provided', () => {
      const callbacks = createMockCallbacks();
      const mbOptions = { platform: 'feishu' } as any;
      AgentFactory.createAgent('chat-123', callbacks, { messageBuilderOptions: mbOptions });

      expect(capturedConfig.messageBuilderOptions).toBe(mbOptions);
    });

    it('should set messageBuilderOptions to undefined when not provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      expect(capturedConfig.messageBuilderOptions).toBeUndefined();
    });
  });

  // ==========================================================================
  // Model Resolution Priority (Issue #3059)
  // ==========================================================================

  describe('model resolution priority', () => {
    it('should use explicit model override over modelTier (priority 1)', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue('tier-model');

      AgentFactory.createAgent('chat-123', callbacks, {
        model: 'explicit-model',
        modelTier: 'high',
      });

      expect(capturedConfig.model).toBe('explicit-model');
      // getModelForTier should NOT be called when explicit model is set
      expect(Config.getModelForTier).not.toHaveBeenCalled();
    });

    it('should use tier model when modelTier provided without model (priority 2)', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue('high-tier-model');

      AgentFactory.createAgent('chat-123', callbacks, { modelTier: 'high' });

      expect(capturedConfig.model).toBe('high-tier-model');
      expect(Config.getModelForTier).toHaveBeenCalledWith('high');
    });

    it('should fallback to default model when tier returns undefined (priority 3)', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue(undefined);

      AgentFactory.createAgent('chat-123', callbacks, { modelTier: 'low' });

      expect(capturedConfig.model).toBe('default-model');
      expect(Config.getModelForTier).toHaveBeenCalledWith('low');
    });

    it('should use default model when neither model nor modelTier provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks);

      expect(capturedConfig.model).toBe('default-model');
      expect(Config.getModelForTier).not.toHaveBeenCalled();
    });

    it('should support "multimodal" tier', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue('claude-sonnet-4-20250514');

      AgentFactory.createAgent('chat-123', callbacks, { modelTier: 'multimodal' });

      expect(capturedConfig.model).toBe('claude-sonnet-4-20250514');
      expect(Config.getModelForTier).toHaveBeenCalledWith('multimodal');
    });
  });

  // ==========================================================================
  // createChatAgent()
  // ==========================================================================

  describe('createChatAgent', () => {
    it('should create a pilot agent with new pattern (chatId, callbacks, options)', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', 'oc_chat_1', callbacks, { model: 'pilot-model' });

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledOnce();
      expect(capturedConfig.chatId).toBe('oc_chat_1');
      expect(capturedConfig.callbacks).toBe(callbacks);
      expect(capturedConfig.model).toBe('pilot-model');
    });

    it('should create a pilot agent with new pattern without options', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createChatAgent('pilot', 'oc_chat_2', callbacks);

      expect(capturedConfig.chatId).toBe('oc_chat_2');
      expect(capturedConfig.callbacks).toBe(callbacks);
      expect(capturedConfig.model).toBe('default-model');
    });

    it('should support legacy pattern (callbacks, options) with default chatId', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createChatAgent('pilot', callbacks, { model: 'legacy-model' });

      expect(capturedConfig.chatId).toBe('default');
      expect(capturedConfig.callbacks).toBe(callbacks);
      expect(capturedConfig.model).toBe('legacy-model');
    });

    it('should support legacy pattern without options', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createChatAgent('pilot', callbacks);

      expect(capturedConfig.chatId).toBe('default');
      expect(capturedConfig.callbacks).toBe(callbacks);
    });

    it('should throw error for unknown agent name', () => {
      expect(() => {
        AgentFactory.createChatAgent('unknown-agent', 'chat-1', createMockCallbacks());
      }).toThrow('Unknown ChatAgent: unknown-agent');
    });

    it('should apply model tier resolution for pilot agent', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue('tier-model');

      AgentFactory.createChatAgent('pilot', 'oc_chat', callbacks, { modelTier: 'high' });

      expect(capturedConfig.model).toBe('tier-model');
    });
  });

  // ==========================================================================
  // toChatAgentCallbacks()
  // ==========================================================================

  describe('toChatAgentCallbacks', () => {
    it('should preserve sendMessage from scheduler callbacks', () => {
      const schedulerCallbacks = createMockSchedulerCallbacks();
      const result = toChatAgentCallbacks(schedulerCallbacks);

      expect(result.sendMessage).toBe(schedulerCallbacks.sendMessage);
    });

    it('should provide no-op sendCard', async () => {
      const schedulerCallbacks = createMockSchedulerCallbacks();
      const result = toChatAgentCallbacks(schedulerCallbacks);

      // Should not throw
      await expect(result.sendCard('chat-1', {} as any)).resolves.toBeUndefined();
    });

    it('should provide no-op sendFile', async () => {
      const schedulerCallbacks = createMockSchedulerCallbacks();
      const result = toChatAgentCallbacks(schedulerCallbacks);

      await expect(result.sendFile('chat-1', '/path/to/file')).resolves.toBeUndefined();
    });

    it('should provide no-op onDone', async () => {
      const schedulerCallbacks = createMockSchedulerCallbacks();
      const result = toChatAgentCallbacks(schedulerCallbacks);

      await expect(result.onDone!('chat-1')).resolves.toBeUndefined();
    });

    it('should work with AgentFactory.createAgent', () => {
      const schedulerCallbacks = createMockSchedulerCallbacks();
      const callbacks = toChatAgentCallbacks(schedulerCallbacks);
      const agent = AgentFactory.createAgent('chat-456', callbacks);

      expect(agent).toBeDefined();
      expect(capturedConfig.callbacks.sendMessage).toBe(schedulerCallbacks.sendMessage);
    });
  });

  // ==========================================================================
  // Config.getAgentConfig() integration
  // ==========================================================================

  describe('Config.getAgentConfig integration', () => {
    it('should call Config.getAgentConfig() once per agent creation', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(Config.getAgentConfig).toHaveBeenCalledOnce();
    });

    it('should call Config.getAgentConfig() for each createChatAgent call', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createChatAgent('pilot', 'chat-1', callbacks);

      expect(Config.getAgentConfig).toHaveBeenCalledOnce();
    });

    it('should merge partial overrides with defaults', () => {
      const callbacks = createMockCallbacks();
      // Only override model, keep other defaults
      AgentFactory.createAgent('chat-123', callbacks, { model: 'custom-model' });

      expect(capturedConfig.model).toBe('custom-model');
      expect(capturedConfig.apiKey).toBe('default-api-key');
      expect(capturedConfig.provider).toBe('anthropic');
      expect(capturedConfig.apiBaseUrl).toBe('https://api.default.com');
    });

    it('should handle all overrides simultaneously', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-123', callbacks, {
        apiKey: 'key-override',
        model: 'model-override',
        provider: 'glm',
        apiBaseUrl: 'https://override.api.com',
        permissionMode: 'default',
      });

      expect(capturedConfig.apiKey).toBe('key-override');
      expect(capturedConfig.model).toBe('model-override');
      expect(capturedConfig.provider).toBe('glm');
      expect(capturedConfig.apiBaseUrl).toBe('https://override.api.com');
      expect(capturedConfig.permissionMode).toBe('default');
    });
  });
});
