/**
 * Tests for ChatAgent (packages/worker-node/src/agents/chat-agent/index.ts)
 *
 * Tests the public API of the ChatAgent class including lifecycle management,
 * session handling, chatId binding, and error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all @disclaude/core dependencies
vi.mock('@disclaude/core', () => ({
  Config: {
    getSessionRestoreConfig: vi.fn(() => ({
      historyDays: 1,
      maxContextLength: 50000,
    })),
    getMcpServersConfig: vi.fn(() => null),
  },
  BaseAgent: vi.fn().mockImplementation(function(this: any) {
    this.createSdkOptions = vi.fn(() => ({ mcpServers: {} }));
    this.createQueryStream = vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () { /* empty */ })(),
    }));
    this.queryOnce = vi.fn(() => (async function* () {
      yield { parsed: { type: 'result', content: 'done' } };
    })());
    this.dispose = vi.fn();
    this.getWorkspaceDir = vi.fn(() => '/tmp/test-workspace');
    this.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }),
  MessageBuilder: vi.fn().mockImplementation(() => ({
    buildEnhancedContent: vi.fn((input: any) => input.text),
  })),
  MessageChannel: vi.fn().mockImplementation(() => ({
    push: vi.fn(),
    close: vi.fn(),
    generator: vi.fn(() => (async function* () { /* empty */ })()),
  })),
  RestartManager: vi.fn().mockImplementation(() => ({
    recordSuccess: vi.fn(),
    shouldRestart: vi.fn(() => ({ allowed: false, reason: 'max_restarts_exceeded', restartCount: 3 })),
    reset: vi.fn(),
    clearAll: vi.fn(),
  })),
  ConversationOrchestrator: vi.fn().mockImplementation(() => ({
    setThreadRoot: vi.fn(),
    getThreadRoot: vi.fn(() => 'thread-root-123'),
    deleteThreadRoot: vi.fn(),
    clearAll: vi.fn(),
  })),
}));

vi.mock('@disclaude/mcp-server', () => ({
  createChannelMcpServer: vi.fn(() => ({ type: 'inline' })),
}));

import { ChatAgent } from './index.js';
import { MessageChannel } from '@disclaude/core';

const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
  getCapabilities: vi.fn(),
  getChatHistory: vi.fn().mockResolvedValue(undefined),
});

describe('ChatAgent', () => {
  let agent: InstanceType<typeof ChatAgent>;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = createMockCallbacks();
    agent = new ChatAgent({
      chatId: 'oc_test_chat',
      callbacks,
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
      apiBaseUrl: 'https://api.example.com',
    });
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

    it('should push message to channel after session starts', () => {
      void agent.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(MessageChannel).toHaveBeenCalled();
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
        { role: 'user' as const, content: 'hello', metadata: { chatId: 'oc_test_chat' } },
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
    it('should call getChatHistory callback if available during session start', () => {
      void agent.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(callbacks.getChatHistory).toHaveBeenCalled();
    });

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
