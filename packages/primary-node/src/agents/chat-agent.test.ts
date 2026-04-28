/**
 * Tests for ChatAgent agent (packages/primary-node/src/agents/chat-agent.ts)
 *
 * Tests the AbortController mechanism ported from worker-node (Issue #2926):
 * - /reset, /stop, and /restart commands should immediately stop the running Agent loop
 * - The AbortController breaks the for-await loop in processIterator()
 *
 * Issue #2926: The previous fix (PR #2930) was applied to the worker-node copy,
 * but the runtime uses the primary-node copy. This test file verifies the fix
 * is correctly applied to the primary-node ChatAgent.
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

import { ChatAgent } from './chat-agent.js';

const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
  getCapabilities: vi.fn(),
  getChatHistory: vi.fn().mockResolvedValue(undefined),
});

describe('ChatAgent (primary-node)', () => {
  let chatAgent: InstanceType<typeof ChatAgent>;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = createMockCallbacks();
    chatAgent = new ChatAgent({
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
      expect(chatAgent.getChatId()).toBe('oc_test_chat');
    });

    it('should have type "chat"', () => {
      expect(chatAgent.type).toBe('chat');
    });

    it('should have name "ChatAgent"', () => {
      expect(chatAgent.name).toBe('ChatAgent');
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
      await expect(chatAgent.start()).resolves.toBeUndefined();
    });
  });

  describe('hasActiveSession / getActiveSessionCount', () => {
    it('should return false and 0 initially', () => {
      expect(chatAgent.hasActiveSession()).toBe(false);
      expect(chatAgent.getActiveSessionCount()).toBe(0);
    });
  });

  describe('stop', () => {
    it('should return false when no active query', () => {
      expect(chatAgent.stop()).toBe(false);
    });

    it('should return false for wrong chatId', () => {
      expect(chatAgent.stop('oc_wrong')).toBe(false);
    });
  });

  describe('reset', () => {
    it('should clear session state', () => {
      chatAgent.reset();
      expect(chatAgent.hasActiveSession()).toBe(false);
    });

    it('should ignore reset for wrong chatId', () => {
      chatAgent.reset();
      chatAgent.reset('oc_wrong');
      expect(chatAgent.getChatId()).toBe('oc_test_chat');
    });

    it('should handle multiple resets without error', () => {
      chatAgent.reset();
      chatAgent.reset();
      chatAgent.reset();
    });
  });

  describe('processMessage', () => {
    it('should ignore messages for wrong chatId', () => {
      void chatAgent.processMessage('oc_wrong', 'hello', 'msg_1');
      expect(chatAgent.hasActiveSession()).toBe(false);
    });

    it('should start a session when processing first message', () => {
      void chatAgent.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(chatAgent.hasActiveSession()).toBe(true);
    });
  });

  describe('executeOnce', () => {
    it('should throw when chatId does not match bound chatId', async () => {
      await expect(
        chatAgent.executeOnce('oc_wrong', 'hello', 'msg_1')
      ).rejects.toThrow('cannot execute for oc_wrong');
    });

    it('should complete successfully for matching chatId', async () => {
      await expect(
        chatAgent.executeOnce('oc_test_chat', 'hello', 'msg_1')
      ).resolves.toBeUndefined();
    });
  });

  describe('dispose', () => {
    it('should call dispose without throwing', () => {
      expect(() => chatAgent.dispose()).not.toThrow();
    });
  });

  describe('shutdown', () => {
    it('should complete shutdown without throwing', async () => {
      await expect(chatAgent.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('session lifecycle', () => {
    it('should allow reset after processMessage', () => {
      void chatAgent.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(chatAgent.hasActiveSession()).toBe(true);

      chatAgent.reset();
      expect(chatAgent.hasActiveSession()).toBe(false);
    });

    it('should allow new session after reset', () => {
      void chatAgent.processMessage('oc_test_chat', 'first', 'msg_1');
      expect(chatAgent.hasActiveSession()).toBe(true);

      chatAgent.reset();
      expect(chatAgent.hasActiveSession()).toBe(false);

      void chatAgent.processMessage('oc_test_chat', 'second', 'msg_2');
      expect(chatAgent.hasActiveSession()).toBe(true);
    });
  });

  describe('Issue #2926: abort mechanism for immediate stop/reset', () => {
    it('should break out of iterator when reset() is called during processing', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_abort_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Create an iterator that yields messages with a delay
      async function* slowIterator() {
        for (let i = 1; i <= 20; i++) {
          yield { parsed: { type: 'text', content: `msg-${i}` } };
          await new Promise<void>(r => setTimeout(r, 10));
        }
      }

      // Override createQueryStream on the instance
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: slowIterator(),
      });

      // Start the session by sending a message
      void agent.processMessage('oc_abort_test', 'hello', 'msg_1');

      // Wait a bit for some messages to process, then reset
      await new Promise<void>(r => setTimeout(r, 50));
      agent.reset();

      // Wait for processIterator to complete
      await new Promise<void>(r => setTimeout(r, 100));

      // The agent should have stopped - verify session is not active
      expect(agent.hasActiveSession()).toBe(false);
    });

    it('should break out of iterator when stop() is called during processing', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_stop_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* slowIterator() {
        for (let i = 1; i <= 20; i++) {
          yield { parsed: { type: 'text', content: `msg-${i}` } };
          await new Promise<void>(r => setTimeout(r, 10));
        }
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: slowIterator(),
      });

      void agent.processMessage('oc_stop_test', 'hello', 'msg_1');

      // Wait then stop
      await new Promise<void>(r => setTimeout(r, 50));
      const stopped = agent.stop();

      expect(stopped).toBe(true);
    });

    it('should abort AbortController on reset()', () => {
      const agent = new ChatAgent({
        chatId: 'oc_reset_abort_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Start a session to create AbortController
      void agent.processMessage('oc_reset_abort_test', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);

      // The abortController should exist
      const ac = (agent as any).abortController as AbortController;
      expect(ac).not.toBeNull();
      expect(ac.signal.aborted).toBe(false);

      // Reset should abort it
      agent.reset();
      expect(ac.signal.aborted).toBe(true);
      expect((agent as any).abortController).toBeNull();
    });

    it('should abort AbortController on stop()', () => {
      const agent = new ChatAgent({
        chatId: 'oc_stop_abort_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      void agent.processMessage('oc_stop_abort_test', 'hello', 'msg_1');
      const ac = (agent as any).abortController as AbortController;

      agent.stop();
      expect(ac.signal.aborted).toBe(true);
    });

    it('should abort AbortController on shutdown()', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_shutdown_abort_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      void agent.processMessage('oc_shutdown_abort_test', 'hello', 'msg_1');
      const ac = (agent as any).abortController as AbortController;

      await agent.shutdown();
      expect(ac.signal.aborted).toBe(true);
      expect((agent as any).abortController).toBeNull();
    });
  });

  describe('Issue #2993: session activity timeout', () => {
    it('should notify user when SDK iterator hangs (no messages within timeout)', async () => {
      vi.useFakeTimers();

      const agent = new ChatAgent({
        chatId: 'oc_timeout_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 1000, // 1 second for testing
      });

      // Create an iterator that yields one message then hangs indefinitely
      async function* hangingIterator() {
        yield { parsed: { type: 'text', content: 'first-msg' } };
        // Hang forever - simulating a stuck SDK connection
        await new Promise(() => {}); // never resolves
      }

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      (agent as any).createQueryStream = () => ({
        handle: mockHandle,
        iterator: hangingIterator(),
      });

      void agent.processMessage('oc_timeout_test', 'hello', 'msg_1');

      // Let the first message process (flush microtasks)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // At this point, the first message was sent but no timeout yet
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_timeout_test',
        'first-msg',
        'thread-root-123',
      );

      // Advance past the timeout (1 second + check interval)
      await vi.advanceTimersByTimeAsync(1500);

      // User should be notified about the hung session
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_timeout_test',
        expect.stringContaining('Agent 会话可能已挂起'),
        'thread-root-123',
      );

      // Query should be cancelled
      expect(mockHandle.cancel).toHaveBeenCalled();

      // Session should be inactive
      expect(agent.hasActiveSession()).toBe(false);

      vi.useRealTimers();
    });

    it('should NOT trigger timeout when messages arrive regularly', async () => {
      vi.useFakeTimers();

      const agent = new ChatAgent({
        chatId: 'oc_active_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 1000,
      });

      const messages: { resolve: () => void }[] = [];

      // Create an iterator that yields messages on demand
      async function* onDemandIterator() {
        for (let i = 0; i < 5; i++) {
          await new Promise<void>(r => { messages.push({ resolve: r }); });
          yield { parsed: { type: 'text', content: `msg-${i}` } };
        }
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: onDemandIterator(),
      });

      void agent.processMessage('oc_active_test', 'hello', 'msg_1');

      // Let initial microtasks settle
      await vi.advanceTimersByTimeAsync(0);

      // Simulate messages arriving every 300ms (well within the 1s timeout)
      for (let i = 0; i < 5; i++) {
        // Advance 300ms
        await vi.advanceTimersByTimeAsync(300);
        // Resolve the next message so the iterator yields
        if (messages[i]) {
          messages[i].resolve();
          await vi.advanceTimersByTimeAsync(0);
        }
      }

      // No timeout notification should have been sent
      const timeoutCalls = callbacks.sendMessage.mock.calls.filter(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('挂起'),
      );
      expect(timeoutCalls.length).toBe(0);

      vi.useRealTimers();
    });

    it('should stop activity monitor on reset()', async () => {
      vi.useFakeTimers();

      const agent = new ChatAgent({
        chatId: 'oc_reset_monitor_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 1000,
      });

      async function* hangingIterator() {
        yield { parsed: { type: 'text', content: 'msg' } };
        await new Promise(() => {});
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: hangingIterator(),
      });

      void agent.processMessage('oc_reset_monitor_test', 'hello', 'msg_1');
      await vi.advanceTimersByTimeAsync(0);

      // Reset before timeout fires
      agent.reset();

      // Advance well past the timeout
      await vi.advanceTimersByTimeAsync(5000);

      // No timeout notification should be sent because monitor was stopped
      const timeoutCalls = callbacks.sendMessage.mock.calls.filter(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('挂起'),
      );
      expect(timeoutCalls.length).toBe(0);

      vi.useRealTimers();
    });

    it('should stop activity monitor on shutdown()', async () => {
      vi.useFakeTimers();

      const agent = new ChatAgent({
        chatId: 'oc_shutdown_monitor_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 1000,
      });

      async function* hangingIterator() {
        yield { parsed: { type: 'text', content: 'msg' } };
        await new Promise(() => {});
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: hangingIterator(),
      });

      void agent.processMessage('oc_shutdown_monitor_test', 'hello', 'msg_1');
      await vi.advanceTimersByTimeAsync(0);

      await agent.shutdown();

      // Advance well past the timeout
      await vi.advanceTimersByTimeAsync(5000);

      // No timeout notification
      const timeoutCalls = callbacks.sendMessage.mock.calls.filter(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('挂起'),
      );
      expect(timeoutCalls.length).toBe(0);

      vi.useRealTimers();
    });

    it('should not start monitor when sessionActivityTimeoutMs is 0', async () => {
      vi.useFakeTimers();

      const agent = new ChatAgent({
        chatId: 'oc_no_monitor_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 0,
      });

      async function* hangingIterator() {
        yield { parsed: { type: 'text', content: 'msg' } };
        await new Promise(() => {});
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: hangingIterator(),
      });

      void agent.processMessage('oc_no_monitor_test', 'hello', 'msg_1');
      await vi.advanceTimersByTimeAsync(0);

      // No activity timer should be created
      expect((agent as any).activityTimer).toBeNull();

      // Advance well past default timeout — no notification
      await vi.advanceTimersByTimeAsync(5000);

      const timeoutCalls = callbacks.sendMessage.mock.calls.filter(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('挂起'),
      );
      expect(timeoutCalls.length).toBe(0);

      vi.useRealTimers();
    });
  });
});
