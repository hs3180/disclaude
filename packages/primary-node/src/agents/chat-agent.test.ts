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
vi.mock('@disclaude/core', () => {
  const BaseAgent = vi.fn().mockImplementation(function (this: any) {
    this.createSdkOptions = vi.fn(() => ({ mcpServers: {} }));
    this.createQueryStream = vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () {
        /* empty */
      })(),
    }));
    this.initialized = true;
    this.dispose = vi.fn();
    this.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });
  // Add dispose to prototype so super.dispose() works from ChatAgent (Issue #3745)
  BaseAgent.prototype.dispose = function (this: any) {
    if (!this.initialized) {
      return;
    }
    this.initialized = false;
  };
  return {
    Config: {
      getSessionRestoreConfig: vi.fn(() => ({
        historyDays: 1,
        maxContextLength: 50000,
      })),
      getMcpServersConfig: vi.fn(() => null),
    },
    BaseAgent,
    MessageBuilder: vi.fn().mockImplementation(() => ({
      buildEnhancedContent: vi.fn((input: any) => input.text),
    })),
    MessageChannel: vi.fn().mockImplementation(() => ({
      push: vi.fn().mockReturnValue(true),
      close: vi.fn(),
      generator: vi.fn(() =>
        (async function* () {
          /* empty */
        })()
      ),
    })),
    RestartManager: vi.fn().mockImplementation(() => ({
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      shouldRestart: vi.fn(() => ({
        allowed: false,
        reason: 'max_restarts_exceeded',
        restartCount: 3,
      })),
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
    // Issue #4192 L0: real-ish tagErrorCategory — classifies once and returns
    // {category, transient}. Covers the path under test (ECONNRESET → NETWORK,
    // transient=true), matching error-handler.ts keyword logic for that path.
    tagErrorCategory: (error: unknown): { category: string; transient: boolean } => {
      const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
      const isNetwork =
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('enotfound') ||
        msg.includes('econnrefused') ||
        msg.includes('network') ||
        msg.includes('connection');
      const category = isNetwork ? 'NETWORK' : msg.includes('timeout') ? 'TIMEOUT' : 'UNKNOWN';
      const transient = isNetwork || msg.includes('timeout');
      return { category, transient };
    },
  };
});

vi.mock('@disclaude/mcp-server', () => ({
  // Issue #4302: mirror the real production shape. createChannelMcpServer()
  // -> ClaudeSDKProvider.createMcpServer -> createSdkMcpServer, which returns a
  // `{ type: 'sdk', name, instance }` wrapper whose `.instance.close()` is what
  // dispose() tears down. (Previously `{ type: 'inline' }` with no instance, so
  // collectInlineMcpInstances() never matched — the #4302 wiring was untested.)
  createChannelMcpServer: vi.fn(() => ({
    type: 'sdk',
    name: 'channel-mcp',
    instance: { close: vi.fn().mockResolvedValue(undefined) },
  })),
}));

// Mock debug-group-service (Issue #3809)
const mockGetDebugGroup = vi.fn<(chatId?: string) => { chatId: string; setAt: number } | null>(
  () => null
);
vi.mock('../services/debug-group-service.js', () => ({
  getDebugGroupService: vi.fn(() => ({
    getDebugGroup: mockGetDebugGroup,
    setDebugGroup: vi.fn(),
    clearDebugGroup: vi.fn(),
    isDebugGroup: vi.fn(),
  })),
}));

import { ChatAgent } from './chat-agent.js';
import { createChannelMcpServer } from '@disclaude/mcp-server';

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
      void chatAgent.processMessage({ chatId: 'oc_wrong', payload: 'hello', messageId: 'msg_1' });
      expect(chatAgent.hasActiveSession()).toBe(false);
    });

    it('should start a session when processing first message', () => {
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'hello',
        messageId: 'msg_1',
      });
      expect(chatAgent.hasActiveSession()).toBe(true);
    });
  });

  describe('runOnce', () => {
    it('should throw when chatId does not match bound chatId', async () => {
      await expect(chatAgent.runOnce('oc_wrong', 'hello', 'msg_1')).rejects.toThrow(
        'cannot execute for oc_wrong'
      );
    });

    it('should complete successfully for matching chatId', async () => {
      await expect(chatAgent.runOnce('oc_test_chat', 'hello', 'msg_1')).resolves.toBeUndefined();
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

    it('Issue #3745: should synchronously close queryHandle and channel', () => {
      const closeHandle = vi.fn();
      const closeChannel = vi.fn();

      // Simulate an active agent with queryHandle and channel
      (chatAgent as any).queryHandle = { close: closeHandle, cancel: vi.fn() };
      (chatAgent as any).channel = { close: closeChannel };

      // Call the real ChatAgent dispose via prototype (BaseAgent mock overrides instance)
      ChatAgent.prototype.dispose.call(chatAgent);

      // Both should be closed synchronously before dispose() returns
      expect(closeHandle).toHaveBeenCalledTimes(1);
      expect(closeChannel).toHaveBeenCalledTimes(1);
      expect((chatAgent as any).queryHandle).toBeUndefined();
      expect((chatAgent as any).channel).toBeUndefined();
    });

    it('Issue #3745: should not throw when queryHandle/channel are undefined', () => {
      (chatAgent as any).queryHandle = undefined;
      (chatAgent as any).channel = undefined;
      expect(() => chatAgent.dispose()).not.toThrow();
    });

    it('Issue #4302: closes retained inline MCP instances on dispose', () => {
      const closeA = vi.fn().mockResolvedValue(undefined);
      const closeB = vi.fn().mockResolvedValue(undefined);
      (chatAgent as any).mcpInlineInstances = [{ close: closeA }, { close: closeB }];

      // The BaseAgent mock sets an instance `this.dispose = vi.fn()` that
      // shadows ChatAgent.prototype.dispose, so invoke the real method.
      (ChatAgent.prototype.dispose as unknown as (this: unknown) => void).call(chatAgent);

      expect(closeA).toHaveBeenCalledTimes(1);
      expect(closeB).toHaveBeenCalledTimes(1);
      // Field cleared after dispose.
      expect((chatAgent as any).mcpInlineInstances).toEqual([]);
    });

    it('Issue #4302: a rejecting inline MCP close() does not break dispose', () => {
      (chatAgent as any).mcpInlineInstances = [
        { close: vi.fn().mockRejectedValue(new Error('boom')) },
      ];
      expect(() =>
        (ChatAgent.prototype.dispose as unknown as (this: unknown) => void).call(chatAgent)
      ).not.toThrow();
    });

    it('Issue #4302: startAgentLoop retains the inline MCP instance; dispose() closes it', () => {
      // Drive the real wiring: buildMcpServers() (real) -> createChannelMcpServer
      // (mocked, production { type: 'sdk', instance } shape) -> collectInlineMcpInstances
      // (real) -> ChatAgent.mcpInlineInstances. processMessage() starts the agent
      // loop synchronously, so the field is populated before the next assertion.
      const close = vi.fn().mockResolvedValue(undefined);
      vi.mocked(createChannelMcpServer).mockReturnValueOnce({
        type: 'sdk',
        name: 'channel-mcp',
        instance: { close },
      });

      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'hi',
        messageId: 'msg_int_4302',
      });

      const retained = (chatAgent as any).mcpInlineInstances as unknown[];
      expect(retained).toHaveLength(1);
      expect((retained[0] as { close: unknown }).close).toBe(close);

      // dispose() closes the retained instance (inst.close() runs synchronously
      // inside Promise.resolve(...)) and clears the field.
      (ChatAgent.prototype.dispose as unknown as (this: unknown) => void).call(chatAgent);
      expect(close).toHaveBeenCalledTimes(1);
      expect((chatAgent as any).mcpInlineInstances).toEqual([]);
    });

    it('Issue #4302: startAgentLoop restart closes the previous inline MCP instance before replacing it', () => {
      // A restart re-enters startAgentLoop() (processIterator -> startAgentLoop
      // after the previous query ended). buildMcpServers() hands back a fresh
      // channel-mcp instance each call, so the previously retained instance is
      // now stale. Without the teardown it would be overwritten and its close()
      // would never run -> leak, the MCP analogue of #3378.
      const closeA = vi.fn().mockResolvedValue(undefined);
      vi.mocked(createChannelMcpServer).mockReturnValueOnce({
        type: 'sdk',
        name: 'channel-mcp',
        instance: { close: closeA },
      });

      // First loop start: retains instance A (not yet closed).
      (chatAgent as any).startAgentLoop();
      let retained = (chatAgent as any).mcpInlineInstances as unknown[];
      expect(retained).toHaveLength(1);
      expect((retained[0] as { close: unknown }).close).toBe(closeA);
      expect(closeA).not.toHaveBeenCalled();

      // Second loop start (restart): a fresh instance B is built. The stale
      // instance A must be closed before it is overwritten.
      const closeB = vi.fn().mockResolvedValue(undefined);
      vi.mocked(createChannelMcpServer).mockReturnValueOnce({
        type: 'sdk',
        name: 'channel-mcp',
        instance: { close: closeB },
      });
      (chatAgent as any).startAgentLoop();

      expect(closeA).toHaveBeenCalledTimes(1); // stale instance torn down
      expect(closeB).not.toHaveBeenCalled();   // current instance retained
      retained = (chatAgent as any).mcpInlineInstances as unknown[];
      expect(retained).toHaveLength(1);
      expect((retained[0] as { close: unknown }).close).toBe(closeB);
    });
  });

  describe('shutdown', () => {
    it('should complete shutdown without throwing', async () => {
      await expect(chatAgent.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('Issue #3776: updateCallbacks concurrency safety', () => {
    it('should apply callbacks immediately when agent is idle', () => {
      const newCallbacks = createMockCallbacks();
      const result = chatAgent.updateCallbacks(newCallbacks);
      expect(result).toBe(true);
    });

    it('should defer callbacks when agent is busy (taskCompletionPromise set)', () => {
      const newCallbacks = createMockCallbacks();

      // Simulate a running task by setting taskCompletionPromise
      let resolveTask!: () => void;
      (chatAgent as any).taskCompletionPromise = new Promise<void>((r) => {
        resolveTask = r;
      });

      const result = chatAgent.updateCallbacks(newCallbacks);
      expect(result).toBe(false);

      // Clean up
      resolveTask();
    });

    it('should apply deferred callbacks after task completes', async () => {
      const idleCallbacks = createMockCallbacks();
      const busyCallbacks = createMockCallbacks();

      // Set initial callbacks
      chatAgent.updateCallbacks(idleCallbacks);

      // Simulate a running task
      let resolveTask!: () => void;
      (chatAgent as any).taskCompletionPromise = new Promise<void>((r) => {
        resolveTask = r;
      });

      // Try to update while busy — should defer
      chatAgent.updateCallbacks(busyCallbacks);

      // Complete the task
      resolveTask();
      (chatAgent as any).taskCompletionPromise = undefined;

      // Wait for deferred update to apply
      await new Promise<void>((r) => setTimeout(r, 50));

      // Verify callbacks were applied (check via processMessage which uses callbacks)
      // The agent should use busyCallbacks now
      // We can verify by checking that the internal callbacks reference changed
      expect((chatAgent as any).callbacks).toBe(busyCallbacks);
    });

    it('should apply callbacks immediately again after task completes', () => {
      const newCallbacks = createMockCallbacks();

      // Simulate task completed (no taskCompletionPromise)
      (chatAgent as any).taskCompletionPromise = undefined;

      const result = chatAgent.updateCallbacks(newCallbacks);
      expect(result).toBe(true);
    });
  });

  describe('session lifecycle', () => {
    it('should allow reset after processMessage', () => {
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'hello',
        messageId: 'msg_1',
      });
      expect(chatAgent.hasActiveSession()).toBe(true);

      chatAgent.reset();
      expect(chatAgent.hasActiveSession()).toBe(false);
    });

    it('should allow new session after reset', () => {
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'first',
        messageId: 'msg_1',
      });
      expect(chatAgent.hasActiveSession()).toBe(true);

      chatAgent.reset();
      expect(chatAgent.hasActiveSession()).toBe(false);

      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'second',
        messageId: 'msg_2',
      });
      expect(chatAgent.hasActiveSession()).toBe(true);
    });
  });

  describe('GLM stall termination (Issue #3706)', () => {
    it('should send notice, record failure, suppress restart, preserve context', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_stall',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* stallResultIterator() {
        yield {
          parsed: {
            type: 'result',
            content: '⚠️ 上游模型响应超时（疑似 stall），已自动取消本次响应。请稍后重试。',
            terminatedReason: 'stall',
          },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: stallResultIterator(),
      });

      void agent.processMessage({ chatId: 'oc_stall', payload: 'hello', messageId: 'msg_1' });
      await new Promise<void>((r) => setTimeout(r, 150));

      // Notice delivered
      expect(
        localCallbacks.sendMessage.mock.calls.some(
          (c: any[]) => typeof c[1] === 'string' && c[1].includes('stall')
        )
      ).toBe(true);
      // recordFailure called (not recordSuccess)
      const rm = (agent as any).restartManager;
      expect(rm.recordFailure).toHaveBeenCalledWith('oc_stall', 'stall');
      expect(rm.shouldRestart).not.toHaveBeenCalled();
      // Session inactive (restart suppressed)
      expect(agent.hasActiveSession()).toBe(false);
      // Context preserved (deleteThreadRoot NOT called)
      expect((agent as any).conversationOrchestrator.deleteThreadRoot).not.toHaveBeenCalled();
    });
  });

  describe('Issue #4320: stop_reason surfaced in turn-complete log (Gap D)', () => {
    it('should log stopReason from parsed.metadata on turn completion', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_stop_reason',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* resultIterator() {
        yield {
          parsed: {
            type: 'result',
            content: '✅ Complete',
            metadata: { stopReason: 'tool_use' },
          },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: resultIterator(),
      });

      void agent.processMessage({
        chatId: 'oc_stop_reason',
        payload: 'do something',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 150));

      // Gap D: the 'Result received, turn complete' log carries stopReason
      // threaded from parsed.metadata.stopReason.
      const { logger } = agent as any;
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: 'tool_use' }),
        'Result received, turn complete'
      );
    });

    it('should log stopReason undefined when metadata has no stopReason', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_stop_reason_none',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* resultIterator() {
        yield {
          parsed: { type: 'result', content: '✅ Complete' },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: resultIterator(),
      });

      void agent.processMessage({
        chatId: 'oc_stop_reason_none',
        payload: 'do something',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 150));

      // When no stopReason is present the field is undefined (key present, value
      // absent) — an explicit marker rather than an omitted field.
      const { logger } = agent as any;
      const turnCompleteCall = logger.info.mock.calls.find(
        (c: any[]) => c[1] === 'Result received, turn complete'
      );
      expect(turnCompleteCall).toBeDefined();
      expect((turnCompleteCall as any[])[0].stopReason).toBeUndefined();
    });

    it('should log numTurns / durationMs / durationApiMs on turn completion (Issue #4320 part 2)', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_turn_stats',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* resultIterator() {
        yield {
          parsed: {
            type: 'result',
            content: '✅ Complete',
            metadata: { stopReason: 'end_turn', numTurns: 3, durationMs: 4200, durationApiMs: 3100 },
          },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: resultIterator(),
      });

      void agent.processMessage({
        chatId: 'oc_turn_stats',
        payload: 'do something',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 150));

      // Part 2: turn-level observability is surfaced alongside stopReason so a
      // premature end_turn (few round-trips / low API time) is diagnosable.
      const { logger } = agent as any;
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ numTurns: 3, durationMs: 4200, durationApiMs: 3100 }),
        'Result received, turn complete'
      );
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
      void agent.processMessage({
        chatId: 'oc_startup_fail',
        payload: 'hello',
        messageId: 'msg_1',
      });

      // Wait for processIterator to handle the error
      await new Promise<void>((r) => setTimeout(r, 100));

      // Should show startup failure message
      const sendMessageCalls = localCallbacks.sendMessage.mock.calls;
      const diagnosticCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败')
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
        (error as any).__stderr__ =
          'MCP server "amap-maps" failed to initialize\nCaused by: command is empty';
        throw error;
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: failingIteratorWithStderr(),
      });

      void agent.processMessage({
        chatId: 'oc_startup_stderr',
        payload: 'hello',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 100));

      // Should show stderr content in the diagnostic message
      const sendMessageCalls = localCallbacks.sendMessage.mock.calls;
      const diagnosticCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败')
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

      void agent.processMessage({
        chatId: 'oc_startup_no_retry',
        payload: 'hello',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 100));

      // Session should be inactive (not restarted)
      expect(agent.hasActiveSession()).toBe(false);

      // Should NOT see the restart/backoff messages
      const sendMessageCalls = localCallbacks.sendMessage.mock.calls;
      const restartCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('重新连接')
      );
      expect(restartCall).toBeUndefined();

      // Should NOT see circuit breaker message
      const circuitBreakerCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('暂停处理')
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
        await new Promise<void>((r) => setTimeout(r, 20));
        throw new Error('Runtime crash after messages');
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: runtimeErrorIterator(),
      });

      void agent.processMessage({
        chatId: 'oc_runtime_error',
        payload: 'hello',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 150));

      // Should show Session error (not startup failure)
      const sendMessageCalls = localCallbacks.sendMessage.mock.calls;
      const sessionErrorCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Session error')
      );
      expect(sessionErrorCall).toBeDefined();
      expect(sessionErrorCall![1]).toContain('Runtime crash after messages');

      // Should NOT show startup failure message
      const startupFailCall = sendMessageCalls.find(
        (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败')
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
          await new Promise<void>((r) => setTimeout(r, 10));
        }
      }

      // Override createQueryStream on the instance
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: slowIterator(),
      });

      // Start the session by sending a message
      void agent.processMessage({ chatId: 'oc_abort_test', payload: 'hello', messageId: 'msg_1' });

      // Wait a bit for some messages to process, then reset
      await new Promise<void>((r) => setTimeout(r, 50));
      agent.reset();

      // Wait for processIterator to complete
      await new Promise<void>((r) => setTimeout(r, 100));

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
          await new Promise<void>((r) => setTimeout(r, 10));
        }
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: slowIterator(),
      });

      void agent.processMessage({ chatId: 'oc_stop_test', payload: 'hello', messageId: 'msg_1' });

      // Wait then stop
      await new Promise<void>((r) => setTimeout(r, 50));
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
      void agent.processMessage({
        chatId: 'oc_reset_abort_test',
        payload: 'hello',
        messageId: 'msg_1',
      });
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

      void agent.processMessage({
        chatId: 'oc_stop_abort_test',
        payload: 'hello',
        messageId: 'msg_1',
      });
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

      void agent.processMessage({
        chatId: 'oc_shutdown_abort_test',
        payload: 'hello',
        messageId: 'msg_1',
      });
      const ac = (agent as any).abortController as AbortController;

      await agent.shutdown();
      expect(ac.signal.aborted).toBe(true);
      expect((agent as any).abortController).toBeNull();
    });
  });

  describe('Issue #3809: debug group forwarding', () => {
    it('should forward tool_use messages to debug group', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_user_chat',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Set up debug group
      mockGetDebugGroup.mockReturnValue({ chatId: 'oc_debug_group', setAt: Date.now() });

      // Create iterator that yields a tool_use message
      async function* toolUseIterator() {
        yield { parsed: { type: 'tool_use', content: '🔧 Using Read tool' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: toolUseIterator(),
      });

      void agent.processMessage({
        chatId: 'oc_user_chat',
        payload: 'read file',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 100));

      // Should forward to debug group with prefix
      const debugCalls = localCallbacks.sendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'oc_debug_group'
      );
      expect(debugCalls.length).toBe(1);
      expect(debugCalls[0][1]).toContain('[tool_use]');
      expect(debugCalls[0][1]).toContain('Using Read tool');

      // Should also send to user chat (non-topic)
      const userCalls = localCallbacks.sendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'oc_user_chat'
      );
      expect(userCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should forward tool_result messages to debug group', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_user_chat',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      mockGetDebugGroup.mockReturnValue({ chatId: 'oc_debug_group', setAt: Date.now() });

      async function* toolResultIterator() {
        yield { parsed: { type: 'tool_result', content: 'Result: file contents here' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: toolResultIterator(),
      });

      void agent.processMessage({
        chatId: 'oc_user_chat',
        payload: 'read file',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 100));

      const debugCalls = localCallbacks.sendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'oc_debug_group'
      );
      expect(debugCalls.length).toBe(1);
      expect(debugCalls[0][1]).toContain('[tool_result]');
    });

    it('should forward tool_progress messages to debug group', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_user_chat',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      mockGetDebugGroup.mockReturnValue({ chatId: 'oc_debug_group', setAt: Date.now() });

      async function* progressIterator() {
        yield { parsed: { type: 'tool_progress', content: 'Running bash (2.5s)' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: progressIterator(),
      });

      void agent.processMessage({
        chatId: 'oc_user_chat',
        payload: 'run command',
        messageId: 'msg_1',
      });
      await new Promise<void>((r) => setTimeout(r, 100));

      const debugCalls = localCallbacks.sendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'oc_debug_group'
      );
      expect(debugCalls.length).toBe(1);
      expect(debugCalls[0][1]).toContain('[tool_progress]');
    });

    it('should NOT forward text or result messages to debug group', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_user_chat',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      mockGetDebugGroup.mockReturnValue({ chatId: 'oc_debug_group', setAt: Date.now() });

      async function* textIterator() {
        yield { parsed: { type: 'text', content: 'Hello user' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: textIterator(),
      });

      void agent.processMessage({ chatId: 'oc_user_chat', payload: 'hello', messageId: 'msg_1' });
      await new Promise<void>((r) => setTimeout(r, 100));

      // No messages should go to debug group
      const debugCalls = localCallbacks.sendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'oc_debug_group'
      );
      expect(debugCalls.length).toBe(0);
    });

    it('should not forward when no debug group is set', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_user_chat',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // No debug group set (default mock returns null)
      mockGetDebugGroup.mockReturnValue(null);

      async function* toolUseIterator() {
        yield { parsed: { type: 'tool_use', content: 'Using tool' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: toolUseIterator(),
      });

      void agent.processMessage({ chatId: 'oc_user_chat', payload: 'test', messageId: 'msg_1' });
      await new Promise<void>((r) => setTimeout(r, 100));

      // No messages to debug group
      const debugCalls = localCallbacks.sendMessage.mock.calls.filter(
        (call: any[]) => call[0] !== 'oc_user_chat'
      );
      expect(debugCalls.length).toBe(0);
    });

    it('should not forward when current chat IS the debug group (prevent loop)', async () => {
      const localCallbacks = createMockCallbacks();
      // Chat is the debug group itself
      const agent = new ChatAgent({
        chatId: 'oc_debug_group',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      mockGetDebugGroup.mockReturnValue({ chatId: 'oc_debug_group', setAt: Date.now() });

      async function* toolUseIterator() {
        yield { parsed: { type: 'tool_use', content: 'Using tool' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: toolUseIterator(),
      });

      void agent.processMessage({ chatId: 'oc_debug_group', payload: 'test', messageId: 'msg_1' });
      await new Promise<void>((r) => setTimeout(r, 100));

      // Should only send to user chat (which is the same as debug group)
      // but NOT double-forward
      const allCalls = localCallbacks.sendMessage.mock.calls;
      // Only normal user-facing calls, no extra debug forwarding
      expect(allCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should forward intermediate messages even in topic threads (normally filtered)', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_topic_chat',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Set as topic type
      (agent as any).chatType = 'topic';
      mockGetDebugGroup.mockReturnValue({ chatId: 'oc_debug_group', setAt: Date.now() });

      async function* toolUseIterator() {
        yield { parsed: { type: 'tool_use', content: 'Using tool in topic' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: toolUseIterator(),
      });

      void agent.processMessage({ chatId: 'oc_topic_chat', payload: 'test', messageId: 'msg_1' });
      await new Promise<void>((r) => setTimeout(r, 100));

      // Debug group should still get the forwarded message
      const debugCalls = localCallbacks.sendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'oc_debug_group'
      );
      expect(debugCalls.length).toBe(1);
      expect(debugCalls[0][1]).toContain('Using tool in topic');

      // User chat should NOT receive the filtered intermediate message
      const userCalls = localCallbacks.sendMessage.mock.calls.filter(
        (call: any[]) =>
          call[0] === 'oc_topic_chat' &&
          typeof call[1] === 'string' &&
          call[1].includes('Using tool')
      );
      expect(userCalls.length).toBe(0);
    });
  });

  describe('Issue #3985: isBusy / isProcessingMessage', () => {
    it('should return false for isBusy initially', () => {
      expect(chatAgent.isBusy).toBe(false);
    });

    it('should return true for isBusy when processing a message', () => {
      // Skip the async history loading so processMessage reaches the push synchronously
      (chatAgent as any).historyManager.firstMessageHistoryLoaded = true;
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'hello',
        messageId: 'msg_1',
      });
      expect(chatAgent.isBusy).toBe(true);
    });

    it('should reset isProcessingMessage on reset', () => {
      (chatAgent as any).historyManager.firstMessageHistoryLoaded = true;
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'hello',
        messageId: 'msg_1',
      });
      expect(chatAgent.isBusy).toBe(true);

      chatAgent.reset();
      expect(chatAgent.isBusy).toBe(false);
    });

    it('should reset isProcessingMessage on shutdown', async () => {
      (chatAgent as any).historyManager.firstMessageHistoryLoaded = true;
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'hello',
        messageId: 'msg_1',
      });
      expect(chatAgent.isBusy).toBe(true);

      await chatAgent.shutdown();
      expect(chatAgent.isBusy).toBe(false);
    });

    it('should reset isProcessingMessage when channel push is rejected', () => {
      (chatAgent as any).historyManager.firstMessageHistoryLoaded = true;
      // Start a session to create a channel
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'hello',
        messageId: 'msg_1',
      });
      expect(chatAgent.isBusy).toBe(true);

      // Simulate channel rejection by making push return false
      const { channel } = chatAgent as any;
      channel.push = vi.fn().mockReturnValue(false);

      // Send another message — should be rejected and isProcessingMessage reset
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'second',
        messageId: 'msg_2',
      });
      expect(chatAgent.isBusy).toBe(false);
    });

    it('should reset isProcessingMessage after result is received', async () => {
      // Create an iterator that yields a result message then ends
      async function* resultIterator() {
        yield { type: 'result', subtype: 'success', result: 'done' };
      }

      (chatAgent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: resultIterator(),
      });

      (chatAgent as any).historyManager.firstMessageHistoryLoaded = true;
      void chatAgent.processMessage({
        chatId: 'oc_test_chat',
        payload: 'hello',
        messageId: 'msg_1',
      });
      expect(chatAgent.isBusy).toBe(true);

      // Wait for the result to be processed
      await new Promise<void>((r) => setTimeout(r, 100));
      expect(chatAgent.isBusy).toBe(false);
    });
  });

  describe('Issue #4194: empty-turn detection across persistent turns', () => {
    it('should fire the empty-turn warn on a follow-up turn with no output', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_empty_turn2',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Two turns within one persistent processIterator run. startAgentLoop is
      // only called when !isSessionActive, so processIterator stays alive across
      // turns and the iterator stays open between them:
      //   turn 1: a real user-visible reply, then the ✅ Complete marker
      //   turn 2: ONLY the ✅ Complete marker (no reply, no tools) — empty turn
      async function* twoTurnIterator() {
        yield { parsed: { type: 'text', content: 'Hello! Real reply.' }, raw: {} };
        yield {
          parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 1.0k' },
          raw: {},
        };
        yield {
          parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: twoTurnIterator(),
      });
      // The BaseAgent mock above does not define isAgentTeamsEnabled() (inherited
      // from the real BaseAgent in production). Stub it so the #3706 zero-tool
      // check at the result marker doesn't throw and short-circuit the loop
      // before the #4194 empty-turn check runs.
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({
        chatId: 'oc_empty_turn2',
        payload: 'hi',
        messageId: 'msg_1',
      });

      // The #4194 warn must fire on turn 2. Without the per-turn counter reset
      // in the result branch, userVisibleOutputCount would stay at 1 from turn 1
      // and the empty-turn check could never be true again on follow-up turns —
      // exactly the scenario #4194 reports. (Turn 1 has real output, so it does
      // not fire the warn; only turn 2 does.)
      const warnSpy = (agent as any).logger.warn;
      await vi.waitFor(
        () => {
          expect(warnSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('Issue #4194')
          );
        },
        { timeout: 1000, interval: 20 }
      );
    });

    it('Issue #4258 (part 1): should send a diagnostic notice on an empty turn', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_empty_turn_notify',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Single empty turn: only the ✅ Complete result marker, no real reply,
      // no tool calls → userVisibleOutputCount stays 0 and the empty-turn
      // branch fires the diagnostic notice.
      async function* emptyTurnIterator() {
        yield {
          parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: emptyTurnIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({
        chatId: 'oc_empty_turn_notify',
        payload: 'hi',
        messageId: 'msg_1',
      });

      // The diagnostic notice must be sent via sendMessage so the user is told
      // the turn produced nothing, rather than the bot appearing to ignore them.
      await vi.waitFor(
        () => {
          const diagnosticCall = localCallbacks.sendMessage.mock.calls.find(
            (call: unknown[]) =>
              typeof call[1] === 'string' && (call[1] as string).includes('未产生任何可见输出')
          );
          expect(diagnosticCall).toBeDefined();
          expect(diagnosticCall![0]).toBe('oc_empty_turn_notify');
          // The notice must be threaded to the turn's thread root (passed as
          // sendMessage's parentMessageId, i.e. the 3rd argument).
          expect(diagnosticCall![2]).toBe('thread-root-123');
        },
        { timeout: 1000, interval: 20 }
      );
    });

    it('Issue #4260 (test 2): a system→result-only stream is still detected as an empty turn', async () => {
      // #4194's reported scenario is a stream that emits a `system` SDK message
      // then `result` with no assistant content / no tool calls. The adapter's
      // `case 'system'` (message-adapter.ts) renders unhandled system subtypes
      // (task_started / teammate_* — the GLM + Agent Teams flood) as
      // `{ type: 'text', content: '', role: 'system' }`: content stays empty so
      // chat-agent.ts never forwards it to the user (that contract is locked by
      // message-adapter.test.ts "D1"). processIterator only counts events with
      // truthy `parsed.content` (excluding the ✅ Complete marker), so this
      // empty-content `text` event must NOT increment userVisibleOutputCount —
      // otherwise the empty-turn check (`userVisibleOutputCount === 0 &&
      // toolCallCount === 0`) would never fire for this stream shape and the bot
      // would silently report only ✅ Complete. No existing test feeds an
      // adapter-rendered system flood event; this fills that gap (Issue #4260
      // test 2 — the slice the issue marks "independent and can land first").
      // True regression: fails if an empty-content `text` event starts being
      // counted as user-visible output — e.g. if the `if (parsed.content)` gate
      // were replaced by a type-based check (`if (parsed.type === 'text')`),
      // count → 1 → empty-turn branch skipped → no diagnostic (regressing #4194).
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_empty_turn_system',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* systemResultIterator() {
        // Exact adapter output for an unhandled system subtype (e.g. task_started):
        // `{ type: 'text', content: '', role: 'system', metadata: { systemSubtype } }`
        // (see message-adapter.ts `case 'system'`, locked by message-adapter.test.ts "D1").
        yield {
          parsed: { type: 'text', content: '', role: 'system', metadata: { systemSubtype: 'task_started' } },
          raw: {},
        };
        // result marker only — no assistant text, no tool_use → empty turn.
        yield {
          parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: systemResultIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({
        chatId: 'oc_empty_turn_system',
        payload: 'hi',
        messageId: 'msg_1',
      });

      // The empty-turn diagnostic notice must fire despite the empty-content
      // `text` event (the adapter's rendering of a system flood msg) — proving
      // it did not count as user-visible output. If it had (count=1), the
      // empty-turn branch would be skipped and no notice would be sent,
      // regressing #4194's system→result-only scenario.
      await vi.waitFor(() => {
        const diagnosticCall = localCallbacks.sendMessage.mock.calls.find(
          (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('未产生任何可见输出'),
        );
        expect(diagnosticCall).toBeDefined();
        expect(diagnosticCall![0]).toBe('oc_empty_turn_system');
        // The notice must be threaded to the turn's thread root (passed as
        // sendMessage's parentMessageId, i.e. the 3rd argument) — same contract
        // as the sibling #4258 diagnostic-notice test.
        expect(diagnosticCall![2]).toBe('thread-root-123');
      }, { timeout: 1000, interval: 20 });
    });
  });

  describe('Issue #4192 (L0): classify restart-triggering error', () => {
    it('should log the classified error category + transient flag when the loop ends on an error', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_classify_err',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Yield one message first (so messageCount > 0 ⇒ not a startup failure),
      // then throw a transient network error → reaches the restart-decision
      // path where the classification log fires.
      async function* yieldThenThrowIterator() {
        yield { parsed: { type: 'text', content: 'partial reply' }, raw: {} };
        const err = new Error('write ECONNRESET');
        (err as any).code = 'ECONNRESET';
        throw err;
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: yieldThenThrowIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({
        chatId: 'oc_classify_err',
        payload: 'hi',
        messageId: 'msg_1',
      });

      const warnSpy = (agent as any).logger.warn;
      await vi.waitFor(
        () => {
          const classifyCall = warnSpy.mock.calls.find(
            (call: unknown[]) =>
              typeof call[1] === 'string' && (call[1] as string).includes('classified error')
          );
          expect(classifyCall).toBeDefined();
          // Context object (1st arg) carries the classification verdict.
          expect((classifyCall![0] as Record<string, unknown>).errorCategory).toBe('NETWORK');
          expect((classifyCall![0] as Record<string, unknown>).transient).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );
    });

    it('Issue #4258 (part 2 / ③): should record failure (not success) on an empty turn', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_empty_turn_failed',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Single empty turn: only the ✅ Complete result marker, no real reply,
      // no tool calls → userVisibleOutputCount stays 0 and the empty-turn
      // branch must mark the turn as failed.
      async function* emptyTurnIterator() {
        yield {
          parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: emptyTurnIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({
        chatId: 'oc_empty_turn_failed',
        payload: 'hi',
        messageId: 'msg_1',
      });

      const rm = (agent as any).restartManager;
      // Acceptance criterion (③): recordSuccess is NOT called for a turn
      // classified as failed; recordFailure is called instead so a chronically
      // broken session can still trip the restart circuit (#4194).
      await vi.waitFor(() => {
        expect(rm.recordFailure).toHaveBeenCalledWith('oc_empty_turn_failed', 'empty-turn');
      }, { timeout: 1000, interval: 20 });
      expect(rm.recordSuccess).not.toHaveBeenCalled();
    });

  });
});
