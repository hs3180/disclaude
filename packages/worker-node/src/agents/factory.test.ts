/**
 * Tests for AgentFactory (packages/worker-node/src/agents/factory.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() to declare variables that will be available in vi.mock factories
const { mockChatAgent } = vi.hoisted(() => ({
  mockChatAgent: vi.fn(),
}));

const { mockGetAgentConfig } = vi.hoisted(() => ({
  mockGetAgentConfig: vi.fn(() => ({
    apiKey: 'default-key',
    model: 'default-model',
    provider: 'anthropic',
    apiBaseUrl: 'https://api.example.com',
  })),
}));

vi.mock('./chat-agent/index.js', () => ({
  ChatAgent: mockChatAgent,
}));

vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: mockGetAgentConfig,
  },
  ChatAgent: vi.fn(),
  BaseAgent: vi.fn(),
  BaseAgentConfig: vi.fn(),
}));

import { AgentFactory, toChatAgentCallbacks } from './factory.js';

const mockCallbacks = {
  sendMessage: vi.fn(),
  sendCard: vi.fn(),
  sendFile: vi.fn(),
  onDone: vi.fn(),
};

describe('toChatAgentCallbacks', () => {
  it('should convert SchedulerCallbacks to ChatAgentCallbacks', () => {
    const schedulerCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    expect(result.sendMessage).toBe(schedulerCallbacks.sendMessage);
    expect(typeof result.sendCard).toBe('function');
    expect(typeof result.sendFile).toBe('function');
    expect(typeof result.onDone).toBe('function');
  });

  it('should provide no-op implementations for non-sendMessage methods', async () => {
    const schedulerCallbacks: { sendMessage: (chatId: string, message: string) => Promise<void> } = {
      sendMessage: vi.fn(),
    };

    const result = toChatAgentCallbacks(schedulerCallbacks);

    // No-ops should not throw
    await result.sendCard('chat-1', {} as any);
    await result.sendFile('chat-1', '/path');
    await result.onDone?.('chat-1');

    // sendMessage should be the original
    expect(result.sendMessage).toBe(schedulerCallbacks.sendMessage);
  });
});

describe('AgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatAgent.mockClear();
    mockGetAgentConfig.mockReturnValue({
      apiKey: 'default-key',
      model: 'default-model',
      provider: 'anthropic',
      apiBaseUrl: 'https://api.example.com',
    });
  });

  describe('createChatAgent', () => {
    it('should create a ChatAgent for "pilot" name with new pattern', () => {
      mockChatAgent.mockReturnValue({});
      const agent = AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks);

      expect(agent).toBeDefined();
      expect(mockChatAgent).toHaveBeenCalledTimes(1);

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.chatId).toBe('chat-123');
      expect(pilotConfig.callbacks).toBe(mockCallbacks);
      expect(pilotConfig.apiKey).toBe('default-key');
      expect(pilotConfig.model).toBe('default-model');
    });

    it('should create a ChatAgent for "pilot" name with legacy pattern', () => {
      mockChatAgent.mockReturnValue({});
      const agent = AgentFactory.createChatAgent('pilot', mockCallbacks);

      expect(agent).toBeDefined();
      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.chatId).toBe('default');
      expect(pilotConfig.callbacks).toBe(mockCallbacks);
    });

    it('should apply custom options overrides', () => {
      mockChatAgent.mockReturnValue({});
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        apiKey: 'custom-key',
        model: 'custom-model',
        provider: 'openai',
        apiBaseUrl: 'https://custom.api.com',
      });

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.apiKey).toBe('custom-key');
      expect(pilotConfig.model).toBe('custom-model');
      expect(pilotConfig.provider).toBe('openai');
      expect(pilotConfig.apiBaseUrl).toBe('https://custom.api.com');
    });

    it('should pass messageBuilderOptions to ChatAgent config', () => {
      mockChatAgent.mockReturnValue({});
      const mcpOptions = { buildHeader: vi.fn(() => 'Header') };
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        messageBuilderOptions: mcpOptions,
      });

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.messageBuilderOptions).toBe(mcpOptions);
    });

    it('should throw for unknown agent name', () => {
      expect(() => AgentFactory.createChatAgent('unknown', 'chat-123', mockCallbacks))
        .toThrow('Unknown ChatAgent: unknown');
    });

    it('should use default permission mode', () => {
      mockChatAgent.mockReturnValue({});
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks);

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.permissionMode).toBe('bypassPermissions');
    });

    it('should allow overriding permission mode', () => {
      mockChatAgent.mockReturnValue({});
      AgentFactory.createChatAgent('pilot', 'chat-123', mockCallbacks, {
        permissionMode: 'default',
      });

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.permissionMode).toBe('default');
    });
  });

  describe('createScheduleAgent', () => {
    it('should create a ChatAgent for scheduled tasks', () => {
      mockChatAgent.mockReturnValue({});
      const agent = AgentFactory.createScheduleAgent('chat-123', mockCallbacks);

      expect(agent).toBeDefined();
      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.chatId).toBe('chat-123');
      expect(pilotConfig.callbacks).toBe(mockCallbacks);
    });

    it('should apply custom options', () => {
      mockChatAgent.mockReturnValue({});
      AgentFactory.createScheduleAgent('chat-123', mockCallbacks, {
        model: 'schedule-model',
      });

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.model).toBe('schedule-model');
    });

    it('should pass messageBuilderOptions', () => {
      mockChatAgent.mockReturnValue({});
      const mcpOptions = { buildHeader: vi.fn(() => 'Header') };
      AgentFactory.createScheduleAgent('chat-123', mockCallbacks, {
        messageBuilderOptions: mcpOptions,
      });

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.messageBuilderOptions).toBe(mcpOptions);
    });
  });

  describe('createTaskAgent', () => {
    it('should create a ChatAgent for task execution', () => {
      mockChatAgent.mockReturnValue({});
      const agent = AgentFactory.createTaskAgent('chat-123', mockCallbacks);

      expect(agent).toBeDefined();
      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.chatId).toBe('chat-123');
      expect(pilotConfig.callbacks).toBe(mockCallbacks);
    });

    it('should apply custom options', () => {
      mockChatAgent.mockReturnValue({});
      AgentFactory.createTaskAgent('chat-123', mockCallbacks, {
        model: 'task-model',
        provider: 'anthropic',
      });

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.model).toBe('task-model');
      expect(pilotConfig.provider).toBe('anthropic');
    });

    it('should pass messageBuilderOptions', () => {
      mockChatAgent.mockReturnValue({});
      const mcpOptions = { buildHeader: vi.fn(() => 'Header') };
      AgentFactory.createTaskAgent('chat-123', mockCallbacks, {
        messageBuilderOptions: mcpOptions,
      });

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.messageBuilderOptions).toBe(mcpOptions);
    });
  });

  describe('config merging', () => {
    it('should merge defaults with overrides using nullish coalescing', () => {
      mockGetAgentConfig.mockReturnValue({
        apiKey: 'default-key',
        model: 'default-model',
        provider: 'anthropic',
        apiBaseUrl: 'https://api.example.com',
      });

      mockChatAgent.mockReturnValue({});

      // Override only apiKey, rest should use defaults
      AgentFactory.createScheduleAgent('chat-123', mockCallbacks, {
        apiKey: 'override-key',
      });

      const [[pilotConfig]] = mockChatAgent.mock.calls;
      expect(pilotConfig.apiKey).toBe('override-key');
      expect(pilotConfig.model).toBe('default-model');
      expect(pilotConfig.provider).toBe('anthropic');
      expect(pilotConfig.apiBaseUrl).toBe('https://api.example.com');
    });
  });
});
