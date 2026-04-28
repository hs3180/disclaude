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

// Issue #2920: Define SDKQueryError mock class outside the factory
// so tests can reference it directly
class MockSDKQueryError extends Error {
  stderr: string;
  originalError: Error;
  exitCode: number | null;
  constructor(originalError: Error, stderr: string) {
    super(originalError.message);
    this.name = 'SDKQueryError';
    this.stderr = stderr;
    this.originalError = originalError;
    const m = originalError.message.match(/exited with code (\d+)/);
    this.exitCode = m ? parseInt(m[1]) : null;
  }
}

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
  // Issue #2920: Mock startup diagnostic utilities
  SDKQueryError: MockSDKQueryError,
  isStartupFailure: vi.fn((error: any, messageCount: number, elapsedMs: number) => {
    if (!error) {return false;}
    if (messageCount > 0) {return false;}
    if (elapsedMs < 3000) {return true;}
    if (error.message?.toLowerCase().includes('exited with code')) {return true;}
    return false;
  }),
  extractStartupDetail: vi.fn((error: any) => {
    const stderr = error.stderr || '';
    if (stderr.includes('MCP server') && stderr.includes('failed to initialize')) {
      const m = stderr.match(/MCP server "([^"]+)"/);
      return `MCP server "${m?.[1] ?? 'unknown'}" 初始化失败`;
    }
    if (stderr.includes('401') || stderr.includes('authentication')) {
      return 'API 认证失败 (401): 令牌已过期或验证不正确';
    }
    return error.message || 'Unknown error';
  }),
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

  describe('Issue #2920: startup failure detection', () => {
    it('should show actionable error for startup failures without retrying', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_startup_fail',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Create an iterator that immediately throws (simulating startup failure)
      const startupError = new MockSDKQueryError(
        new Error('Claude Code process exited with code 1'),
        'Error: MCP server "bad-server" failed to initialize: command is empty'
      );

      async function* failingIterator() {
        throw startupError;
      }

      // Override createQueryStream to return a failing iterator
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: failingIterator(),
      });

      // Start session by sending a message
      void agent.processMessage('oc_startup_fail', 'hello', 'msg_1');

      // Wait for processIterator to handle the error
      await new Promise<void>(r => setTimeout(r, 100));

      // Verify session was deactivated
      expect(agent.hasActiveSession()).toBe(false);

      // Verify the error message sent to user contains actionable info
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_startup_fail',
        expect.stringContaining('Agent 启动失败'),
        'thread-root-123',
      );
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_startup_fail',
        expect.stringContaining('MCP server'),
        'thread-root-123',
      );

      // Verify it did NOT attempt restart (no "正在重新连接" message)
      const calls = callbacks.sendMessage.mock.calls.map((c: any) => c[1]);
      const hasRestartMessage = calls.some((msg: string) =>
        msg.includes('正在重新连接')
      );
      expect(hasRestartMessage).toBe(false);
    });

    it('should show actionable error for auth failure at startup', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_auth_fail',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      const authError = new MockSDKQueryError(
        new Error('Claude Code process exited with code 1'),
        'Error: 401 authentication failed: token expired'
      );

      async function* failingIterator() {
        throw authError;
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: failingIterator(),
      });

      void agent.processMessage('oc_auth_fail', 'hello', 'msg_1');
      await new Promise<void>(r => setTimeout(r, 100));

      expect(agent.hasActiveSession()).toBe(false);
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_auth_fail',
        expect.stringContaining('API 认证失败'),
        'thread-root-123',
      );
    });

    it('should still use restart mechanism for runtime errors (non-startup)', async () => {
      const agent = new ChatAgent({
        chatId: 'oc_runtime_err',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Create an iterator that yields some messages then throws
      // This simulates a RUNTIME error (not startup), since messages were received
      async function* runtimeErrorIterator() {
        yield { parsed: { type: 'text', content: 'some response' } };
        yield { parsed: { type: 'text', content: 'more response' } };
        throw new Error('Connection reset by peer');
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: runtimeErrorIterator(),
      });

      void agent.processMessage('oc_runtime_err', 'hello', 'msg_1');
      await new Promise<void>(r => setTimeout(r, 100));

      // Verify the old-style error message is used (not startup failure message)
      const calls = callbacks.sendMessage.mock.calls.map((c: any) => c[1]);
      const hasStartupFailMessage = calls.some((msg: string) =>
        msg.includes('Agent 启动失败')
      );
      expect(hasStartupFailMessage).toBe(false);

      // Should have the regular session error message
      const hasSessionError = calls.some((msg: string) =>
        msg.includes('Session error')
      );
      expect(hasSessionError).toBe(true);
    });
  });
});
