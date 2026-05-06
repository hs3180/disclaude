/**
 * Tests for AgentFactory (packages/primary-node/src/agents/factory.ts)
 *
 * Issue #2991: Add unit tests for AgentFactory.createAgent() method.
 *
 * Tests cover:
 * 1. createAgent() correctly creates a ChatAgent instance with merged config
 * 2. createChatAgent() with new pattern (chatId, callbacks, options)
 * 3. createChatAgent() with legacy pattern (callbacks, options)
 * 4. createChatAgent() rejects unknown agent names
 * 5. toChatAgentCallbacks() correctly converts SchedulerCallbacks
 * 6. Model resolution priority (explicit model > tier > default)
 * 7. Config override merging (apiKey, provider, apiBaseUrl, permissionMode)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track ChatAgent constructor calls for assertions
const chatAgentConstructorCalls: any[] = [];

// Mock @disclaude/core — Config is the main dependency
vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'default-api-key',
      model: 'default-model',
      provider: 'anthropic',
      apiBaseUrl: 'https://default.api.com',
    })),
    getModelForTier: vi.fn(() => undefined),
  },
}));

// Mock ChatAgent constructor — capture config for assertions
vi.mock('./chat-agent.js', () => ({
  ChatAgent: vi.fn().mockImplementation(function(this: any, config: any) {
    chatAgentConstructorCalls.push(config);
    this.config = config;
    this.dispose = vi.fn();
  }),
}));

import { Config } from '@disclaude/core';
import { AgentFactory, toChatAgentCallbacks, type AgentCreateOptions } from './factory.js';
import { ChatAgent } from './chat-agent.js';

/** Get the last ChatAgent config captured by the mock constructor */
const getLastConfig = (): any => {
  const [config] = chatAgentConstructorCalls.slice(-1);
  return config;
};

// Helper to create mock ChatAgentCallbacks
const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
});

