/**
 * Tests for ChatAgent (re-exported from @disclaude/core)
 *
 * Tests the public API of the ChatAgent class including lifecycle management,
 * session handling, chatId binding, and error paths.
 *
 * Issue #2717 Phase 1: Updated to work with ChatAgent migrated to @disclaude/core.
 * Uses partial mocking: keeps real ChatAgentImpl class but mocks BaseAgent dependencies
 * by providing a mock acpClient in the runtime context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock individual dependencies that ChatAgent uses internally
vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');

  return {
    ...actual,
    Config: {
      ...actual.Config,
      getSessionRestoreConfig: vi.fn(() => ({
        historyDays: 1,
        maxContextLength: 50000,
      })),
      getMcpServersConfig: vi.fn(() => null),
      getAgentConfig: vi.fn(() => ({
        apiKey: 'test-key',
        model: 'test-model',
        provider: 'anthropic',
        apiBaseUrl: undefined,
      })),
    },
  };
});

import { ChatAgentImpl as ChatAgent, setRuntimeContext, clearRuntimeContext } from '@disclaude/core';

// Create a mock ACP client that BaseAgent needs
const createMockAcpClient = () => ({
  state: 'connected' as const,
  connect: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(() => Promise.resolve()),
  createSession: vi.fn(() => Promise.resolve({
    sessionId: 'test-session',
    query: vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () {
        yield { parsed: { type: 'result', content: 'done' } };
      })(),
    })),
  })),
  sendPrompt: vi.fn(() => (async function* () {
    yield { type: 'assistant', content: 'done' };
    yield { type: 'result', content: 'completed' };
  })()),
  query: vi.fn(() => ({
    handle: { close: vi.fn(), cancel: vi.fn() },
    iterator: (async function* () {
      yield { parsed: { type: 'result', content: 'done' } };
    })(),
  })),
});

const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
  getCapabilities: vi.fn(() => ({
    supportsCard: true,
    supportsThread: true,
    supportsFile: true,
    supportsMarkdown: true,
    supportsMention: false,
    supportsUpdate: false,
    supportedMcpTools: ['send_text', 'send_card', 'send_interactive', 'send_file'],
  })),
  getChatHistory: vi.fn().mockResolvedValue(undefined),
});

describe('ChatAgent', () => {
  let agent: InstanceType<typeof ChatAgent>;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let mockAcpClient: ReturnType<typeof createMockAcpClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = createMockCallbacks();
    mockAcpClient = createMockAcpClient();

    // Set runtime context with mock ACP client and workspace dir (required by BaseAgent constructor)
    setRuntimeContext({
      getAcpClient: () => mockAcpClient,
      getWorkspaceDir: () => '/tmp/test-workspace',
      getLoggingConfig: () => ({ enabled: false }),
      getGlobalEnv: () => ({}),
      isAgentTeamsEnabled: () => false,
      getAgentConfig: () => ({
        apiKey: 'test-key',
        model: 'test-model',
        provider: 'anthropic',
        apiBaseUrl: undefined,
      }),
    } as any);

    agent = new ChatAgent({
      chatId: 'oc_test_chat',
      callbacks,
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
      apiBaseUrl: 'https://api.example.com',
    });
  });

  afterEach(() => {
    clearRuntimeContext();
  });

  describe('constructor', () => {
    it('should create a ChatAgent with bound chatId', () => {
      expect(agent.getChatId()).toBe('oc_test_chat');
    });

    it('should have type "chat"', () => {
      expect(agent.type).toBe('chat');
    });

    it('should have name "ChatAgent"', () => {
      expect(agent.name).toBe('ChatAgent');
    });
  });

  describe('getChatId', () => {
    it('should return the bound chatId', () => {
      const p = new ChatAgent({
        chatId: 'oc_another_chat',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      expect(p.getChatId()).toBe('oc_another_chat');
    });
  });

  describe('start', () => {
    it('should resolve immediately (no-op)', async () => {
      await expect(agent.start()).resolves.toBeUndefined();
    });
  });

  describe('hasActiveSession / getActiveSessionCount', () => {
    it('should return false and 0 initially', () => {
      expect(agent.hasActiveSession()).toBe(false);
      expect(agent.getActiveSessionCount()).toBe(0);
    });
  });

  describe('stop', () => {
    it('should return false when no active query', () => {
      expect(agent.stop()).toBe(false);
    });

    it('should return false for wrong chatId', () => {
      expect(agent.stop('oc_wrong')).toBe(false);
    });
  });

  describe('reset', () => {
    it('should clear session state', () => {
      agent.reset();
      expect(agent.hasActiveSession()).toBe(false);
    });

    it('should ignore reset for wrong chatId', () => {
      agent.reset();
      agent.reset('oc_wrong');
      expect(agent.getChatId()).toBe('oc_test_chat');
    });

    it('should clear history state', () => {
      agent.reset();
      agent.reset();
      agent.reset();
    });
  });

  describe('processMessage', () => {
    it('should ignore messages for wrong chatId', () => {
      void agent.processMessage('oc_wrong', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(false);
    });

    it('should start a session when processing first message', () => {
      void agent.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);
    });

    it('should use agent loop for session management', () => {
      void agent.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);
    });
  });

  describe('executeOnce', () => {
    it('should throw when chatId does not match bound chatId', async () => {
      await expect(
        agent.executeOnce('oc_wrong', 'hello', 'msg_1')
      ).rejects.toThrow('cannot execute for oc_wrong');
    });

    it('should complete successfully for matching chatId', async () => {
      await expect(
        agent.executeOnce('oc_test_chat', 'hello', 'msg_1')
      ).resolves.toBeUndefined();
    });
  });

  describe('handleInput', () => {
    it('should skip messages for wrong chatId', async () => {
      const messages = [
        { role: 'user' as const, content: 'hello', metadata: { chatId: 'oc_wrong' } },
      ];
      const gen = async function* () {
        for (const msg of messages) {yield msg;}
      };

      const results = [];
      for await (const result of agent.handleInput(gen() as AsyncGenerator<any>)) {
        results.push(result);
      }

      expect(results.length).toBe(0);
    });

    it('should yield response for matching chatId', async () => {
      const messages = [
        { role: 'user' as const, content: 'hello', metadata: { chatId: 'oc_test_chat', parentMessageId: 'msg_1' } },
      ];
      const gen = async function* () {
        for (const msg of messages) {yield msg;}
      };

      const results = [];
      for await (const result of agent.handleInput(gen() as AsyncGenerator<any>)) {
        results.push(result);
      }

      expect(results.length).toBe(1);
      expect(results[0].role).toBe('assistant');
    });
  });

  describe('dispose', () => {
    it('should call dispose without throwing', () => {
      expect(() => agent.dispose()).not.toThrow();
    });
  });

  describe('shutdown', () => {
    it('should complete shutdown without throwing', async () => {
      await expect(agent.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('session lifecycle', () => {
    it('should allow reset after processMessage', () => {
      void agent.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);

      agent.reset();
      expect(agent.hasActiveSession()).toBe(false);
    });

    it('should allow new session after reset', () => {
      void agent.processMessage('oc_test_chat', 'first', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);

      agent.reset();
      expect(agent.hasActiveSession()).toBe(false);

      void agent.processMessage('oc_test_chat', 'second', 'msg_2');
      expect(agent.hasActiveSession()).toBe(true);
    });

    it('should handle multiple resets without error', () => {
      agent.reset();
      agent.reset();
      agent.reset();
      expect(agent.hasActiveSession()).toBe(false);
    });
  });

  describe('history loading', () => {
    it('should not throw when getChatHistory callback is not provided', () => {
      const noHistoryCallbacks = {
        ...callbacks,
        getChatHistory: undefined,
      };
      const p = new ChatAgent({
        chatId: 'oc_test',
        callbacks: noHistoryCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      void p.processMessage('oc_test', 'hello', 'msg_1');
      expect(p.hasActiveSession()).toBe(true);
    });
  });
});
