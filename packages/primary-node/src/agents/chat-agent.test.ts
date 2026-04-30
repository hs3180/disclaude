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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all @disclaude/core dependencies
// Issue #2920: stderr symbol key for attaching stderr to Error objects
const STDERR_SYMBOL = Symbol('stderr');

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
  // Issue #2920: Real implementations for stderr utilities
  getErrorStderr: (error: unknown): string | undefined => {
    if (error instanceof Error) {
      return (error as any)[STDERR_SYMBOL];
    }
    return undefined;
  },
  isStartupFailure: (messageCount: number, elapsedMs: number): boolean => {
    return messageCount === 0 && elapsedMs < 10_000;
  },
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

  // ==========================================================================
  // Startup Failure Detection Tests (Issue #2920)
  // ==========================================================================

  describe('Issue #2920: startup failure detection in executeOnce', () => {
    it('should show "Agent 启动失败" when error occurs with 0 messages immediately', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_startup_fail',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Override queryOnce to throw immediately (0 messages, fast)
      const startupError = new Error('Claude Code process exited with code 1');
      (startupError as any)[STDERR_SYMBOL] = 'Error: MCP server "test" failed to initialize\ncommand is empty';

      (agent as any).queryOnce = vi.fn(() => {
        return (async function* () {
          throw startupError;
        })();
      });

      await expect(
        agent.executeOnce('oc_startup_fail', 'hello', 'msg_1')
      ).rejects.toThrow('Claude Code process exited with code 1');

      // Should show startup failure message, not generic session error
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_startup_fail',
        expect.stringContaining('Agent 启动失败'),
        'msg_1',
      );
      // Should contain the stderr diagnostic info
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_startup_fail',
        expect.stringContaining('MCP server'),
        'msg_1',
      );
      // Should NOT show generic "Session error" prefix
      expect(callbacks.sendMessage).not.toHaveBeenCalledWith(
        'oc_startup_fail',
        expect.stringContaining('❌ Session error'),
        'msg_1',
      );
    });

    it('should show "Agent 启动失败" with stderr diagnostic for startup errors', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_startup_stderr',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      const authError = new Error('process exited with code 1');
      (authError as any)[STDERR_SYMBOL] = 'Authentication failed: 401\nToken has expired';

      (agent as any).queryOnce = vi.fn(() => {
        return (async function* () {
          throw authError;
        })();
      });

      await expect(
        agent.executeOnce('oc_startup_stderr', 'hello')
      ).rejects.toThrow('process exited with code 1');

      const { calls } = callbacks.sendMessage.mock;
      expect(calls.length).toBe(1);
      expect(calls[0][1]).toContain('Agent 启动失败');
      expect(calls[0][1]).toContain('Authentication failed');
      expect(calls[0][1]).toContain('这是一次配置或环境错误');
    });

    it('should show "Session error" when error occurs after receiving messages', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_runtime_error',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Override queryOnce to yield a message then throw
      (agent as any).queryOnce = vi.fn(() => {
        return (async function* () {
          yield { parsed: { type: 'text', content: 'partial response' } };
          throw new Error('runtime crash');
        })();
      });

      await expect(
        agent.executeOnce('oc_runtime_error', 'hello')
      ).rejects.toThrow('runtime crash');

      // Should show generic session error (not startup failure)
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_runtime_error',
        expect.stringContaining('❌ Session error'),
        undefined,
      );
    });

    it('should show startup failure with error.message when no stderr available', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_startup_no_stderr',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Throw without stderr attached
      (agent as any).queryOnce = vi.fn(() => {
        return (async function* () {
          throw new Error('connection refused');
        })();
      });

      await expect(
        agent.executeOnce('oc_startup_no_stderr', 'hello')
      ).rejects.toThrow('connection refused');

      // Should still show startup failure, using error.message
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_startup_no_stderr',
        expect.stringContaining('Agent 启动失败: connection refused'),
        undefined,
      );
    });

    it('should show "Session error" with stderr for runtime errors with stderr', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_runtime_stderr',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      const runtimeError = new Error('API rate limit exceeded');
      (runtimeError as any)[STDERR_SYMBOL] = 'Rate limit: too many requests';

      // Yield a message first (makes it a runtime error, not startup)
      (agent as any).queryOnce = vi.fn(() => {
        return (async function* () {
          yield { parsed: { type: 'text', content: 'working...' } };
          throw runtimeError;
        })();
      });

      await expect(
        agent.executeOnce('oc_runtime_stderr', 'hello')
      ).rejects.toThrow('API rate limit exceeded');

      // Should show Session error with stderr
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_runtime_stderr',
        expect.stringContaining('❌ Session error: API rate limit exceeded'),
        undefined,
      );
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_runtime_stderr',
        expect.stringContaining('Rate limit'),
        undefined,
      );
    });
  });

  describe('Issue #2920: processIterator startup failure skips retry', () => {
    it('should skip retry and show startup failure when iterator fails immediately', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_pi_startup',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      const startupError = new Error('CLI exited with code 1');
      (startupError as any)[STDERR_SYMBOL] = 'MCP server "broken" failed: command not found';

      // Override createQueryStream to return iterator that throws immediately
      (agent as any).createQueryStream = vi.fn(() => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () {
          throw startupError;
        })(),
      }));

      // Start the agent loop
      void agent.processMessage('oc_pi_startup', 'hello', 'msg_1');

      // Wait for processIterator to complete
      await new Promise<void>(r => setTimeout(r, 200));

      // Should have sent startup failure message
      const allCalls = callbacks.sendMessage.mock.calls;
      const startupCall = allCalls.find((c: any[]) => typeof c[1] === 'string' && c[1].includes('Agent 启动失败'));
      expect(startupCall).toBeDefined();
      expect(startupCall![1]).toContain('MCP server');
      expect(startupCall![1]).toContain('这是一次配置或环境错误');

      // Session should be inactive (no retry attempted)
      expect(agent.hasActiveSession()).toBe(false);
    });

    it('should NOT show startup failure when messages were received before error', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_pi_runtime',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      const runtimeError = new Error('API error during conversation');

      // Override createQueryStream to yield some messages then throw
      (agent as any).createQueryStream = vi.fn(() => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () {
          yield { parsed: { type: 'assistant', content: 'Hello!' } };
          yield { parsed: { type: 'assistant', content: 'Let me help...' } };
          throw runtimeError;
        })(),
      }));

      void agent.processMessage('oc_pi_runtime', 'hello', 'msg_1');

      // Wait for processIterator to process messages and error
      await new Promise<void>(r => setTimeout(r, 200));

      // Should NOT show startup failure message
      const allCalls = callbacks.sendMessage.mock.calls;
      const startupCall = allCalls.find((c: any[]) => typeof c[1] === 'string' && c[1].includes('Agent 启动失败'));
      expect(startupCall).toBeUndefined();

      // Should show session error or restart message
      const errorCall = allCalls.find((c: any[]) =>
        typeof c[1] === 'string' && (c[1].includes('Session error') || c[1].includes('重新连接')),
      );
      expect(errorCall).toBeDefined();
    });
  });
});

