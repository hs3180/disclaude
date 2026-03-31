/**
 * Unit tests for AgentFactory
 *
 * Tests agent creation with unified configuration,
 * callback conversion, and factory method behaviors.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentFactory, toPilotCallbacks, type AgentCreateOptions } from './factory.js';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: vi.fn().mockReturnValue({
      apiKey: 'test-key',
      model: 'claude-3-opus',
      provider: 'claude',
      apiBaseUrl: undefined,
    }),
  },
}));

// Mock Pilot
vi.mock('./pilot/index.js', () => {
  const mockPilot = vi.fn().mockImplementation((config: any) => ({
    config,
    chatId: config.chatId,
    start: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    reset: vi.fn(),
    stop: vi.fn().mockReturnValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    handleInput: vi.fn(),
    processMessage: vi.fn(),
    executeOnce: vi.fn().mockResolvedValue(undefined),
    getChatId: vi.fn().mockReturnValue(config.chatId),
  }));
  return {
    Pilot: mockPilot,
  };
});

describe('toPilotCallbacks', () => {
  it('should convert SchedulerCallbacks to PilotCallbacks', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const callbacks = { sendMessage };
    const result = toPilotCallbacks(callbacks);

    expect(result.sendMessage).toBe(sendMessage);
    expect(typeof result.sendCard).toBe('function');
    expect(typeof result.sendFile).toBe('function');
    expect(typeof result.onDone).toBe('function');
  });

  it('should provide no-op implementations for non-sendMessage methods', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const callbacks = toPilotCallbacks({ sendMessage });

    // No-ops should not throw
    await callbacks.sendCard('chat-1', {} as any);
    await callbacks.sendFile('chat-1', '/path/to/file');
    await callbacks.onDone?.('chat-1');
  });

  it('should call sendMessage with correct arguments', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const callbacks = toPilotCallbacks({ sendMessage });

    await callbacks.sendMessage('chat-1', 'Hello');
    expect(sendMessage).toHaveBeenCalledWith('chat-1', 'Hello');
  });
});

describe('AgentFactory', () => {
  const defaultCallbacks = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
  };

  describe('createChatAgent', () => {
    it('should throw error for unknown agent name', () => {
      expect(() => AgentFactory.createChatAgent('unknown')).toThrow('Unknown ChatAgent: unknown');
    });

    it('should create pilot with new pattern (chatId, callbacks)', () => {
      const agent = AgentFactory.createChatAgent('pilot', 'chat-1', defaultCallbacks);
      expect(agent).toBeDefined();
    });

    it('should create pilot with new pattern including options', () => {
      const options: AgentCreateOptions = { model: 'claude-3-sonnet' };
      const agent = AgentFactory.createChatAgent('pilot', 'chat-1', defaultCallbacks, options);
      expect(agent).toBeDefined();
    });

    it('should create pilot with legacy pattern (callbacks only)', () => {
      const agent = AgentFactory.createChatAgent('pilot', defaultCallbacks);
      expect(agent).toBeDefined();
    });

    it('should create pilot with legacy pattern including options', () => {
      const options: AgentCreateOptions = { apiKey: 'custom-key' };
      const agent = AgentFactory.createChatAgent('pilot', defaultCallbacks, options);
      expect(agent).toBeDefined();
    });

    it('should bind chatId in new pattern', () => {
      const agent = AgentFactory.createChatAgent('pilot', 'my-chat-id', defaultCallbacks) as any;
      expect(agent.chatId).toBe('my-chat-id');
    });

    it('should use default chatId in legacy pattern', () => {
      const agent = AgentFactory.createChatAgent('pilot', defaultCallbacks) as any;
      expect(agent.chatId).toBe('default');
    });
  });

  describe('createScheduleAgent', () => {
    it('should create a pilot agent for scheduled tasks', () => {
      const agent = AgentFactory.createScheduleAgent('chat-1', defaultCallbacks);
      expect(agent).toBeDefined();
    });

    it('should bind chatId correctly', () => {
      const agent = AgentFactory.createScheduleAgent('schedule-chat', defaultCallbacks) as any;
      expect(agent.chatId).toBe('schedule-chat');
    });

    it('should accept options overrides', () => {
      const options: AgentCreateOptions = {
        model: 'claude-3-haiku',
        apiKey: 'schedule-key',
      };
      const agent = AgentFactory.createScheduleAgent('chat-1', defaultCallbacks, options);
      expect(agent).toBeDefined();
    });

    it('should default to empty options', () => {
      const agent = AgentFactory.createScheduleAgent('chat-1', defaultCallbacks);
      expect(agent).toBeDefined();
    });
  });

  describe('createTaskAgent', () => {
    it('should create a pilot agent for one-time tasks', () => {
      const agent = AgentFactory.createTaskAgent('chat-1', defaultCallbacks);
      expect(agent).toBeDefined();
    });

    it('should bind chatId correctly', () => {
      const agent = AgentFactory.createTaskAgent('task-chat', defaultCallbacks) as any;
      expect(agent.chatId).toBe('task-chat');
    });

    it('should accept options overrides', () => {
      const options: AgentCreateOptions = {
        permissionMode: 'default',
      };
      const agent = AgentFactory.createTaskAgent('chat-1', defaultCallbacks, options);
      expect(agent).toBeDefined();
    });
  });

  describe('configuration merging', () => {
    it('should use Config defaults when no overrides provided', () => {
      const agent = AgentFactory.createChatAgent('pilot', 'chat-1', defaultCallbacks) as any;
      expect(agent.config.apiKey).toBe('test-key');
      expect(agent.config.model).toBe('claude-3-opus');
    });

    it('should override apiKey when provided', () => {
      const options: AgentCreateOptions = { apiKey: 'override-key' };
      const agent = AgentFactory.createChatAgent('pilot', 'chat-1', defaultCallbacks, options) as any;
      expect(agent.config.apiKey).toBe('override-key');
    });

    it('should override model when provided', () => {
      const options: AgentCreateOptions = { model: 'claude-3-haiku' };
      const agent = AgentFactory.createChatAgent('pilot', 'chat-1', defaultCallbacks, options) as any;
      expect(agent.config.model).toBe('claude-3-haiku');
    });

    it('should default permissionMode to bypassPermissions', () => {
      const agent = AgentFactory.createChatAgent('pilot', 'chat-1', defaultCallbacks) as any;
      expect(agent.config.permissionMode).toBe('bypassPermissions');
    });

    it('should override permissionMode when provided', () => {
      const options: AgentCreateOptions = { permissionMode: 'default' };
      const agent = AgentFactory.createChatAgent('pilot', 'chat-1', defaultCallbacks, options) as any;
      expect(agent.config.permissionMode).toBe('default');
    });
  });
});
