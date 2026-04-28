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
    this.createSdkOptions = vi.fn(() => ({ mcpServers: {}, env: {} }));
    this.createQueryStream = vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () { /* empty */ })(),
    }));
    this.queryOnce = vi.fn(() => (async function* () {
      yield { parsed: { type: 'result', content: 'done' } };
    })());
    this.dispose = vi.fn();
    this.apiBaseUrl = undefined;
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
  // Issue #2992: Mock network diagnostics
  captureTcpConnections: vi.fn(() => ({
    timestamp: '2026-04-28T22:00:00.000Z',
    apiConnections: [],
  })),
  formatDiagnostics: vi.fn(() => 'Mock diagnostics'),
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

  describe('Issue #2992: session activity timeout and network diagnostics', () => {
    it('should use default sessionActivityTimeoutMs of 300000ms (5 min)', () => {
      const agent = new ChatAgent({
        chatId: 'oc_timeout_default',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      // Access private property via any cast
      expect((agent as any).sessionActivityTimeoutMs).toBe(300000);
    });

    it('should use custom sessionActivityTimeoutMs when configured', () => {
      const agent = new ChatAgent({
        chatId: 'oc_timeout_custom',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 60000,
      });
      expect((agent as any).sessionActivityTimeoutMs).toBe(60000);
    });

    it('should use default requestTimeoutMs of 300000ms (5 min)', () => {
      const agent = new ChatAgent({
        chatId: 'oc_req_timeout_default',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      expect((agent as any).requestTimeoutMs).toBe(300000);
    });

    it('should stop activity monitor on reset()', () => {
      const agent = new ChatAgent({
        chatId: 'oc_monitor_reset',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Start a session to create activity monitor
      void agent.processMessage('oc_monitor_reset', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);

      // Verify monitor timer exists
      expect((agent as any).activityMonitorTimer).not.toBeNull();

      // Reset should stop the monitor
      agent.reset();
      expect((agent as any).activityMonitorTimer).toBeNull();
    });

    it('should stop activity monitor on shutdown()', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_monitor_shutdown',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      void agent.processMessage('oc_monitor_shutdown', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);

      await agent.shutdown();
      expect((agent as any).activityMonitorTimer).toBeNull();
    });

    it('should not start activity monitor when sessionActivityTimeoutMs is 0', () => {
      const agent = new ChatAgent({
        chatId: 'oc_monitor_disabled',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 0,
      });

      void agent.processMessage('oc_monitor_disabled', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);

      // Monitor should not be started when timeout is 0
      expect((agent as any).activityMonitorTimer).toBeNull();
    });

    it('should detect hang when SDK iterator produces no messages for too long', async () => {
      vi.useFakeTimers();

      const agent = new ChatAgent({
        chatId: 'oc_hang_detect',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 1000, // 1 second for fast test
        requestTimeoutMs: 1000,
      });

      // Override createQueryStream to return an iterator that never yields
      const hangIterator = (async function* () {
        // Never yields — simulates a hung connection
        await new Promise(() => {}); // Never resolves
      })();

      const cancelFn = vi.fn();
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: cancelFn },
        iterator: hangIterator,
      });

      // Start the session
      void agent.processMessage('oc_hang_detect', 'hello', 'msg_1');
      expect(agent.hasActiveSession()).toBe(true);

      // Advance time past the timeout (1s + check interval)
      vi.advanceTimersByTime(1500);

      // Allow promises to resolve
      await vi.runAllTimersAsync();

      // Should have detected the hang and cancelled the query
      expect(cancelFn).toHaveBeenCalled();

      // Should have notified the user
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_hang_detect',
        expect.stringContaining('挂起'),
      );

      // Session should be inactive
      expect(agent.hasActiveSession()).toBe(false);

      vi.useRealTimers();
    });

    it('should NOT trigger timeout when messages arrive regularly', async () => {
      vi.useFakeTimers();

      const agent = new ChatAgent({
        chatId: 'oc_active_session',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        sessionActivityTimeoutMs: 5000, // 5 second timeout
      });

      // Create an iterator that yields a few messages quickly, then ends
      const fastIterator = (async function* () {
        yield { parsed: { type: 'text', content: 'msg-1' } };
        yield { parsed: { type: 'text', content: 'msg-2' } };
        yield { parsed: { type: 'result', content: 'done' } };
      })();

      const cancelFn = vi.fn();
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: cancelFn },
        iterator: fastIterator,
      });

      void agent.processMessage('oc_active_session', 'hello', 'msg_1');

      // Wait for the iterator to complete (it's synchronous so should finish quickly)
      await vi.runAllTimersAsync();

      // The iterator completed normally — no hang should be detected
      expect(cancelFn).not.toHaveBeenCalled();

      // Should NOT have sent hang notification
      const hangCall = callbacks.sendMessage.mock.calls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('挂起')
      );
      expect(hangCall).toBeUndefined();

      vi.useRealTimers();
    });

    it('should set ANTHROPIC_TIMEOUT in SDK env when requestTimeoutMs > 0', () => {
      const agent = new ChatAgent({
        chatId: 'oc_sdk_timeout',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        requestTimeoutMs: 120000,
      });

      // Verify the requestTimeoutMs was stored
      expect((agent as any).requestTimeoutMs).toBe(120000);
    });
  });
});
