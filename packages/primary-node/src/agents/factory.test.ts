/**
 * Tests for AgentFactory — verifies createAgent(), createChatAgent(),
 * deprecated wrappers, and toChatAgentCallbacks().
 *
 * Issue #2991: Add unit tests for AgentFactory.createAgent() method.
 *
 * Strategy: Mock ChatAgent constructor to spy on the config object
 * passed to it, and mock Config.getAgentConfig() for deterministic defaults.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (must be before importing the module under test) ---

// Capture the config passed to ChatAgent constructor
let capturedConfig: unknown;

vi.mock('./chat-agent.js', () => ({
  ChatAgent: vi.fn().mockImplementation((config) => {
    capturedConfig = config;
    return { _mockChatAgent: true, config };
  }),
}));

const mockGetAgentConfig = vi.fn().mockReturnValue({
  apiKey: 'test-api-key',
  model: 'test-model',
  provider: 'anthropic',
  apiBaseUrl: 'https://api.example.com',
});

vi.mock('@disclaude/core', () => ({
  Config: {
    getAgentConfig: (...args: unknown[]) => mockGetAgentConfig(...args),
  },
}));

// --- Import after mocks ---
const { AgentFactory, toChatAgentCallbacks } = await import('./factory.js');
const { ChatAgent } = await import('./chat-agent.js');

// --- Helpers ---
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
    capturedConfig = undefined;
    mockGetAgentConfig.mockReturnValue({
      apiKey: 'test-api-key',
      model: 'test-model',
      provider: 'anthropic',
      apiBaseUrl: 'https://api.example.com',
    });
  });

  // ==========================================================================
  // createAgent()
  // ==========================================================================

  describe('createAgent()', () => {
    it('should create a ChatAgent instance', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createAgent('chat-123', callbacks);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledOnce();
    });

    it('should pass correct chatId to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('my-chat-id', callbacks);

      expect(capturedConfig).toMatchObject({ chatId: 'my-chat-id' });
    });

    it('should pass callbacks to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(capturedConfig).toMatchObject({ callbacks });
    });

    it('should use default config values when no options provided', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(capturedConfig).toMatchObject({
        apiKey: 'test-api-key',
        model: 'test-model',
        provider: 'anthropic',
        apiBaseUrl: 'https://api.example.com',
      });
    });

    it('should override apiKey via options', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { apiKey: 'override-key' });

      expect(capturedConfig).toMatchObject({ apiKey: 'override-key' });
    });

    it('should override model via options', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { model: 'claude-4-opus' });

      expect(capturedConfig).toMatchObject({ model: 'claude-4-opus' });
    });

    it('should override provider via options', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { provider: 'glm' });

      expect(capturedConfig).toMatchObject({ provider: 'glm' });
    });

    it('should override apiBaseUrl via options', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { apiBaseUrl: 'https://custom.api.com' });

      expect(capturedConfig).toMatchObject({ apiBaseUrl: 'https://custom.api.com' });
    });

    it('should override permissionMode via options', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks, { permissionMode: 'default' });

      expect(capturedConfig).toMatchObject({ permissionMode: 'default' });
    });

    it('should default permissionMode to bypassPermissions', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(capturedConfig).toMatchObject({ permissionMode: 'bypassPermissions' });
    });

    it('should pass messageBuilderOptions to ChatAgent config', () => {
      const callbacks = createMockCallbacks();
      const messageBuilderOptions = { buildHeader: () => 'Test Header' };
      AgentFactory.createAgent('chat-1', callbacks, { messageBuilderOptions });

      expect(capturedConfig).toMatchObject({ messageBuilderOptions });
    });

    it('should call Config.getAgentConfig() for defaults', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createAgent('chat-1', callbacks);

      expect(mockGetAgentConfig).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // createChatAgent()
  // ==========================================================================

  describe('createChatAgent()', () => {
    it('should create a ChatAgent for name "pilot" with new pattern (chatId, callbacks, options)', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', 'chat-456', callbacks, { model: 'custom-model' });

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledOnce();
      expect(capturedConfig).toMatchObject({
        chatId: 'chat-456',
        model: 'custom-model',
      });
    });

    it('should support legacy pattern (callbacks, options) with chatId defaulting to "default"', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createChatAgent('pilot', callbacks);

      expect(agent).toBeDefined();
      expect(capturedConfig).toMatchObject({ chatId: 'default' });
    });

    it('should throw for unknown agent name', () => {
      expect(() => AgentFactory.createChatAgent('unknown', 'chat-1', createMockCallbacks())).toThrow(
        /Unknown ChatAgent: unknown/,
      );
    });

    it('should not call ChatAgent constructor for unknown name', () => {
      try {
        AgentFactory.createChatAgent('unknown', 'chat-1', createMockCallbacks());
      } catch {
        // Expected
      }

      expect(ChatAgent).not.toHaveBeenCalled();
    });

    it('should pass callbacks through in new pattern', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createChatAgent('pilot', 'chat-1', callbacks);

      expect(capturedConfig).toMatchObject({ callbacks });
    });

    it('should use default config when no options in new pattern', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createChatAgent('pilot', 'chat-1', callbacks);

      expect(capturedConfig).toMatchObject({
        apiKey: 'test-api-key',
        model: 'test-model',
      });
    });

    it('should apply options overrides in new pattern', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createChatAgent('pilot', 'chat-1', callbacks, {
        apiKey: 'pilot-key',
        model: 'pilot-model',
      });

      expect(capturedConfig).toMatchObject({
        apiKey: 'pilot-key',
        model: 'pilot-model',
      });
    });
  });

  // ==========================================================================
  // Deprecated wrappers
  // ==========================================================================

  describe('createScheduleAgent() [deprecated]', () => {
    it('should delegate to createAgent()', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createScheduleAgent('chat-789', callbacks);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledOnce();
      expect(capturedConfig).toMatchObject({ chatId: 'chat-789' });
    });

    it('should pass options through to createAgent()', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createScheduleAgent('chat-1', callbacks, { model: 'schedule-model' });

      expect(capturedConfig).toMatchObject({ model: 'schedule-model' });
    });
  });

  describe('createTaskAgent() [deprecated]', () => {
    it('should delegate to createAgent()', () => {
      const callbacks = createMockCallbacks();
      const agent = AgentFactory.createTaskAgent('chat-000', callbacks);

      expect(agent).toBeDefined();
      expect(ChatAgent).toHaveBeenCalledOnce();
      expect(capturedConfig).toMatchObject({ chatId: 'chat-000' });
    });

    it('should pass options through to createAgent()', () => {
      const callbacks = createMockCallbacks();
      AgentFactory.createTaskAgent('chat-1', callbacks, { apiKey: 'task-key' });

      expect(capturedConfig).toMatchObject({ apiKey: 'task-key' });
    });
  });

  // ==========================================================================
  // toChatAgentCallbacks()
  // ==========================================================================

  describe('toChatAgentCallbacks()', () => {
    it('should preserve sendMessage from SchedulerCallbacks', () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const result = toChatAgentCallbacks({ sendMessage });

      expect(result.sendMessage).toBe(sendMessage);
    });

    it('should provide no-op sendCard', async () => {
      const result = toChatAgentCallbacks({
        sendMessage: vi.fn().mockResolvedValue(undefined),
      });

      // Should not throw
      await expect(result.sendCard('chat-1', {} as never)).resolves.toBeUndefined();
    });

    it('should provide no-op sendFile', async () => {
      const result = toChatAgentCallbacks({
        sendMessage: vi.fn().mockResolvedValue(undefined),
      });

      // Should not throw
      await expect(result.sendFile('chat-1', '/tmp/file.txt')).resolves.toBeUndefined();
    });

    it('should provide no-op onDone', async () => {
      const result = toChatAgentCallbacks({
        sendMessage: vi.fn().mockResolvedValue(undefined),
      });

      // Should not throw
      await expect(result.onDone?.('chat-1')).resolves.toBeUndefined();
    });
  });
});