// ============================================================================
// Inactivity Timeout Tests (Issue #2993)
// ============================================================================


/**
 * Creates a mock iterator that yields messages on demand and optionally hangs.
 */
function createMockIterator(options: {
  messages?: Array<{ type: string; content?: string }>;
  hang?: boolean;
  throwError?: Error;
  hangDurationMs?: number;
} = {}): AsyncGenerator<{ parsed: { type: string; content?: string } }> {
  const { messages = [], hang = false, throwError, hangDurationMs = 0 } = options;

  return (async function* () {
    for (const msg of messages) {
      if (hangDurationMs > 0) {
        await new Promise(resolve => setTimeout(resolve, hangDurationMs));
      }
      yield { parsed: msg };
    }

    if (hang) {
      // Hang forever — never resolves
      await new Promise(() => {});
    }

    if (throwError) {
      throw throwError;
    }
  })();
}

/**
 * Creates a minimal mock QueryHandle.
 */
function createMockQueryHandle() {
  let cancelled = false;
  let closed = false;

  return {
    cancel: vi.fn(() => { cancelled = true; }),
    close: vi.fn(() => { closed = true; }),
    isCancelled: () => cancelled,
    isClosed: () => closed,
  };
}

// ============================================================================
// Inactivity Timer Tests
// ============================================================================

