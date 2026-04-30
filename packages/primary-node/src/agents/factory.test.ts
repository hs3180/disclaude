/**
 * Unit tests for AgentFactory and toChatAgentCallbacks helper.
 *
 * Tests agent creation with various configuration patterns,
 * callback conversion, and error handling.
 *
 * Related: Issue #2991 (AgentFactory unit tests)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentFactory, toChatAgentCallbacks } from './factory.js';
import type { ChatAgentCallbacks, ChatAgentConfig } from './types.js';
import type { SchedulerCallbacks } from '@disclaude/core';

// Track configs passed to ChatAgent constructor
const capturedConfigs: ChatAgentConfig[] = [];

// Mock ChatAgent class to capture constructor args
vi.mock('./chat-agent.js', () => {
  return {
    ChatAgent: class MockChatAgent {
      constructor(config: ChatAgentConfig) {
        capturedConfigs.push(config);
      }
    },
  };
});

// Mock Config.getAgentConfig to return predictable defaults
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    Config: {
      getAgentConfig: () => ({
        apiKey: 'default-api-key',
        model: 'default-model',
        provider: 'anthropic',
        apiBaseUrl: undefined,
      }),
    },
  };
});

describe('toChatAgentCallbacks', () => {
  it('should convert SchedulerCallbacks to ChatAgentCallbacks', () => {
    const sendMessage = vi.fn();
    const schedulerCallbacks: SchedulerCallbacks = { sendMessage };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    expect(result.sendMessage).toBe(sendMessage);
  });

  it('should provide no-op sendCard', async () => {
    const schedulerCallbacks: SchedulerCallbacks = {
      sendMessage: vi.fn(),
    };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.sendCard('chat-1', {} as never)).resolves.toBeUndefined();
  });

  it('should provide no-op sendFile', async () => {
    const schedulerCallbacks: SchedulerCallbacks = {
      sendMessage: vi.fn(),
    };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.sendFile('chat-1', '/tmp/test.txt')).resolves.toBeUndefined();
  });

  it('should provide no-op onDone', async () => {
    const schedulerCallbacks: SchedulerCallbacks = {
      sendMessage: vi.fn(),
    };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    // Should not throw
    await expect(result.onDone?.('chat-1')).resolves.toBeUndefined();
  });

  it('should preserve the original sendMessage reference', () => {
    const sendMessage = vi.fn();
    const schedulerCallbacks: SchedulerCallbacks = { sendMessage };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    void result.sendMessage('chat-1', 'hello');
    expect(sendMessage).toHaveBeenCalledWith('chat-1', 'hello');
  });
});

describe('AgentFactory', () => {
  beforeEach(() => {
    capturedConfigs.length = 0;
  });

  describe('createChatAgent', () => {
    const mockCallbacks: ChatAgentCallbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
      onDone: vi.fn(),
    };

    it('should create a ChatAgent with chatId string (new pattern)', () => {
      const agent = AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks);

      expect(agent).toBeDefined();
      expect(capturedConfigs).toHaveLength(1);
      expect(capturedConfigs[0].chatId).toBe('chat-123');
    });

    it('should pass callbacks in config', () => {
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks);

      expect(capturedConfigs[0].callbacks).toBe(mockCallbacks);
    });

    it('should use default config from Config.getAgentConfig', () => {
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks);

      expect(capturedConfigs[0].apiKey).toBe('default-api-key');
      expect(capturedConfigs[0].model).toBe('default-model');
      expect(capturedConfigs[0].provider).toBe('anthropic');
    });

    it('should apply default permissionMode as bypassPermissions', () => {
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks);

      expect(capturedConfigs[0].permissionMode).toBe('bypassPermissions');
    });

    it('should support options override for apiKey', () => {
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        apiKey: 'custom-key',
      });

      expect(capturedConfigs[0].apiKey).toBe('custom-key');
    });

    it('should support options override for model', () => {
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        model: 'claude-opus-4',
      });

      expect(capturedConfigs[0].model).toBe('claude-opus-4');
    });

    it('should support options override for provider', () => {
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        provider: 'glm',
      });

      expect(capturedConfigs[0].provider).toBe('glm');
    });

    it('should support options override for apiBaseUrl', () => {
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        apiBaseUrl: 'https://custom.api.com',
      });

      expect(capturedConfigs[0].apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should support options override for permissionMode', () => {
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        permissionMode: 'default',
      });

      expect(capturedConfigs[0].permissionMode).toBe('default');
    });

    it('should support MessageBuilderOptions in options', () => {
      const messageBuilderOptions = {
        buildHeader: () => 'Test Header',
      };

      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        messageBuilderOptions,
      });

      expect(capturedConfigs[0].messageBuilderOptions).toBe(messageBuilderOptions);
    });

    it('should throw for unknown agent name', () => {
      expect(() => AgentFactory.createChatAgent('unknown', 'chat-1', mockCallbacks))
        .toThrow('Unknown ChatAgent: unknown');
    });

    it('should support legacy pattern with callbacks as first arg', () => {
      // Legacy: createChatAgent('pilot', callbacks)
      AgentFactory.createChatAgent('pilot', mockCallbacks);

      expect(capturedConfigs).toHaveLength(1);
      expect(capturedConfigs[0].chatId).toBe('default');
      expect(capturedConfigs[0].callbacks).toBe(mockCallbacks);
    });

    it('should support legacy pattern with callbacks and options', () => {
      // Legacy: createChatAgent('pilot', callbacks, options)
      AgentFactory.createChatAgent('pilot', mockCallbacks, { model: 'custom-model' });

      expect(capturedConfigs).toHaveLength(1);
      expect(capturedConfigs[0].chatId).toBe('default');
      expect(capturedConfigs[0].model).toBe('custom-model');
    });

    it('should prefer new pattern over legacy when chatId is string', () => {
      AgentFactory.createChatAgent('pilot', 'explicit-chat-id', mockCallbacks);

      expect(capturedConfigs[0].chatId).toBe('explicit-chat-id');
    });
  });

  describe('createAgent', () => {
    const mockCallbacks: ChatAgentCallbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
      onDone: vi.fn(),
    };

    it('should create a ChatAgent with chatId', () => {
      const agent = AgentFactory.createAgent('chat-456', mockCallbacks);

      expect(agent).toBeDefined();
      expect(capturedConfigs).toHaveLength(1);
      expect(capturedConfigs[0].chatId).toBe('chat-456');
    });

    it('should pass callbacks in config', () => {
      AgentFactory.createAgent('chat-456', mockCallbacks);

      expect(capturedConfigs[0].callbacks).toBe(mockCallbacks);
    });

    it('should use default config values', () => {
      AgentFactory.createAgent('chat-456', mockCallbacks);

      expect(capturedConfigs[0].apiKey).toBe('default-api-key');
      expect(capturedConfigs[0].model).toBe('default-model');
      expect(capturedConfigs[0].permissionMode).toBe('bypassPermissions');
    });

    it('should support all option overrides', () => {
      AgentFactory.createAgent('chat-456', mockCallbacks, {
        apiKey: 'override-key',
        model: 'override-model',
        provider: 'glm',
        apiBaseUrl: 'https://override.api.com',
        permissionMode: 'default',
        messageBuilderOptions: { buildHeader: () => 'Header' },
      });

      expect(capturedConfigs[0].apiKey).toBe('override-key');
      expect(capturedConfigs[0].model).toBe('override-model');
      expect(capturedConfigs[0].provider).toBe('glm');
      expect(capturedConfigs[0].apiBaseUrl).toBe('https://override.api.com');
      expect(capturedConfigs[0].permissionMode).toBe('default');
      expect(capturedConfigs[0].messageBuilderOptions).toBeDefined();
    });

    it('should use default values when no options provided', () => {
      AgentFactory.createAgent('chat-456', mockCallbacks);

      expect(capturedConfigs[0].apiKey).toBe('default-api-key');
      expect(capturedConfigs[0].apiBaseUrl).toBeUndefined();
    });
  });

  describe('deprecated methods', () => {
    const mockCallbacks: ChatAgentCallbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
      onDone: vi.fn(),
    };

    it('createScheduleAgent should delegate to createAgent', () => {
      const agent = AgentFactory.createScheduleAgent('chat-789', mockCallbacks);

      expect(agent).toBeDefined();
      expect(capturedConfigs).toHaveLength(1);
      expect(capturedConfigs[0].chatId).toBe('chat-789');
    });

    it('createTaskAgent should delegate to createAgent', () => {
      const agent = AgentFactory.createTaskAgent('chat-789', mockCallbacks);

      expect(agent).toBeDefined();
      expect(capturedConfigs).toHaveLength(1);
      expect(capturedConfigs[0].chatId).toBe('chat-789');
    });

    it('createScheduleAgent should pass through options', () => {
      AgentFactory.createScheduleAgent('chat-789', mockCallbacks, {
        model: 'schedule-model',
      });

      expect(capturedConfigs[0].model).toBe('schedule-model');
    });

    it('createTaskAgent should pass through options', () => {
      AgentFactory.createTaskAgent('chat-789', mockCallbacks, {
        model: 'task-model',
      });

      expect(capturedConfigs[0].model).toBe('task-model');
    });
  });

  describe('config merge precedence', () => {
    const mockCallbacks: ChatAgentCallbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
      onDone: vi.fn(),
    };

    it('should override apiKey when provided, keep default otherwise', () => {
      AgentFactory.createAgent('chat-1', mockCallbacks, { apiKey: 'custom' });
      expect(capturedConfigs[0].apiKey).toBe('custom');
      expect(capturedConfigs[0].model).toBe('default-model');
    });

    it('should keep all defaults when no overrides provided', () => {
      AgentFactory.createAgent('chat-1', mockCallbacks);
      expect(capturedConfigs[0].apiKey).toBe('default-api-key');
      expect(capturedConfigs[0].model).toBe('default-model');
      expect(capturedConfigs[0].provider).toBe('anthropic');
      expect(capturedConfigs[0].apiBaseUrl).toBeUndefined();
      expect(capturedConfigs[0].permissionMode).toBe('bypassPermissions');
    });
  });
});