// Helper to create mock SchedulerCallbacks
const createMockSchedulerCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
});

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatAgentConstructorCalls.length = 0;
  });

  // ==========================================================================
  // createAgent()
  // ==========================================================================

  describe('createAgent()', () => {
    it('should create a ChatAgent instance with default config', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledOnce();

      const config = getLastConfig();
      expect(config.chatId).toBe('chat-123');
      expect(config.callbacks).toBe(callbacks);
      expect(config.apiKey).toBe('default-api-key');
      expect(config.model).toBe('default-model');
      expect(config.provider).toBe('anthropic');
      expect(config.apiBaseUrl).toBe('https://default.api.com');
      expect(config.permissionMode).toBe('bypassPermissions');
    });

    it('should merge options with default config', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = {
        apiKey: 'custom-key',
        provider: 'glm',
        apiBaseUrl: 'https://custom.api.com',
        permissionMode: 'default',
      };

      AgentFactory.createAgent('chat-456', callbacks, options);

      const config = getLastConfig();
      expect(config.apiKey).toBe('custom-key');
      expect(config.provider).toBe('glm');
      expect(config.apiBaseUrl).toBe('https://custom.api.com');
      expect(config.permissionMode).toBe('default');
      // model should fall back to default when not overridden
      expect(config.model).toBe('default-model');
    });

    it('should use explicit model over tier and default', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue('tier-model');

      AgentFactory.createAgent('chat-789', callbacks, {
        model: 'explicit-model',
        modelTier: 'high',
      });

      const config = getLastConfig();
      expect(config.model).toBe('explicit-model');
      // getModelForTier should NOT be called when explicit model is given
      expect(Config.getModelForTier).not.toHaveBeenCalled();
    });

    it('should use tier model when no explicit model is given', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue('tier-model');

      AgentFactory.createAgent('chat-tier', callbacks, {
        modelTier: 'high',
      });

      const config = getLastConfig();
      expect(config.model).toBe('tier-model');
      expect(Config.getModelForTier).toHaveBeenCalledWith('high');
    });

    it('should fall back to default model when tier returns undefined', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue(undefined);

      AgentFactory.createAgent('chat-fallback', callbacks, {
        modelTier: 'low',
      });

      const config = getLastConfig();
      expect(config.model).toBe('default-model');
      expect(Config.getModelForTier).toHaveBeenCalledWith('low');
    });

    it('should pass messageBuilderOptions to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      const messageBuilderOptions = { channel: 'feishu' } as any;

      AgentFactory.createAgent('chat-msg', callbacks, { messageBuilderOptions });

      const config = getLastConfig();
      expect(config.messageBuilderOptions).toBe(messageBuilderOptions);
    });

    it('should not include messageBuilderOptions when not provided', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-no-msg', callbacks);

      const config = getLastConfig();
      expect(config.messageBuilderOptions).toBeUndefined();
    });
  });

  // ==========================================================================
  // createChatAgent()
  // ==========================================================================

  describe('createChatAgent()', () => {
    it('should create a ChatAgent with new pattern: (name, chatId, callbacks, options)', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = { apiKey: 'pilot-key' };

      const agent = AgentFactory.createChatAgent('pilot', 'chat-pilot', callbacks, options);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledOnce();

      const config = getLastConfig();
      expect(config.chatId).toBe('chat-pilot');
      expect(config.callbacks).toBe(callbacks);
      expect(config.apiKey).toBe('pilot-key');
    });

    it('should create a ChatAgent with legacy pattern: (name, callbacks, options)', () => {
      const callbacks = createMockCallbacks();
      const options: AgentCreateOptions = { apiKey: 'legacy-key' };

      const agent = AgentFactory.createChatAgent('pilot', callbacks, options);

      expect(agent).toBeDefined();

      const config = getLastConfig();
      // Legacy pattern defaults chatId to 'default'
      expect(config.chatId).toBe('default');
      expect(config.callbacks).toBe(callbacks);
      expect(config.apiKey).toBe('legacy-key');
    });

    it('should create a ChatAgent with new pattern and no options', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createChatAgent('pilot', 'chat-no-opts', callbacks);

      const config = getLastConfig();
      expect(config.chatId).toBe('chat-no-opts');
      expect(config.callbacks).toBe(callbacks);
      expect(config.apiKey).toBe('default-api-key');
    });

    it('should throw error for unknown agent name', () => {
      const callbacks = createMockCallbacks();

      expect(() => AgentFactory.createChatAgent('unknown', 'chat-x', callbacks))
        .toThrow('Unknown ChatAgent: unknown');
      expect(ChatAgent).not.toHaveBeenCalled();
    });

    it('should pass messageBuilderOptions through new pattern', () => {
      const callbacks = createMockCallbacks();
      const messageBuilderOptions = { channel: 'feishu' } as any;

      AgentFactory.createChatAgent('pilot', 'chat-mb', callbacks, { messageBuilderOptions });

      const config = getLastConfig();
      expect(config.messageBuilderOptions).toBe(messageBuilderOptions);
    });
  });

  // ==========================================================================
  // toChatAgentCallbacks()
  // ==========================================================================

  describe('toChatAgentCallbacks()', () => {
    it('should preserve sendMessage from SchedulerCallbacks', () => {
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

      await expect(result.sendFile('chat-1', '/tmp/file.txt')).resolves.toBeUndefined();
    });

    it('should provide no-op onDone', async () => {
      const schedulerCallbacks = createMockSchedulerCallbacks();
      const result = toChatAgentCallbacks(schedulerCallbacks);

      await expect(result.onDone?.('chat-1')).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // Model resolution priority (tested via createAgent)
  // ==========================================================================

  describe('model resolution', () => {
    it('should prioritize explicit model over tier model', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue('tier-model');

      AgentFactory.createAgent('chat-test', callbacks, {
        model: 'my-explicit-model',
        modelTier: 'high',
      });

      expect(getLastConfig().model).toBe('my-explicit-model');
      expect(Config.getModelForTier).not.toHaveBeenCalled();
    });

    it('should use tier model when explicit model is not set', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue('high-tier-model');

      AgentFactory.createAgent('chat-test', callbacks, {
        modelTier: 'high',
      });

      expect(getLastConfig().model).toBe('high-tier-model');
      expect(Config.getModelForTier).toHaveBeenCalledWith('high');
    });

    it('should fall back to default config model when neither model nor tier is set', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-test', callbacks);

      expect(getLastConfig().model).toBe('default-model');
      expect(Config.getModelForTier).not.toHaveBeenCalled();
    });

    it('should fall back to default config model when tier returns undefined', () => {
      const callbacks = createMockCallbacks();
      vi.mocked(Config.getModelForTier).mockReturnValue(undefined);

      AgentFactory.createAgent('chat-test', callbacks, {
        modelTier: 'multimodal',
      });

      expect(getLastConfig().model).toBe('default-model');
    });
  });

  // ==========================================================================
  // Config override merging
  // ==========================================================================

  describe('config override merging', () => {
    it('should use default config when no overrides provided', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-defaults', callbacks);

      const config = getLastConfig();
      expect(config.apiKey).toBe('default-api-key');
      expect(config.model).toBe('default-model');
      expect(config.provider).toBe('anthropic');
      expect(config.apiBaseUrl).toBe('https://default.api.com');
      expect(config.permissionMode).toBe('bypassPermissions');
    });

    it('should override apiKey when provided', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-override', callbacks, { apiKey: 'override-key' });

      expect(getLastConfig().apiKey).toBe('override-key');
      // Other fields should still use defaults
      expect(getLastConfig().model).toBe('default-model');
    });

    it('should override provider when provided', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-override', callbacks, { provider: 'glm' });

      expect(getLastConfig().provider).toBe('glm');
    });

    it('should override apiBaseUrl when provided', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-override', callbacks, { apiBaseUrl: 'https://custom.url' });

      expect(getLastConfig().apiBaseUrl).toBe('https://custom.url');
    });

    it('should override permissionMode when provided', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-override', callbacks, { permissionMode: 'default' });

      expect(getLastConfig().permissionMode).toBe('default');
    });

    it('should default permissionMode to bypassPermissions', () => {
      const callbacks = createMockCallbacks();

      AgentFactory.createAgent('chat-perm', callbacks);

      expect(getLastConfig().permissionMode).toBe('bypassPermissions');
    });
  });
});