describe('ChatAgent - session inactivity timeout (Issue #2993)', () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let queryHandle: ReturnType<typeof createMockQueryHandle>;

  beforeEach(() => {
    sendMessage = vi.fn().mockResolvedValue(undefined);
    queryHandle = createMockQueryHandle();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('inactivity timeout behavior', () => {
    it('should NOT fire timeout when messages arrive within the timeout period', async () => {
      vi.useFakeTimers();

      // Create an iterator that yields messages every 2 seconds (timeout is 5s)
      const messages: Array<{ type: string; content?: string }> = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ type: 'assistant', content: `msg-${i}` });
      }

      const iterator = createMockIterator({ messages, hangDurationMs: 2000 });

      // Start processing in background
      const processPromise = (async () => {
        // Simulate processIterator logic with watchdog
        let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
        const timeoutMs = 5000;

        const clearTimer = () => {
          if (inactivityTimer !== undefined) {
            clearTimeout(inactivityTimer);
            inactivityTimer = undefined;
          }
        };

        const resetTimer = () => {
          clearTimer();
          inactivityTimer = setTimeout(() => {
            sendMessage('TIMEOUT');
          }, timeoutMs);
          if (inactivityTimer.unref) {
            inactivityTimer.unref();
          }
        };

        try {
          resetTimer();
          for await (const { parsed } of iterator) {
            resetTimer();
            await sendMessage(parsed.content ?? '');
          }
        } finally {
          clearTimer();
        }
      })();

      // Advance time in 2-second increments (within 5s timeout)
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      await processPromise;

      // Timeout notification should NOT have been sent
      expect(sendMessage).not.toHaveBeenCalledWith('TIMEOUT');
      // Regular messages should have been sent
      expect(sendMessage).toHaveBeenCalledTimes(10);
    });

    it('should fire timeout when no messages arrive within the timeout period', async () => {
      vi.useFakeTimers();

      // Create an iterator that hangs (never yields)
      const iterator = createMockIterator({ hang: true });

      const timeoutMs = 5000;

      // Start processing in background
      void (async () => {
        let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

        const clearTimer = () => {
          if (inactivityTimer !== undefined) {
            clearTimeout(inactivityTimer);
            inactivityTimer = undefined;
          }
        };

        const resetTimer = () => {
          clearTimer();
          inactivityTimer = setTimeout(() => {
            sendMessage('TIMEOUT');
            queryHandle.cancel();
          }, timeoutMs);
          if (inactivityTimer.unref) {
            inactivityTimer.unref();
          }
        };

        try {
          resetTimer();
          for await (const _ of iterator) {
            resetTimer();
          }
        } finally {
          clearTimer();
        }
      })();

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(5000);

      // Timeout notification should have been sent
      expect(sendMessage).toHaveBeenCalledWith('TIMEOUT');
      // Query should have been cancelled
      expect(queryHandle.cancel).toHaveBeenCalled();

      // Cleanup: the promise will never resolve since iterator hangs forever
      // In real code, cancel() would break the loop
    });

    it('should reset timer on each message, preventing premature timeout', async () => {
      vi.useFakeTimers();

      // Create messages with 4-second gaps (just under 5s timeout)
      const messages: Array<{ type: string; content?: string }> = [
        { type: 'assistant', content: 'msg-1' },
        { type: 'assistant', content: 'msg-2' },
        { type: 'assistant', content: 'msg-3' },
      ];

      const iterator = createMockIterator({ messages, hangDurationMs: 4000 });
      const timeoutMs = 5000;

      const processPromise = (async () => {
        let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

        const clearTimer = () => {
          if (inactivityTimer !== undefined) {
            clearTimeout(inactivityTimer);
            inactivityTimer = undefined;
          }
        };

        const resetTimer = () => {
          clearTimer();
          inactivityTimer = setTimeout(() => {
            sendMessage('TIMEOUT');
          }, timeoutMs);
          if (inactivityTimer.unref) {
            inactivityTimer.unref();
          }
        };

        try {
          resetTimer();
          for await (const { parsed } of iterator) {
            resetTimer();
            await sendMessage(parsed.content ?? '');
          }
        } finally {
          clearTimer();
        }
      })();

      // Process 3 messages with 4s gaps (total 12s)
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(4000);
      }

      await processPromise;

      // Timeout should NOT have fired (each gap was under 5s)
      expect(sendMessage).not.toHaveBeenCalledWith('TIMEOUT');
      // All 3 messages should have been processed
      expect(sendMessage).toHaveBeenCalledTimes(3);
    });

    it('should clean up timer when iterator ends normally', async () => {
      vi.useFakeTimers();

      // Create an iterator that yields a result and ends
      const messages = [{ type: 'result', content: 'done' }];
      const iterator = createMockIterator({ messages });
      const timeoutMs = 5000;

      let timerCleared = false;

      const processPromise = (async () => {
        let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

        const clearTimer = () => {
          if (inactivityTimer !== undefined) {
            clearTimeout(inactivityTimer);
            inactivityTimer = undefined;
            timerCleared = true;
          }
        };

        const resetTimer = () => {
          clearTimer();
          inactivityTimer = setTimeout(() => {
            sendMessage('TIMEOUT');
          }, timeoutMs);
          if (inactivityTimer.unref) {
            inactivityTimer.unref();
          }
        };

        try {
          resetTimer();
          for await (const _msg of iterator) {
            resetTimer();
          }
        } finally {
          clearTimer();
        }
      })();

      await processPromise;

      // Timer should have been cleared
      expect(timerCleared).toBe(true);

      // Advance time well past timeout — timer should not fire
      await vi.advanceTimersByTimeAsync(10000);

      expect(sendMessage).not.toHaveBeenCalledWith('TIMEOUT');
    });

    it('should not set a timer when timeout is disabled (0ms)', () => {
      vi.useFakeTimers();

      const iterator = createMockIterator({ hang: true });
      const timeoutMs = 0; // Disabled

      let timerSet = false;

      void (async () => {
        let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

        const clearTimer = () => {
          if (inactivityTimer !== undefined) {
            clearTimeout(inactivityTimer);
            inactivityTimer = undefined;
          }
        };

        const resetTimer = () => {
          clearTimer();
          if (timeoutMs > 0) {
            inactivityTimer = setTimeout(() => {
              sendMessage('TIMEOUT');
            }, timeoutMs);
            if (inactivityTimer.unref) {
              inactivityTimer.unref();
            }
            timerSet = true;
          }
        };

        try {
          resetTimer();
          for await (const _ of iterator) {
            resetTimer();
          }
        } finally {
          clearTimer();
        }
      })();

      // Timer should never have been set
      expect(timerSet).toBe(false);
      expect(sendMessage).not.toHaveBeenCalledWith('TIMEOUT');
    });
  });
});

