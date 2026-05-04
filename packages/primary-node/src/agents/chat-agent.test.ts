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
  // Issue #2920: Real implementations for startup failure detection
  isStartupFailure: (messageCount: number, elapsedMs: number) => {
    return messageCount === 0 && elapsedMs < 10_000;
  },
  getErrorStderr: (error: unknown) => {
    if (error instanceof Error) {
      return (error as any).__stderr__;
    }
    return undefined;
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logTiming: vi.fn(),
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

  describe('runOnce', () => {
    it('should throw when chatId does not match bound chatId', async () => {
      await expect(
        chatAgent.runOnce('oc_wrong', 'hello', 'msg_1')
      ).rejects.toThrow('cannot execute for oc_wrong');
    });

    it('should complete successfully for matching chatId', async () => {
      await expect(
        chatAgent.runOnce('oc_test_chat', 'hello', 'msg_1')
      ).resolves.toBeUndefined();
    });

    it('should set onceMode during execution', async () => {
      // Verify onceMode is cleaned up after execution
      await chatAgent.runOnce('oc_test_chat', 'hello', 'msg_1');
      expect((chatAgent as any).onceMode).toBe(false);
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

  describe('Issue #2920: startup failure detection and diagnostics', () => {
    it('should detect startup failure and show diagnostic message (no stderr)', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_startup_fail',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Iterator that throws immediately (0 messages = startup failure)
      async function* failingIterator() {
        throw new Error('Claude Code process exited with code 1');
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: failingIterator(),
      });

      // Trigger the agent loop
      void agent.processMessage('oc_startup_fail', 'hello', 'msg_1');

      // Wait for processIterator to handle the error
      await new Promise<void>(r => setTimeout(r, 100));

      // Should show startup failure message
      const sendMessageCalls = localCallbacks.sendMessage.mock.calls;
      const diagnosticCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败'),
      );
      expect(diagnosticCall).toBeDefined();
      expect(diagnosticCall![1]).toContain('Claude Code process exited with code 1');
      expect(diagnosticCall![1]).toContain('配置或环境错误');
      expect(diagnosticCall![1]).toContain('/reset');

      // Session should be inactive
      expect(agent.hasActiveSession()).toBe(false);

      // onDone should be called
      expect(localCallbacks.onDone).toHaveBeenCalled();
    });

    it('should include stderr content in startup failure message', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_startup_stderr',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Iterator that throws with stderr attached
      async function* failingIteratorWithStderr() {
        const error = new Error('CLI process exited with code 1');
        (error as any).__stderr__ = 'MCP server "amap-maps" failed to initialize\nCaused by: command is empty';
        throw error;
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: failingIteratorWithStderr(),
      });

      void agent.processMessage('oc_startup_stderr', 'hello', 'msg_1');
      await new Promise<void>(r => setTimeout(r, 100));

      // Should show stderr content in the diagnostic message
      const sendMessageCalls = localCallbacks.sendMessage.mock.calls;
      const diagnosticCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败'),
      );
      expect(diagnosticCall).toBeDefined();
      expect(diagnosticCall![1]).toContain('MCP server "amap-maps"');
      expect(diagnosticCall![1]).toContain('command is empty');
    });

    it('should NOT trigger restart/circuit-breaker for startup failure', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_startup_no_retry',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* failingIterator() {
        throw new Error('Startup crash');
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: failingIterator(),
      });

      void agent.processMessage('oc_startup_no_retry', 'hello', 'msg_1');
      await new Promise<void>(r => setTimeout(r, 100));

      // Session should be inactive (not restarted)
      expect(agent.hasActiveSession()).toBe(false);

      // Should NOT see the restart/backoff messages
      const sendMessageCalls = localCallbacks.sendMessage.mock.calls;
      const restartCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('重新连接'),
      );
      expect(restartCall).toBeUndefined();

      // Should NOT see circuit breaker message
      const circuitBreakerCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('暂停处理'),
      );
      expect(circuitBreakerCall).toBeUndefined();
    });

    it('should treat runtime error (with messages) as normal error, not startup failure', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_runtime_error',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Iterator that yields messages before throwing (runtime error)
      async function* runtimeErrorIterator() {
        yield { parsed: { type: 'text', content: 'Hello from agent' } };
        await new Promise<void>(r => setTimeout(r, 20));
        throw new Error('Runtime crash after messages');
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: runtimeErrorIterator(),
      });

      void agent.processMessage('oc_runtime_error', 'hello', 'msg_1');
      await new Promise<void>(r => setTimeout(r, 150));

      // Should show Session error (not startup failure)
      const sendMessageCalls = localCallbacks.sendMessage.mock.calls;
      const sessionErrorCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Session error'),
      );
      expect(sessionErrorCall).toBeDefined();
      expect(sessionErrorCall![1]).toContain('Runtime crash after messages');

      // Should NOT show startup failure message
      const startupFailCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败'),
      );
      expect(startupFailCall).toBeUndefined();

      // Session should be inactive
      expect(agent.hasActiveSession()).toBe(false);
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
});
