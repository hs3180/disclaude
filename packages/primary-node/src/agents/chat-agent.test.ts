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
vi.mock('@disclaude/core', async (importOriginal) => {
  // Issue #4399: StreamingReplyDriver is exercised for real (the wiring under
  // test). Pull the real class from the actual module; everything else stays
  // explicitly mocked below.
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  const BaseAgent = vi.fn().mockImplementation(function (this: any) {
    this.createSdkOptions = vi.fn((extra: Record<string, unknown> = {}) => extra);
    this.createQueryStream = vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () {
        /* empty */
      })(),
    }));
    // Issue #4391 (part 2 review): deliberately NOT forcing
    // `this.initialized = true` here — production BaseAgent never sets it
    // true, and forcing it in this mock masked the dead `!this.initialized`
    // disposed-guard in the empty-turn replay (the guard only ever worked
    // under this mock).
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
    },
    BaseAgent,
    // Issue #4399: real driver so the streaming wiring is exercised end-to-end.
    StreamingReplyDriver: actual.StreamingReplyDriver,
    // Issue #4649 (review ①): real class — ChatAgent throws it from
    // setTurnPending and the tests below assert instanceof on the exact
    // class the production import resolves to.
    TurnSupersededError: actual.TurnSupersededError,
    // Issue #4391: real policy — the reset+replay bounding under test.
    EmptyTurnRetryPolicy: actual.EmptyTurnRetryPolicy,
    MessageBuilder: vi.fn().mockImplementation(() => ({
      // Issue #4391 (§6 history re-injection): append the chat-history
      // context (when present) to the built content so tests can verify the
      // consume-once stash actually flowed into the pushed payload.
      // Issue #4391 (part 3 review nit): mirror the production builder's TWO
      // history sections (chat history + persisted history) so tests can also
      // catch duplicated context in the pushed payload — the single-section
      // stub below rendered persistedHistoryContext invisible here.
      buildEnhancedContent: vi.fn((input: any) => {
        const sections = [input.text];
        if (input.persistedHistoryContext) {
          sections.push(`## Previous Session Context\n\n${input.persistedHistoryContext}`);
        }
        if (input.chatHistoryContext) {
          sections.push(`## Recent Chat History\n\n${input.chatHistoryContext}`);
        }
        return sections.join('\n');
      }),
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

  });

  describe('MCP-free startup (Issue #4652)', () => {
    it('starts the production query path without constructing or injecting mcpServers', () => {
      (chatAgent as any).startAgentLoop();

      const createSdkOptions = (chatAgent as any).createSdkOptions as ReturnType<typeof vi.fn>;
      expect(createSdkOptions).toHaveBeenCalledTimes(1);
      expect(createSdkOptions.mock.calls[0][0]).not.toHaveProperty('mcpServers');
      expect((chatAgent as any).createQueryStream).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ mcpServers: expect.anything() }),
      );
    });
  });

  // Issue #4448 (direction #1): a chat bound to a directory that does not
  // exist silently falls back to the workspace cwd. The structured cwdResolver
  // must turn that into a user-visible warning pushed to the chat — the plain
  // cwdProvider can't distinguish bound-missing from unbound.
  describe('bound-missing cwd fallback warning (Issue #4448 direction #1)', () => {
    // `resolverStates` lets the mutating tests flip the resolution between
    // startAgentLoop() calls (restart cycles) — the closures read the current
    // state on each call, like ProjectManager.resolveCwd re-checking the disk.
    const mkAgent = (
      reason: 'unbound' | 'bound' | 'bound-missing',
      resolverStates?: Array<'unbound' | 'bound' | 'bound-missing'>
    ) => {
      const states = resolverStates ?? [reason];
      let call = 0;
      const stateAt = () => states[Math.min(call, states.length - 1)];
      return new ChatAgent({
        chatId: 'oc_test_chat',
        callbacks,
        apiKey: 'test-key',
        model: 'test-model',
        provider: 'anthropic',
        apiBaseUrl: 'https://api.example.com',
        cwdProvider: (chatId: string) =>
          chatId === 'oc_test_chat' && stateAt() === 'bound' ? '/bound/project/dir' : undefined,
        cwdResolver: (_chatId: string) => {
          const current = stateAt();
          call += 1;
          return {
            effectiveCwd: current === 'bound' ? '/bound/project/dir' : undefined,
            boundWorkingDir: current === 'unbound' ? undefined : '/gone/project/dir',
            reason: current,
          };
        },
      });
    };

    it('pushes a user-visible warning when the bound directory is missing', () => {
      const agent = mkAgent('bound-missing');
      (agent as any).startAgentLoop();

      expect(callbacks.sendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text] = callbacks.sendMessage.mock.calls[0] as unknown as [
        string,
        string,
      ];
      expect(chatId).toBe('oc_test_chat');
      expect(text).toContain('/gone/project/dir');
      expect(text).toContain('回退');
    });

    it('does not warn when the binding resolves cleanly (bound)', () => {
      const agent = mkAgent('bound');
      (agent as any).startAgentLoop();

      expect(callbacks.sendMessage).not.toHaveBeenCalled();
    });

    it('does not warn when the chat is unbound (workspace is expected)', () => {
      const agent = mkAgent('unbound');
      (agent as any).startAgentLoop();

      expect(callbacks.sendMessage).not.toHaveBeenCalled();
    });

    it('a rejecting sendMessage does not break the agent loop start', () => {
      const sendErr = callbacks.sendMessage as unknown as ReturnType<typeof vi.fn>;
      sendErr.mockRejectedValueOnce(new Error('channel down'));

      const agent = mkAgent('bound-missing');
      // Must not throw despite the rejected warning send (fire-and-forget).
      expect(() => (agent as any).startAgentLoop()).not.toThrow();
    });

    // Nit (restart re-announce): startAgentLoop() re-runs on restart cycles —
    // the same missing target must not warn the chat twice per agent instance.
    it('does not re-warn the same missing directory on a restart cycle', () => {
      const agent = mkAgent('bound-missing', ['bound-missing', 'bound-missing']);
      (agent as any).startAgentLoop(); // first spawn → warns
      (agent as any).startAgentLoop(); // restart cycle → same target, stays quiet

      expect(callbacks.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('warns again after the binding recovers and the target goes missing again', () => {
      const agent = mkAgent('bound-missing', ['bound-missing', 'bound', 'bound-missing']);
      (agent as any).startAgentLoop(); // missing → warns
      (agent as any).startAgentLoop(); // recovered (bound) → no warn, fingerprint cleared
      (agent as any).startAgentLoop(); // missing again → warns again

      expect(callbacks.sendMessage).toHaveBeenCalledTimes(2);
    });

    // Nit (double resolveCwd): when cwdResolver is present it subsumes
    // cwdProvider — the provider must not be consulted at all.
    it('uses cwdResolver alone and does not call cwdProvider (no double resolveCwd)', () => {
      const cwdProvider = vi.fn(() => '/bound/project/dir');
      const agent = new ChatAgent({
        chatId: 'oc_test_chat',
        callbacks,
        apiKey: 'test-key',
        model: 'test-model',
        provider: 'anthropic',
        apiBaseUrl: 'https://api.example.com',
        cwdProvider,
        cwdResolver: () => ({
          effectiveCwd: '/bound/project/dir',
          boundWorkingDir: '/bound/project/dir',
          reason: 'bound',
        }),
      });
      (agent as any).startAgentLoop();

      expect(cwdProvider).not.toHaveBeenCalled();
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

      // Wait for deferred update to apply (Issue #4394: deterministic wait
      // instead of a fixed 50ms wall-clock setTimeout).
      await vi.waitFor(
        () => {
          expect((chatAgent as any).callbacks).toBe(busyCallbacks);
        },
        { timeout: 1000, interval: 20 }
      );

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

      // Notice delivered (Issue #4394: deterministic wait for the stall notice
      // instead of a fixed 150ms wall-clock setTimeout).
      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.some(
              (c: any[]) => typeof c[1] === 'string' && c[1].includes('stall')
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );
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

  describe('Empty-stream termination (Issue #4442 part 3)', () => {
    it('should deliver the ❌ notice, recordFailure, resolve the turn, and not auto-restart', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_empty_stream',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Provider-level synthesized terminal result: the SDK query ended cleanly
      // with zero messages and the in-request retries were exhausted
      // (terminatedReason 'empty-stream' hoisted to top-level parsed field by
      // convertToLegacyFormat, same shape as the stall path).
      async function* emptyStreamResultIterator() {
        yield {
          parsed: {
            type: 'result',
            content: '❌ 上游返回了空响应（200 但零内容事件），本次会话未产生任何输出。请稍后重试。',
            terminatedReason: 'empty-stream',
          },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: emptyStreamResultIterator(),
      });

      void agent.processMessage({ chatId: 'oc_empty_stream', payload: 'hello', messageId: 'msg_1' });

      // The ❌ notice is delivered through the generic content-send path.
      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.some(
              (c: any[]) => typeof c[1] === 'string' && c[1].includes('空响应')
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );
      // recordFailure called with the empty-stream reason (not recordSuccess).
      const rm = (agent as any).restartManager;
      expect(rm.recordFailure).toHaveBeenCalledWith('oc_empty_stream', 'empty-stream');
      expect(rm.shouldRestart).not.toHaveBeenCalled();
      // Session inactive (restart suppressed)
      expect(agent.hasActiveSession()).toBe(false);
      // Context preserved (deleteThreadRoot NOT called).
      expect((agent as any).conversationOrchestrator.deleteThreadRoot).not.toHaveBeenCalled();
    });
  });

  describe('Issue #4626: sendMessage failure isolated from the agent loop', () => {
    /** Axios-style Feishu 400 (invalid receive_id) — the incident's error shape. */
    function feishu400(): Error {
      const err = new Error('Request failed with status code 400');
      (err as any).response = {
        status: 400,
        data: { code: 230001, msg: 'receive_id is invalid' },
      };
      return err;
    }

    /** Build an agent whose SDK iterator yields the given parsed messages. */
    function makeAgent(
      parsedMessages: Array<Record<string, unknown>>,
      sendMessageImpl: () => Promise<void>
    ) {
      const localCallbacks = createMockCallbacks();
      (localCallbacks.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(sendMessageImpl);
      const agent = new ChatAgent({
        chatId: 'oc_sendfail',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      async function* scriptedIterator() {
        for (const parsed of parsedMessages) {
          yield { parsed, raw: {} };
        }
      }
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: scriptedIterator(),
      });
      // The result branch consults isAgentTeamsEnabled() (chat-agent.ts),
      // whose real impl needs a runtime context these tests never build —
      // override it like every other result-reaching test in this file does.
      (agent as any).isAgentTeamsEnabled = () => false;
      return { agent, localCallbacks };
    }

    it('a 4xx loop-send failure opens the delivery circuit immediately; the turn completes instead of dying (incident kill #1)', async () => {
      const { agent, localCallbacks } = makeAgent(
        [
          { type: 'text', content: 'working...' },
          { type: 'result', content: '✅ Complete (test)', subtype: 'success' },
        ],
        () => Promise.reject(feishu400())
      );

      void agent.processMessage({ chatId: 'oc_sendfail', payload: 'hello', messageId: 'msg_1' });

      // The circuit-open error log is the deterministic marker that the loop
      // reached (and survived) the failing send.
      await vi.waitFor(() => {
        expect(
          (agent as any).logger.error.mock.calls.some((c: any[]) =>
            String(c[c.length - 1]).includes('delivery circuit OPENED')
          )
        ).toBe(true);
      }, { timeout: 1000, interval: 20 });

      const send = localCallbacks.sendMessage as ReturnType<typeof vi.fn>;
      // Exactly ONE send attempted (the text): the ✅ Complete marker send is
      // skipped by the open circuit — retrying a rejected target is futile.
      expect(send.mock.calls.filter((c: any[]) => c[0] === 'oc_sendfail')).toHaveLength(1);
      // The SDK stream was consumed to completion — the turn was recorded as a
      // SUCCESS, not killed by the send failure. In the incident this same
      // scenario logged "Iterator error" and tore the session down.
      const rm = (agent as any).restartManager;
      expect(rm.recordSuccess).toHaveBeenCalled();
      expect(rm.recordFailure).not.toHaveBeenCalled();
      const errorLogs = (agent as any).logger.error.mock.calls.map((c: any[]) =>
        String(c[c.length - 1])
      );
      expect(errorLogs.some((m: string) => m.includes('Iterator error'))).toBe(false);
    });

    it('a transient (statusless) failure is counted but does not open the circuit; success resets the counter', async () => {
      let call = 0;
      const { agent, localCallbacks } = makeAgent(
        [
          { type: 'text', content: 'attempt 1' },
          { type: 'text', content: 'attempt 2' },
          { type: 'result', content: '✅ Complete (test)', subtype: 'success' },
        ],
        () => {
          call++;
          // First send: transient network error (no HTTP status). Rest succeed.
          return call === 1 ? Promise.reject(new Error('read ECONNRESET')) : Promise.resolve();
        }
      );

      void agent.processMessage({ chatId: 'oc_sendfail', payload: 'hello', messageId: 'msg_1' });

      await vi.waitFor(() => {
        expect((agent as any).restartManager.recordSuccess).toHaveBeenCalled();
      }, { timeout: 1000, interval: 20 });

      const send = localCallbacks.sendMessage as ReturnType<typeof vi.fn>;
      // All three scripted user-visible sends attempted (no circuit opened).
      // (A 4th send may follow: the test generator just ends, which routes
      // into the unexpected-end path's 🚫 circuit-breaker notice — a mock
      // artifact, the persistent-session generator in production does not
      // end after a result.)
      const scripted = send.mock.calls.filter((c: any[]) =>
        ['attempt 1', 'attempt 2', '✅ Complete (test)'].includes(c[1])
      );
      expect(scripted).toHaveLength(3);
      expect((agent as any).sendCircuitOpen).toBe(false);
      expect((agent as any).consecutiveSendFailures).toBe(0);
      const errorLogs = (agent as any).logger.error.mock.calls.map((c: any[]) =>
        String(c[c.length - 1])
      );
      expect(errorLogs.some((m: string) => m.includes('delivery circuit OPENED'))).toBe(false);
    });

    it('three consecutive transient failures open the circuit and skip further sends', async () => {
      const { agent, localCallbacks } = makeAgent(
        [
          { type: 'text', content: 'a' },
          { type: 'text', content: 'b' },
          { type: 'text', content: 'c' },
          { type: 'text', content: 'd' },
          { type: 'result', content: '✅ Complete (test)', subtype: 'success' },
        ],
        () => Promise.reject(new Error('read ECONNRESET'))
      );

      void agent.processMessage({ chatId: 'oc_sendfail', payload: 'hello', messageId: 'msg_1' });

      await vi.waitFor(() => {
        expect((agent as any).restartManager.recordSuccess).toHaveBeenCalled();
      }, { timeout: 1000, interval: 20 });

      const send = localCallbacks.sendMessage as ReturnType<typeof vi.fn>;
      // Sends 1-3 fail transiently → circuit opens on the 3rd; text 4 and the
      // result marker are skipped.
      expect(send.mock.calls.filter((c: any[]) => c[0] === 'oc_sendfail')).toHaveLength(3);
      expect((agent as any).sendCircuitOpen).toBe(true);
    });

    it('a failing error-notice after an iterator error does not cascade into the outer Agent-loop handler (incident kill #2)', async () => {
      let call = 0;
      // Streamed text (send #1) succeeds; every later send — the ❌ Session
      // error notice, then the restart/circuit-breaker notices — hits the same
      // 400 the incident had.
      const { agent, localCallbacks } = makeAgent(
        [{ type: 'text', content: 'partial output' }],
        () => {
          call++;
          return call === 1 ? Promise.resolve() : Promise.reject(feishu400());
        }
      );
      // The SDK stream itself breaks AFTER producing output (messageCount ≥ 1,
      // so this is a runtime error, not a startup failure).
      const scripted = ((agent as any).createQueryStream as () => {
        iterator: AsyncGenerator;
      }).call(agent);
      async function* throwingIterator() {
        yield* scripted.iterator;
        throw new Error('upstream exploded');
      }
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: throwingIterator(),
      });

      void agent.processMessage({ chatId: 'oc_sendfail', payload: 'hello', messageId: 'msg_1' });

      // processIterator survived its catch path: the rejecting error-notice
      // was isolated, so execution reached the restart decision.
      await vi.waitFor(() => {
        expect((agent as any).restartManager.shouldRestart).toHaveBeenCalled();
      }, { timeout: 1000, interval: 20 });

      // The incident cascade marker: processIterator itself throwing lands in
      // the outer startAgentLoop catch ("Agent loop error"). Must be absent.
      const errorLogs = (agent as any).logger.error.mock.calls.map((c: any[]) =>
        String(c[c.length - 1])
      );
      expect(errorLogs.some((m: string) => m.includes('Agent loop error'))).toBe(false);
      // Text sent OK (1) + error notice attempted and 400-rejected (2). The
      // circuit-breaker notice is skipped: that 400 opened the circuit.
      const send = localCallbacks.sendMessage as ReturnType<typeof vi.fn>;
      expect(send.mock.calls.filter((c: any[]) => c[0] === 'oc_sendfail')).toHaveLength(2);
    });
  });

  describe('Issue #4322: upstream-API-error turn reported as failed, not ✅ Complete', () => {
    it('should send ❌ Failed notice (with request_id) and recordFailure when provider tags the result', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_upstream',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // #4322 shape: the turn streamed partial user-visible work, THEN the SDK
      // gave up on an upstream overloaded_error but still emitted a subtype=
      // success result. The provider detected the stderr signature and tagged
      // the result (upstreamApiError + upstreamApiErrorStderr with the upstream
      // request_id), hoisted to top-level parsed fields by convertToLegacyFormat
      // (same shape as terminatedReason for the stall path).
      async function* upstreamErrorResultIterator() {
        yield { parsed: { type: 'text', role: 'assistant', content: 'partial work output' }, raw: {} };
        yield {
          parsed: {
            type: 'result',
            content: '✅ Complete | Cost: $1.3361 | Tokens: 71.8k',
            upstreamApiError: true,
            upstreamApiErrorStderr:
              'Error in API request: {"type":"error","error":{"type":"overloaded_error","code":"500",' +
              '"request_id":"20260714182952476a7a385dcd435c"}}',
          },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: upstreamErrorResultIterator(),
      });
      // BaseAgent mock doesn't define isAgentTeamsEnabled(); stub it so the
      // #3706 zero-tool check at the result marker doesn't throw and short-
      // circuit before the #4322 upstream-error branch runs.
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({ chatId: 'oc_upstream', payload: 'hello', messageId: 'msg_1' });
      await vi.waitFor(
        () => {
          // ❌ Failed notice delivered, surfacing the upstream request_id (actionable).
          const failedCall = localCallbacks.sendMessage.mock.calls.find(
            (c: any[]) => typeof c[1] === 'string' && c[1].includes('上游 API 错误')
          );
          expect(failedCall).toBeDefined();
        },
        { timeout: 1000, interval: 20 }
      );

      const failedCall = localCallbacks.sendMessage.mock.calls.find(
        (c: any[]) => typeof c[1] === 'string' && c[1].includes('上游 API 错误')
      );
      expect(failedCall![1]).toContain('20260714182952476a7a385dcd435c');
      expect(failedCall![0]).toBe('oc_upstream');
      // Threaded to the turn's thread root (3rd sendMessage arg), like #4258.
      expect(failedCall![2]).toBe('thread-root-123');

      // recordFailure('upstream-api-error') — NOT recordSuccess — so chronic
      // upstream issues can trip the restart circuit.
      const rm = (agent as any).restartManager;
      expect(rm.recordFailure).toHaveBeenCalledWith('oc_upstream', 'upstream-api-error');
      expect(rm.recordSuccess).not.toHaveBeenCalled();
    });

    it('Issue #4322 (true-regression guard): an untagged successful turn does NOT fire the ❌ Failed notice', async () => {
      // Same stream shape (partial work + result) but WITHOUT the upstreamApiError
      // tag → a genuinely successful turn must be reported normally (recordSuccess),
      // proving the notice + recordFailure branch is gated on the provider tag and
      // not firing on every result. Revert the chat-agent branch and this still
      // passes; revert the provider tagging and the upstream-error test above
      // would regress (no notice / recordSuccess instead).
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_ok',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* okResultIterator() {
        yield { parsed: { type: 'text', role: 'assistant', content: 'done' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 0.5k' }, raw: {} };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: okResultIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({ chatId: 'oc_ok', payload: 'hello', messageId: 'msg_1' });
      await vi.waitFor(
        () => {
          const rm = (agent as any).restartManager;
          expect(rm.recordSuccess).toHaveBeenCalledWith('oc_ok');
        },
        { timeout: 1000, interval: 20 }
      );

      expect(
        localCallbacks.sendMessage.mock.calls.some(
          (c: any[]) => typeof c[1] === 'string' && c[1].includes('上游 API 错误')
        )
      ).toBe(false);
      const rm = (agent as any).restartManager;
      expect(rm.recordFailure).not.toHaveBeenCalledWith('oc_ok', 'upstream-api-error');
    });

    it('Issue #4322 (edge case): an EMPTY turn killed by an upstream error surfaces only the ❌ notice, records upstream-api-error', async () => {
      // Boundary: when the SDK gives up on an upstream overload BEFORE any
      // content/tool flowed, the turn is BOTH empty (isEmptyTurn) and tagged
      // upstreamApiError. The upstream ❌ notice (with request_id, and the
      // correct "transient overload — retry shortly" diagnosis) must win over
      // the generic ⚠️ empty-turn notice — whose "session may be invalid, try
      // resetting" advice is wrong for a transient upstream error and would
      // otherwise double-notify. The recorded reason must be the more specific
      // 'upstream-api-error', not 'empty-turn'. True-regression for the
      // precedence fix: revert the `&& !upstreamApiError` guard (or the
      // recordFailure reorder) and this fails.
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_empty_upstream',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      // Result-only stream (no assistant text / no tools) → isEmptyTurn becomes
      // true at the result, AND the result is tagged upstreamApiError.
      async function* emptyUpstreamErrorIterator() {
        yield {
          parsed: {
            type: 'result',
            content: '✅ Complete | Cost: $1.3361 | Tokens: 71.8k',
            upstreamApiError: true,
            upstreamApiErrorStderr:
              'Error in API request: {"type":"error","error":{"type":"overloaded_error","code":"500",' +
              '"request_id":"20260714182952476a7a385dcd435c"}}',
          },
          raw: {},
        };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: emptyUpstreamErrorIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({
        chatId: 'oc_empty_upstream',
        payload: 'hello',
        messageId: 'msg_1',
      });

      await vi.waitFor(
        () => {
          const rm = (agent as any).restartManager;
          expect(rm.recordFailure).toHaveBeenCalledWith(
            'oc_empty_upstream',
            'upstream-api-error'
          );
        },
        { timeout: 1000, interval: 20 }
      );

      // ❌ upstream notice fired, surfacing the upstream request_id.
      const upstreamNotice = localCallbacks.sendMessage.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('上游 API 错误')
      );
      expect(upstreamNotice).toBeDefined();
      expect(upstreamNotice![1]).toContain('20260714182952476a7a385dcd435c');

      // ⚠️ empty-turn notice did NOT fire (no double notice).
      expect(
        localCallbacks.sendMessage.mock.calls.some(
          (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('未产生任何可见输出')
        )
      ).toBe(false);

      const rm = (agent as any).restartManager;
      // More specific cause wins; the generic empty-turn reason is NOT recorded.
      expect(rm.recordFailure).not.toHaveBeenCalledWith('oc_empty_upstream', 'empty-turn');
      expect(rm.recordSuccess).not.toHaveBeenCalled();
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
      // Gap D: the 'Result received, turn complete' log carries stopReason
      // threaded from parsed.metadata.stopReason. (Issue #4394: deterministic
      // wait for the log instead of a fixed 150ms wall-clock setTimeout.)
      const { logger } = agent as any;
      await vi.waitFor(
        () => {
          expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ stopReason: 'tool_use' }),
            'Result received, turn complete'
          );
        },
        { timeout: 1000, interval: 20 }
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
      // When no stopReason is present the field is undefined (key present, value
      // absent) — an explicit marker rather than an omitted field. (Issue #4394:
      // deterministic wait instead of a fixed 150ms wall-clock setTimeout.)
      const { logger } = agent as any;
      await vi.waitFor(
        () => {
          expect(
            logger.info.mock.calls.find((c: any[]) => c[1] === 'Result received, turn complete')
          ).toBeDefined();
        },
        { timeout: 1000, interval: 20 }
      );
      const turnCompleteCall = logger.info.mock.calls.find(
        (c: any[]) => c[1] === 'Result received, turn complete'
      );
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
      // Part 2: turn-level observability is surfaced alongside stopReason so a
      // premature end_turn (few round-trips / low API time) is diagnosable.
      // (Issue #4394: deterministic wait instead of a fixed 150ms setTimeout.)
      const { logger } = agent as any;
      await vi.waitFor(
        () => {
          expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ numTurns: 3, durationMs: 4200, durationApiMs: 3100 }),
            'Result received, turn complete'
          );
        },
        { timeout: 1000, interval: 20 }
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

      // Wait for processIterator to handle the error (Issue #4394:
      // deterministic wait for the diagnostic instead of a fixed 100ms
      // wall-clock setTimeout).
      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.find(
              (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败')
            )
          ).toBeDefined();
        },
        { timeout: 1000, interval: 20 }
      );

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
      // Issue #4394: deterministic wait for the diagnostic instead of a fixed
      // 100ms wall-clock setTimeout.
      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.find(
              (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败')
            )
          ).toBeDefined();
        },
        { timeout: 1000, interval: 20 }
      );

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
      // Issue #4394: deterministic wait for the startup-failure diagnostic
      // (which proves the error path ran) instead of a fixed 100ms setTimeout.
      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.find(
              (call: any[]) => typeof call[1] === 'string' && call[1].includes('Agent 启动失败')
            )
          ).toBeDefined();
        },
        { timeout: 1000, interval: 20 }
      );

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

      // Iterator that yields messages before throwing (runtime error).
      // Issue #4394: no real 20ms setTimeout — the gap between the yielded
      // message and the throw is irrelevant to the assertion (messageCount > 0
      // is what classifies this as a runtime error, not a startup failure), so
      // the iterator throws immediately after yielding. Deterministic, zero
      // wall-clock dependency.
      async function* runtimeErrorIterator() {
        yield { parsed: { type: 'text', content: 'Hello from agent' } };
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
      // Issue #4394: deterministic wait for the Session-error diagnostic
      // instead of a fixed 150ms wall-clock setTimeout.
      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.find(
              (call: any[]) => typeof call[1] === 'string' && call[1].includes('Session error')
            )
          ).toBeDefined();
        },
        { timeout: 1000, interval: 20 }
      );

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

      // Iterator that parks after the first yield until close() is called.
      // Issue #4394: no real 10ms setTimeout gaps — a real-timer gap made
      // "when does the pending next() settle" a host-load race; parking on a
      // promise that the mock handle's close() resolves makes it
      // deterministic: reset() calls queryHandle.close() synchronously →
      // every remaining next() settles immediately.
      // NOTE: the loop-head abort check (chat-agent.ts:1059) does NOT fire on
      // the reset() path — reset() nulls this.abortController after aborting
      // (chat-agent.ts:1670), so the check reads null and stays false. The
      // iterator therefore drains all 20 messages and the loop exits via the
      // explicit-close path (isSessionActive=false set before close). The
      // assertion only checks session-inactive, which that path satisfies.
      let releaseIterator!: () => void;
      const parked = new Promise<void>((resolve) => {
        releaseIterator = resolve;
      });
      async function* parkingIterator() {
        for (let i = 1; i <= 20; i++) {
          yield { parsed: { type: 'text', content: `msg-${i}` } };
          await parked; // park until close(); no real timer
        }
      }

      // Override createQueryStream on the instance
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(() => releaseIterator()), cancel: vi.fn() },
        iterator: parkingIterator(),
      });

      // Start the session by sending a message
      void agent.processMessage({ chatId: 'oc_abort_test', payload: 'hello', messageId: 'msg_1' });

      // Wait until the session is active (streaming has started), then reset.
      // (Issue #4394: deterministic wait instead of a fixed 50ms setTimeout.)
      await vi.waitFor(
        () => {
          expect(agent.hasActiveSession()).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );
      agent.reset();

      // Wait for processIterator to complete after the reset (Issue #4394:
      // deterministic wait instead of a fixed 100ms setTimeout).
      await vi.waitFor(
        () => {
          expect(agent.hasActiveSession()).toBe(false);
        },
        { timeout: 1000, interval: 20 }
      );

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

      // Issue #4394: same parking-iterator shape as the reset() test above.
      // Unlike reset(), stop() does NOT null abortController — the loop-head
      // abort check (chat-agent.ts:1059) fires on the first settled next(),
      // so this exercises the real abort-break path (verified: the abort log
      // fires and only msg-1 is processed before the break).
      let releaseIterator!: () => void;
      const parked = new Promise<void>((resolve) => {
        releaseIterator = resolve;
      });
      async function* parkingIterator() {
        for (let i = 1; i <= 20; i++) {
          yield { parsed: { type: 'text', content: `msg-${i}` } };
          await parked; // park until close(); no real timer
        }
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(() => releaseIterator()), cancel: vi.fn() },
        iterator: parkingIterator(),
      });

      void agent.processMessage({ chatId: 'oc_stop_test', payload: 'hello', messageId: 'msg_1' });

      // Wait until the session is active (streaming has started), then stop.
      // (Issue #4394: deterministic wait instead of a fixed 50ms setTimeout.)
      await vi.waitFor(
        () => {
          expect(agent.hasActiveSession()).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );
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
      // Issue #4394: deterministic wait for the unconditional turn-complete
      // log instead of a fixed 100ms wall-clock setTimeout — all forwarding
      // has settled by the time the result marker is logged.
      await vi.waitFor(
        () => {
          expect(
            (agent as any).logger.info.mock.calls.some(
              (c: any[]) => c[1] === 'Result received, turn complete'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );

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
      // Issue #4394: deterministic wait for the unconditional turn-complete
      // log instead of a fixed 100ms wall-clock setTimeout.
      await vi.waitFor(
        () => {
          expect(
            (agent as any).logger.info.mock.calls.some(
              (c: any[]) => c[1] === 'Result received, turn complete'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );

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
      // Issue #4394: deterministic wait for the unconditional turn-complete
      // log instead of a fixed 100ms wall-clock setTimeout.
      await vi.waitFor(
        () => {
          expect(
            (agent as any).logger.info.mock.calls.some(
              (c: any[]) => c[1] === 'Result received, turn complete'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );

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
      // Issue #4394: deterministic wait for the unconditional turn-complete
      // log instead of a fixed 100ms wall-clock setTimeout.
      await vi.waitFor(
        () => {
          expect(
            (agent as any).logger.info.mock.calls.some(
              (c: any[]) => c[1] === 'Result received, turn complete'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );

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
      // Issue #4394: deterministic wait for the unconditional turn-complete
      // log instead of a fixed 100ms wall-clock setTimeout.
      await vi.waitFor(
        () => {
          expect(
            (agent as any).logger.info.mock.calls.some(
              (c: any[]) => c[1] === 'Result received, turn complete'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );

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
      // Issue #4394: deterministic wait for the unconditional turn-complete
      // log instead of a fixed 100ms wall-clock setTimeout.
      await vi.waitFor(
        () => {
          expect(
            (agent as any).logger.info.mock.calls.some(
              (c: any[]) => c[1] === 'Result received, turn complete'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );

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
      // Issue #4394: deterministic wait for the unconditional turn-complete
      // log instead of a fixed 100ms wall-clock setTimeout.
      await vi.waitFor(
        () => {
          expect(
            (agent as any).logger.info.mock.calls.some(
              (c: any[]) => c[1] === 'Result received, turn complete'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );

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

    it('anchors topic-thread replies to the message threadRootId, not the orchestrator last-seen id (Issue #4587 part 1)', async () => {
      // Two threads share this chat-scoped agent. The orchestrator mock's
      // getThreadRoot returns a constant ('thread-root-123' = whichever
      // message was seen last across ALL threads). A reply turn triggered by
      // thread A's message must anchor to thread A's root even if thread B's
      // message arrived after — the turn's own threadRootId wins.
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_topic_chat',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      (agent as any).chatType = 'topic';

      async function* replyIterator() {
        yield { parsed: { type: 'text', content: 'Reply in thread A' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: replyIterator(),
      });

      void agent.processMessage({
        chatId: 'oc_topic_chat',
        payload: 'question in thread A',
        messageId: 'msg_thread_a_2',
        chatType: 'topic',
        threadRootId: 'omt_thread_a',
      });
      await vi.waitFor(
        () => {
          expect(
            (agent as any).logger.info.mock.calls.some(
              (c: any[]) => c[1] === 'Result received, turn complete'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );

      // The assistant reply went out with thread A's root, not the
      // orchestrator's last-seen id (thread-root-123).
      const replyCall = localCallbacks.sendMessage.mock.calls.find(
        (call: any[]) => call[1] === 'Reply in thread A'
      );
      expect(replyCall).toBeDefined();
      expect(replyCall![2]).toBe('omt_thread_a');

      // A subsequent message WITHOUT threadRootId (plain group / synthetic)
      // clears the stale anchor and falls back to the orchestrator value.
      async function* replyIterator2() {
        yield { parsed: { type: 'text', content: 'Reply without thread' } };
        yield { parsed: { type: 'result', content: 'Done' } };
      }
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: replyIterator2(),
      });
      void agent.processMessage({
        chatId: 'oc_topic_chat',
        payload: 'follow-up',
        messageId: 'msg_no_thread',
      });
      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.some(
              (call: any[]) => call[1] === 'Reply without thread'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 20 }
      );
      const plainCall = localCallbacks.sendMessage.mock.calls.find(
        (call: any[]) => call[1] === 'Reply without thread'
      );
      expect(plainCall![2]).toBe('thread-root-123');
    });

    it('freezes the reply anchor per turn — thread B arriving MID-TURN of thread A cannot hijack A\'s tail output (Issue #4587 part 1 review fix)', async () => {
      // The original part-1 shape resolved the anchor live at each output site
      // (currentThreadRootId ?? orchestrator). But processMessage(B) overwrites
      // currentThreadRootId synchronously, and B can arrive while A's iterator
      // is still draining — so A's post-B outputs anchored to B's thread, the
      // exact cross-thread hijack the PR set out to fix. The fix snapshots the
      // anchor at turn start (turnThreadRootAnchor) and every reply site reads
      // the frozen value.
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_topic_chat',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      (agent as any).chatType = 'topic';

      // Thread A's iterator: first chunk goes out, then a real async gap
      // (timeout) during which thread B's processMessage lands, then A's
      // second chunk + result.
      async function* threadAIterator() {
        yield { parsed: { type: 'text', content: 'A chunk 1' } };
        await new Promise<void>((r) => setTimeout(r, 50));
        yield { parsed: { type: 'text', content: 'A chunk 2 after B arrived' } };
        yield { parsed: { type: 'result', content: 'Done A' } };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: threadAIterator(),
      });

      // Start thread A's turn — do NOT await; it must be in flight.
      void agent.processMessage({
        chatId: 'oc_topic_chat',
        payload: 'question in thread A',
        messageId: 'msg_a_1',
        chatType: 'topic',
        threadRootId: 'omt_thread_a',
      });

      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.some(
              (call: any[]) => call[1] === 'A chunk 1'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 10 }
      );

      // Thread B's message arrives MID-TURN of A (same chat-scoped agent).
      // This overwrites currentThreadRootId synchronously.
      async function* threadBIterator() {
        yield { parsed: { type: 'text', content: 'B chunk 1' } };
        yield { parsed: { type: 'result', content: 'Done B' } };
      }
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: threadBIterator(),
      });
      void agent.processMessage({
        chatId: 'oc_topic_chat',
        payload: 'question in thread B',
        messageId: 'msg_b_1',
        chatType: 'topic',
        threadRootId: 'omt_thread_b',
      });

      // Wait for A's post-B chunk and let everything settle.
      await vi.waitFor(
        () => {
          expect(
            localCallbacks.sendMessage.mock.calls.some(
              (call: any[]) => call[1] === 'A chunk 2 after B arrived'
            )
          ).toBe(true);
        },
        { timeout: 1000, interval: 10 }
      );
      await new Promise((r) => setTimeout(r, 100));

      const a2 = localCallbacks.sendMessage.mock.calls.find(
        (call: any[]) => call[1] === 'A chunk 2 after B arrived'
      );
      expect(a2).toBeDefined();
      // A's post-B output must still anchor to A's thread root — not B's.
      expect(a2![2]).toBe('omt_thread_a');
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

      // Wait for the result to be processed (Issue #4394: deterministic wait
      // instead of a fixed 100ms wall-clock setTimeout).
      await vi.waitFor(
        () => {
          expect(chatAgent.isBusy).toBe(false);
        },
        { timeout: 1000, interval: 20 }
      );
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
        // sched-* synthetic ID (Issue #4391): a real-user ID would now be granted
        // the one-shot reset+replay, whose deferred session teardown interferes
        // with the two-turn persistent-iterator premise of this test. The
        // synthetic ID keeps this test about what it asserts — the #4194
        // per-turn counter reset — while the retry path has its own tests below.
        messageId: 'sched-empty-turn-2',
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
        // sched-* synthetic ID (Issue #4391): synthetic empty turns are never
        // retried, so this test still exercises the ⚠️ notice fallback — the
        // exact behavior a scheduled task sees (no reset, no replay, notify).
        messageId: 'sched-empty-notify',
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
        // sched-* synthetic ID (Issue #4391): keep this test on the
        // non-retryable branch so the ⚠️ notice (the assertion) still fires.
        messageId: 'sched-empty-system',
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

  describe('Issue #4391: empty-turn session-reset + bounded replay', () => {
    // Shared harness for the #4391 matrix (design doc §5). createQueryStream
    // is stubbed per-test; the mock channel (in the @disclaude/core mock) has
    // push() → true, so processMessage always accepts.
    function makeRetryAgent(chatId: string, callbacks = createMockCallbacks()) {
      const agent = new ChatAgent({
        chatId,
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      (agent as any).isAgentTeamsEnabled = () => false;
      return agent;
    }

    it('real-user empty turn → schedules one reset + replay (fresh session), suppresses the ⚠️ notice', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = makeRetryAgent('oc_retry_ok', localCallbacks);

      let queryCount = 0;
      const createQueryStream = vi.fn(() => {
        queryCount++;
        // Query 1 (the broken session): result-only — empty turn.
        // Query 2 (the replay's fresh session): a real reply, then the marker
        // — the retried turn recovers, so no ⚠️ notice may fire.
        const recovered = queryCount >= 2;
        return {
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            if (recovered) {
              yield { parsed: { type: 'text', content: 'Recovered reply!' }, raw: {} };
            }
            yield {
              parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
              raw: {},
            };
          })(),
        };
      });
      (agent as any).createQueryStream = createQueryStream;

      void agent.processMessage({
        chatId: 'oc_retry_ok',
        payload: 'please answer',
        messageId: 'om_real_user_1',
      });

      // The scheduling warn fires when the empty turn is granted its retry…
      await vi.waitFor(() => {
        const warnSpy = (agent as any).logger.warn as ReturnType<typeof vi.fn>;
        expect(
          warnSpy.mock.calls.some((c: unknown[]) =>
            typeof c[1] === 'string' && (c[1] as string).includes('scheduling one-shot')
          )
        ).toBe(true);
      }, { timeout: 1000, interval: 20 });

      // …and after the deferred setTimeout(0) callback runs, the session was
      // torn down (queryHandle closed) and processMessage replayed the original
      // params — visible as a SECOND createQueryStream call (fresh session for
      // the replay; startAgentLoop only fires when !isSessionActive).
      await vi.waitFor(() => {
        expect(createQueryStream).toHaveBeenCalledTimes(2);
      }, { timeout: 1000, interval: 20 });

      // No ⚠️ empty-turn notice on the retrying attempt (suppressed while
      // recovery is in flight — design §4.5).
      const noticed = localCallbacks.sendMessage.mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('未产生任何可见输出')
      );
      expect(noticed).toBeUndefined();

      // The empty turn was still accounted as a failure (circuit keeps
      // counting chronic empty turns; retry is NOT success).
      const rm = (agent as any).restartManager as { recordFailure: ReturnType<typeof vi.fn> };
      expect(rm.recordFailure).toHaveBeenCalledWith('oc_retry_ok', 'empty-turn');
    });

    it('sched-* synthetic empty turn → no retry (no second query, notice still sent)', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = makeRetryAgent('oc_retry_sched', localCallbacks);

      const createQueryStream = vi.fn(() => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () {
          yield {
            parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
            raw: {},
          };
        })(),
      }));
      (agent as any).createQueryStream = createQueryStream;

      void agent.processMessage({
        chatId: 'oc_retry_sched',
        payload: 'scheduled prompt',
        messageId: 'sched-1800000000-issue-solver',
      });

      // The ⚠️ notice fires (fallback path — synthetic turns never retry)…
      await vi.waitFor(() => {
        const diagnosticCall = localCallbacks.sendMessage.mock.calls.find(
          (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('未产生任何可见输出')
        );
        expect(diagnosticCall).toBeDefined();
      }, { timeout: 1000, interval: 20 });

      // …and no replay is scheduled: the session was NOT torn down, so the
      // persistent iterator keeps running (no second query).
      await new Promise((r) => setTimeout(r, 50));
      expect(createQueryStream).toHaveBeenCalledTimes(1);
    });

    it('retry bounded to 1: a second consecutive empty turn gets no reset+replay and notifies', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = makeRetryAgent('oc_retry_bounded', localCallbacks);

      const createQueryStream = vi.fn(() => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: (async function* () {
          yield {
            parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
            raw: {},
          };
        })(),
      }));
      (agent as any).createQueryStream = createQueryStream;

      // Turn 1: real-user empty turn — granted the one retry (session 1 → 2).
      void agent.processMessage({
        chatId: 'oc_retry_bounded',
        payload: 'first attempt',
        messageId: 'om_real_user_a',
      });
      await vi.waitFor(() => {
        expect(createQueryStream).toHaveBeenCalledTimes(2);
      }, { timeout: 1000, interval: 20 });

      // Turn 2 (the replay): ALSO empty. canRetry is now false (bounded to 1),
      // so no third session — the ⚠️ notice fires instead.
      await vi.waitFor(() => {
        const diagnosticCall = localCallbacks.sendMessage.mock.calls.find(
          (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('未产生任何可见输出')
        );
        expect(diagnosticCall).toBeDefined();
      }, { timeout: 1000, interval: 20 });

      await new Promise((r) => setTimeout(r, 50));
      expect(createQueryStream).toHaveBeenCalledTimes(2);
      const rm = (agent as any).restartManager as { recordFailure: ReturnType<typeof vi.fn> };
      expect(rm.recordFailure).toHaveBeenCalledWith('oc_retry_bounded', 'empty-turn');
      expect((rm as unknown as { recordSuccess: ReturnType<typeof vi.fn> }).recordSuccess).not.toHaveBeenCalled();
    });

    // Issue #4391 (part 2 review regression 1): real SDK persistent streams
    // PARK after a turn's result (the iterator stays alive awaiting the next
    // SDK message); the earlier matrix used naturally-ending generators, which
    // hid the park-drain race on the superseded iterator.
    it('parked old iterator: replay must not trip the unexpected-end / circuit-breaker path', async () => {
      const localCallbacks = createMockCallbacks();
      const agent = makeRetryAgent('oc_retry_parked', localCallbacks);

      // A production-shaped iterator: yields its turn, then PARKS on a
      // promise that only resolves when handle.close() is called — exactly
      // how a persistent SDK stream behaves between turns and at teardown.
      function parkedIterator(events: { type: string; content: string }[]) {
        let release: () => void = () => {};
        const parked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const handle = {
          close: vi.fn(() => release()),
          cancel: vi.fn(() => release()),
        };
        const iterator = (async function* () {
          for (const event of events) {
            yield { parsed: event, raw: {} };
          }
          await parked; // park like a real persistent stream
        })();
        return { handle, iterator };
      }

      let queryCount = 0;
      const createQueryStream = vi.fn(() => {
        queryCount++;
        if (queryCount === 1) {
          // Session 1 (the broken one): empty turn, then parks.
          return parkedIterator([
            { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
          ]);
        }
        // Session 2 (the replay): a real reply + result, then also parks —
        // the persistent session keeps running after a successful replay.
        return parkedIterator([
          { type: 'text', content: 'Recovered reply!' },
          { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
        ]);
      });
      (agent as any).createQueryStream = createQueryStream;

      void agent.processMessage({
        chatId: 'oc_retry_parked',
        payload: 'please answer',
        messageId: 'om_real_user_parked',
      });

      // The replay's fresh session ran and recovered…
      const recoveredCall = await vi.waitFor(
        () => {
          const call = localCallbacks.sendMessage.mock.calls.find(
            (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Recovered reply!')
          );
          expect(call).toBeDefined();
          return call;
        },
        { timeout: 1000, interval: 20 }
      );
      expect(recoveredCall).toBeDefined();

      // …and give the drained OLD iterator (released by endEmptyTurnSession's
      // close) a chance to run its post-loop path.
      await new Promise((r) => setTimeout(r, 50));

      // Exactly two sessions: the broken one and the replay. A third would
      // mean the old loop's exit ran the auto-restart path.
      expect(createQueryStream).toHaveBeenCalledTimes(2);

      // The superseded iterator's exit must be intercepted: no unexpected-end
      // warn, no ⚠️ reconnect notice, no 🚫 circuit-breaker notice — the replay
      // succeeded, so the user must not see any of them.
      const warnSpy = (agent as any).logger.warn as ReturnType<typeof vi.fn>;
      const unexpectedWarn = warnSpy.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('ended unexpectedly')
      );
      expect(unexpectedWarn).toBeUndefined();

      const badNotice = localCallbacks.sendMessage.mock.calls.find(
        (call: unknown[]) =>
          typeof call[1] === 'string' &&
          ((call[1] as string).includes('会话多次异常中断') ||
            (call[1] as string).includes('会话已暂停') ||
            (call[1] as string).includes('意外断开'))
      );
      expect(badNotice).toBeUndefined();

      // The interception is visible as an info log, not silence.
      const infoSpy = (agent as any).logger.info as ReturnType<typeof vi.fn>;
      const interceptInfo = infoSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[1] === 'string' && (c[1] as string).includes('superseded session iterator ended')
      );
      expect(interceptInfo).toBeDefined();

      // The replay recovered → healthy-turn accounting re-arms the retry.
      const rm = (agent as any).restartManager as { recordSuccess: ReturnType<typeof vi.fn> };
      expect(rm.recordSuccess).toHaveBeenCalledWith('oc_retry_parked');
    });

    // Issue #4391 (part 2 review regression 2): a disposed agent must never
    // fire the replay. Uses the production-faithful BaseAgent mock (no forced
    // initialized=true), so this only passes with a real disposed check.
    it('agent disposed before the timer fires → replay skipped (no second query)', async () => {
      vi.useFakeTimers();
      try {
        const localCallbacks = createMockCallbacks();
        const agent = makeRetryAgent('oc_retry_disposed', localCallbacks);

        const createQueryStream = vi.fn(() => ({
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            yield {
              parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
              raw: {},
            };
          })(),
        }));
        (agent as any).createQueryStream = createQueryStream;

        void agent.processMessage({
          chatId: 'oc_retry_disposed',
          payload: 'please answer',
          messageId: 'om_real_user_dispose',
        });

        // Drain microtasks until the empty-turn retry is scheduled. With fake
        // timers the setTimeout(0) callback stays pending, giving a
        // deterministic window to dispose before it fires.
        const warnSpy = (agent as any).logger.warn as ReturnType<typeof vi.fn>;
        for (let i = 0; i < 10_000; i++) {
          const scheduled = warnSpy.mock.calls.some(
            (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('scheduling one-shot')
          );
          if (scheduled) {break;}
          await Promise.resolve();
        }

        // Dispose inside the window: sync flag set, teardown fire-and-forget.
        // The BaseAgent mock sets an instance `this.dispose = vi.fn()` that
        // shadows ChatAgent.prototype.dispose, so invoke the real method.
        (ChatAgent.prototype.dispose as unknown as (this: unknown) => void).call(agent);

        // Fire the pending replay timer.
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();

        // The guard skipped the replay — no fresh session was created…
        expect(createQueryStream).toHaveBeenCalledTimes(1);
        // …and said so in the skip log.
        const infoSpy = (agent as any).logger.info as ReturnType<typeof vi.fn>;
        const skipInfo = infoSpy.mock.calls.find(
          (c: unknown[]) =>
            typeof c[1] === 'string' && (c[1] as string).includes('Empty-turn replay skipped')
        );
        expect(skipInfo).toBeDefined();
        expect((skipInfo![0] as Record<string, unknown>).disposed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // Issue #4391 (§6 history re-injection follow-up): the replayed message
    // must carry the re-loaded chat history, so the fresh session does not
    // start blind. Asserts on what each session's channel actually received.
    it('replay re-injects chat history into the fresh session (first-message consume-once)', async () => {
      const localCallbacks = createMockCallbacks();
      // History source. NOTE: getChatHistory backs BOTH history loads — the
      // persisted-history load (session restore, fire-and-forget at
      // startAgentLoop) and the first-message load — plus the replay's
      // re-injection fetch. Rather than pin a brittle call sequence, make the
      // history AVAILABLE on every fetch and assert the re-injection made it
      // into the replay's payload (the consume-once stash did its job).
      const RECENT_HISTORY = '👤 [earlier] what is the ETF flow?\n\n---\n\n';
      const getChatHistory = vi.fn().mockResolvedValue(RECENT_HISTORY);
      localCallbacks.getChatHistory = getChatHistory;
      const agent = makeRetryAgent('oc_retry_hist', localCallbacks);

      let queryCount = 0;
      const createQueryStream = vi.fn(() => {
        queryCount++;
        const recovered = queryCount >= 2;
        return {
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            if (recovered) {
              yield { parsed: { type: 'text', content: 'Recovered with context!' }, raw: {} };
            }
            yield {
              parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
              raw: {},
            };
          })(),
        };
      });
      (agent as any).createQueryStream = createQueryStream;

      // Capture what each session's channel actually received. The mocked
      // MessageChannel is constructed per startAgentLoop; hook push() so the
      // replay query's payload can be inspected for the re-injected history.
      const channelInstances: Array<{ push: ReturnType<typeof vi.fn> }> = [];
      const coreModule = await import('@disclaude/core');
      const MessageChannelCtor = coreModule.MessageChannel as unknown as ReturnType<typeof vi.fn>;
      // Issue #4391 (part 3 review nit): mockImplementation replaces the
      // factory-level implementation for the REST OF THE FILE
      // (vi.clearAllMocks clears calls, not implementations) — save the
      // original and restore it in a finally below.
      const originalImpl = MessageChannelCtor.getMockImplementation();
      MessageChannelCtor.mockImplementation(function (this: {
        push: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        generator: ReturnType<typeof vi.fn>;
      }) {
        this.push = vi.fn((_payload: unknown) => {
          return true;
        });
        this.close = vi.fn();
        this.generator = vi.fn(() =>
          (async function* () {
            /* empty */
          })()
        );
        channelInstances.push(this as never);
        return this;
      });

      try {
      void agent.processMessage({
        chatId: 'oc_retry_hist',
        payload: 'please answer',
        messageId: 'om_real_user_hist',
      });

      // The replay ran and recovered…
      await vi.waitFor(() => {
        expect(createQueryStream).toHaveBeenCalledTimes(2);
      }, { timeout: 1000, interval: 20 });
      await vi.waitFor(() => {
        const call = localCallbacks.sendMessage.mock.calls.find(
          (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Recovered with context!')
        );
        expect(call).toBeDefined();
      }, { timeout: 1000, interval: 20 });

      // …and the re-injection fetch actually happened, with the re-stash logged.
      expect(getChatHistory.mock.calls.length).toBeGreaterThanOrEqual(2);
      const infoSpy = (agent as any).logger.info as ReturnType<typeof vi.fn>;
      const reinjectInfo = infoSpy.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Re-injected chat history')
      );
      expect(reinjectInfo).toBeDefined();

      // The replay's pushed payload (second session's message) embeds the
      // re-injected history — the fresh session did NOT start blind. (The
      // mock supplies history on every fetch, so the broken session's payload
      // may carry its own first-message load too; the assertion that matters
      // is the REPLAY's payload includes it via the re-injection stash.)
      expect(channelInstances.length).toBe(2);
      const replayPushed = channelInstances[1].push.mock.calls.map((c: unknown[]) => JSON.stringify(c[0]));
      expect(replayPushed.some((p) => p.includes('what is the ETF flow?'))).toBe(true);
      } finally {
        // Restore the factory-level implementation (undefined when nothing
        // was set — restore that too; mockImplementation(undefined) is
        // rejected by typings, so cast through the generic mock shape).
        if (originalImpl) {
          MessageChannelCtor.mockImplementation(originalImpl);
        } else {
          (MessageChannelCtor as unknown as { mockImplementation: (i?: unknown) => unknown })
            .mockImplementation(undefined);
        }
      }
    });

    // Issue #4391 (part 3 review nit): the replayed message rendered TWO
    // history sections — the session-start persistedHistoryContext snapshot
    // ("Previous Session Context") AND the fresh re-injection stash ("Recent
    // Chat History"). Both come from the same getChatHistory source, and the
    // re-injection fetch happens strictly LATER, so it is a superset of the
    // session-start snapshot: keeping both only doubles the token cost. The
    // replay payload must carry the fresh section alone (the log-paths hint
    // from the persisted section stays — only the duplicated CONTENT drops).
    it('replay payload renders the fresh history once, not duplicated as both persisted and fresh sections', async () => {
      const localCallbacks = createMockCallbacks();
      // First fetch = the session-start snapshot (persisted history); every
      // later fetch (first-message load, re-injection) returns history that
      // strictly contains it plus turns logged since.
      const SESSION_START = '👤 [day 1] earlier turns';
      const FRESH = '👤 [day 1] earlier turns\n👤 [day 2] turns logged after session start';
      let fetchCount = 0;
      const getChatHistory = vi.fn(() => {
        fetchCount++;
        return Promise.resolve(fetchCount === 1 ? SESSION_START : FRESH);
      });
      localCallbacks.getChatHistory = getChatHistory;
      const agent = makeRetryAgent('oc_retry_dedup', localCallbacks);

      let queryCount = 0;
      const createQueryStream = vi.fn(() => {
        queryCount++;
        const recovered = queryCount >= 2;
        return {
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            if (recovered) {
              yield { parsed: { type: 'text', content: 'Recovered once!' }, raw: {} };
            }
            yield {
              parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
              raw: {},
            };
          })(),
        };
      });
      (agent as any).createQueryStream = createQueryStream;

      const channelInstances: Array<{ push: ReturnType<typeof vi.fn> }> = [];
      const coreModule = await import('@disclaude/core');
      const MessageChannelCtor = coreModule.MessageChannel as unknown as ReturnType<typeof vi.fn>;
      const originalImpl = MessageChannelCtor.getMockImplementation();
      MessageChannelCtor.mockImplementation(function (this: {
        push: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        generator: ReturnType<typeof vi.fn>;
      }) {
        this.push = vi.fn((_payload: unknown) => true);
        this.close = vi.fn();
        this.generator = vi.fn(() =>
          (async function* () {
            /* empty */
          })()
        );
        channelInstances.push(this as never);
        return this;
      });

      try {
        void agent.processMessage({
          chatId: 'oc_retry_dedup',
          payload: 'please answer',
          messageId: 'om_real_user_dedup',
        });

        await vi.waitFor(() => {
          expect(createQueryStream).toHaveBeenCalledTimes(2);
        }, { timeout: 1000, interval: 20 });
        await vi.waitFor(() => {
          const call = localCallbacks.sendMessage.mock.calls.find(
            (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Recovered once!')
          );
          expect(call).toBeDefined();
        }, { timeout: 1000, interval: 20 });

        // The replay payload embeds the fresh history…
        expect(channelInstances.length).toBe(2);
        const replayPushed = channelInstances[1].push.mock.calls
          .map((c: unknown[]) => JSON.stringify(c[0]))
          .join('\n');
        expect(replayPushed.includes('turns logged after session start')).toBe(true);
        // …exactly once: the day-1 turns appear in the fresh section only, not
        // a second time through the stale persisted section.
        expect(replayPushed.split('👤 [day 1]').length - 1).toBe(1);
      } finally {
        if (originalImpl) {
          MessageChannelCtor.mockImplementation(originalImpl);
        } else {
          (MessageChannelCtor as unknown as { mockImplementation: (i?: unknown) => unknown })
            .mockImplementation(undefined);
        }
      }
    });

    // Issue #4391 (§6 review follow-up): trigger-mode @mentions carry a
    // receive-time chatHistoryContext param (message-handler snapshot), and
    // processMessage prefers the param over the consume-once stash. If the
    // replay re-passes those params unchanged, the re-injection stash is
    // never consumed by the replayed message — and then leaks onto the NEXT
    // param-less message as a stray "Recent Chat History" section. When
    // re-injection succeeded, the replay must drop the stale param so the
    // fresh fetch wins; a failed fetch keeps the stale param (v1 behavior).
    it('replay with trigger-mode chatHistoryContext param → re-injection stash wins, no leak to later messages', async () => {
      const localCallbacks = createMockCallbacks();
      // Stale receive-time snapshot rides on the original params (trigger
      // mode); the re-injection fetch returns fresher history.
      const STALE_SNAPSHOT = '👤 [stale] old receive-time snapshot\n\n---\n\n';
      const FRESH_HISTORY = '👤 [fresh] turn logged after the snapshot\n\n---\n\n';
      const getChatHistory = vi.fn().mockResolvedValue(FRESH_HISTORY);
      localCallbacks.getChatHistory = getChatHistory;
      const agent = makeRetryAgent('oc_retry_param', localCallbacks);

      let queryCount = 0;
      const createQueryStream = vi.fn(() => {
        queryCount++;
        const recovered = queryCount >= 2;
        return {
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            if (recovered) {
              yield { parsed: { type: 'text', content: 'Recovered fresh!' }, raw: {} };
            }
            yield {
              parsed: { type: 'result', content: '✅ Complete | Cost: $0.00 | Tokens: 0.5k' },
              raw: {},
            };
          })(),
        };
      });
      (agent as any).createQueryStream = createQueryStream;

      // Capture each session's pushed payloads (same MessageChannel hook as
      // the re-injection test above).
      const channelInstances: Array<{ push: ReturnType<typeof vi.fn> }> = [];
      const coreModule = await import('@disclaude/core');
      const MessageChannelCtor = coreModule.MessageChannel as unknown as ReturnType<typeof vi.fn>;
      const originalImpl = MessageChannelCtor.getMockImplementation();
      MessageChannelCtor.mockImplementation(function (this: {
        push: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        generator: ReturnType<typeof vi.fn>;
      }) {
        this.push = vi.fn((_payload: unknown) => true);
        this.close = vi.fn();
        this.generator = vi.fn(() =>
          (async function* () {
            /* empty */
          })()
        );
        channelInstances.push(this as never);
        return this;
      });

      try {
        // The original turn is a trigger-mode mention: params carry the
        // receive-time snapshot.
        void agent.processMessage({
          chatId: 'oc_retry_param',
          payload: 'please answer',
          messageId: 'om_real_user_param',
          chatHistoryContext: STALE_SNAPSHOT,
        });

        await vi.waitFor(() => {
          expect(createQueryStream).toHaveBeenCalledTimes(2);
        }, { timeout: 1000, interval: 20 });
        await vi.waitFor(() => {
          const call = localCallbacks.sendMessage.mock.calls.find(
            (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Recovered fresh!')
          );
          expect(call).toBeDefined();
        }, { timeout: 1000, interval: 20 });

        // The replay's payload carries the FRESH re-injected history, not the
        // stale receive-time snapshot the original params carried.
        expect(channelInstances.length).toBe(2);
        const replayPushed = channelInstances[1].push.mock.calls.map((c: unknown[]) =>
          JSON.stringify(c[0])
        );
        expect(replayPushed.some((p) => p.includes('turn logged after the snapshot'))).toBe(true);
        expect(replayPushed.some((p) => p.includes('old receive-time snapshot'))).toBe(false);

        // The stash was consumed by the replay — a later param-less message
        // must NOT receive a stray history section (consume-once respected).
        const consumed = (agent as any).historyManager.firstMessageHistoryContext;
        expect(consumed).toBeUndefined();

        void agent.processMessage({
          chatId: 'oc_retry_param',
          payload: 'follow-up without history param',
          messageId: 'om_real_user_param_2',
        });
        await vi.waitFor(() => {
          expect(createQueryStream).toHaveBeenCalledTimes(3);
        }, { timeout: 1000, interval: 20 });
        const thirdPushed = channelInstances[2].push.mock.calls.map((c: unknown[]) =>
          JSON.stringify(c[0])
        );
        expect(
          thirdPushed.some((p) => p.includes('turn logged after the snapshot'))
        ).toBe(false);
      } finally {
        // Restore the factory-level implementation (it may be undefined when
        // nothing was set — restore that too, mockImplementation(undefined)
        // is rejected by typings, so cast through the generic mock shape).
        if (originalImpl) {
          MessageChannelCtor.mockImplementation(originalImpl);
        } else {
          (MessageChannelCtor as unknown as { mockImplementation: (i?: unknown) => unknown })
            .mockImplementation(undefined);
        }
      }
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

    it('Issue #4260 (test 1): a system→result-only stream is marked failed, not silent success', async () => {
      // #4194's exact reported scenario is a stream that emits a `system` SDK
      // message (the GLM / Agent Teams flood, rendered by the adapter as an
      // empty-content text event) and then a bare `result` marker — no assistant
      // content, no tool calls. #4289 locked the *detection* for this shape
      // (the empty-content system event does not count as user-visible output,
      // so the empty-turn diagnostic notice fires). #4290 locked the corrective
      // *action* for a result-only stream (recordFailure instead of
      // recordSuccess). This test (#4260 test 1) closes the gap between them:
      // for the system→result shape specifically, the turn must be recorded as
      // a FAILURE so a chronically-broken session can still trip the restart
      // circuit — it must NOT silently recordSuccess and report only ✅ Complete.
      // True regression: fails if the empty-content `text` event ever started
      // counting as user-visible output (count → 1 → isEmptyTurn false →
      // recordSuccess called, recordFailure NOT called), regressing #4194/#4258.
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_empty_turn_system_failed',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* systemResultIterator() {
        // Adapter rendering of an unhandled system subtype (e.g. task_started):
        // { type: 'text', content: '', role: 'system', metadata: { systemSubtype } }
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
        chatId: 'oc_empty_turn_system_failed',
        payload: 'hi',
        messageId: 'msg_1',
      });

      const rm = (agent as any).restartManager;
      // #4258 (part 2 / ③): an empty turn — even one preceded by an empty-content
      // system flood event — is a failure, not a success.
      await vi.waitFor(() => {
        expect(rm.recordFailure).toHaveBeenCalledWith('oc_empty_turn_system_failed', 'empty-turn');
      }, { timeout: 1000, interval: 20 });
      expect(rm.recordSuccess).not.toHaveBeenCalled();
    });

  });

  describe('Issue #4399: streaming-card dispatch (supportsStreaming)', () => {
    // A ChannelCapabilities with streaming on/off. Other fields are populated
    // so message-building never sees an undefined capability during the turn.
    const caps = (supportsStreaming: boolean) => ({
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: supportsStreaming,
      supportsStreaming,
    });

    it('streams assistant text via startStreaming/streamText/finalizeStreaming when the channel supports it', async () => {
      const localCallbacks = {
        ...createMockCallbacks(),
        getCapabilities: vi.fn(() => caps(true)),
        startStreaming: vi.fn(() => Promise.resolve('card-42')),
        streamText: vi.fn(() => Promise.resolve()),
        finalizeStreaming: vi.fn(() => Promise.resolve()),
      };
      const agent = new ChatAgent({
        chatId: 'oc_stream',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* replyIterator() {
        yield { parsed: { type: 'text', role: 'assistant', content: 'Hello' }, raw: {} };
        yield { parsed: { type: 'text', role: 'assistant', content: 'world' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 10' }, raw: {} };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: replyIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({ chatId: 'oc_stream', payload: 'hi', messageId: 'msg_1', chatType: 'p2p' });

      // The streaming callbacks fire once the turn flows.
      await vi.waitFor(() => {
        expect(localCallbacks.finalizeStreaming).toHaveBeenCalledWith('card-42');
      }, { timeout: 1000, interval: 20 });

      // startStreaming called once for the turn (chatId + thread root).
      expect(localCallbacks.startStreaming).toHaveBeenCalledTimes(1);
      expect(localCallbacks.startStreaming).toHaveBeenCalledWith('oc_stream', expect.anything());
      // streamText PATCHed the card (leading chunk + final flush).
      expect(localCallbacks.streamText).toHaveBeenCalledWith('card-42', 'Hello');
      // The reply text was routed through the streaming card, NOT sendMessage.
      const sentTexts = localCallbacks.sendMessage.mock.calls
        .map((c: any[]) => c[1])
        .filter((s: unknown): s is string => typeof s === 'string');
      expect(sentTexts).not.toContain('Hello');
      expect(sentTexts).not.toContain('world');
      // The ✅ Complete result marker is NOT assistant text — it still goes via sendMessage.
      expect(sentTexts.some((s) => s.startsWith('✅ Complete'))).toBe(true);
    });

    it('degrades to sendMessage (streaming callbacks unused) when supportsStreaming is false', async () => {
      const localCallbacks = {
        ...createMockCallbacks(),
        getCapabilities: vi.fn(() => caps(false)),
        // Provided to prove their presence alone does NOT activate streaming.
        startStreaming: vi.fn(() => Promise.resolve('card-x')),
        streamText: vi.fn(() => Promise.resolve()),
        finalizeStreaming: vi.fn(() => Promise.resolve()),
      };
      const agent = new ChatAgent({
        chatId: 'oc_nostream',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* noStreamIterator() {
        yield { parsed: { type: 'text', role: 'assistant', content: 'Hi there' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 5' }, raw: {} };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: noStreamIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({ chatId: 'oc_nostream', payload: 'hi', messageId: 'msg_1' });
      await vi.waitFor(() => {
        expect(localCallbacks.sendMessage.mock.calls.some(
          (c: any[]) => c[1] === 'Hi there'
        )).toBe(true);
      }, { timeout: 1000, interval: 20 });

      // Default-off: streaming callbacks never used even though they are present.
      expect(localCallbacks.startStreaming).not.toHaveBeenCalled();
      expect(localCallbacks.streamText).not.toHaveBeenCalled();
      expect(localCallbacks.finalizeStreaming).not.toHaveBeenCalled();
    });
  });

  // Issue #4510 (part 2, 2026-08-16 revision): the p2p-first gray rollout is
  // built-in, not a config scope — streaming cards are only constructed for
  // single chats; group/topic turns always keep the per-chunk sendMessage
  // path bit-identically, regardless of how the channel advertises
  // supportsStreaming.
  describe('Issue #4510: p2p-only streaming (built-in chat-type gate)', () => {
    const capsStreaming = (supportsStreaming: boolean) => ({
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: true,
      supportsStreaming,
    });

    async function runTurn(chatType: string | undefined, supportsStreaming: boolean) {
      const localCallbacks = {
        ...createMockCallbacks(),
        getCapabilities: vi.fn(() => capsStreaming(supportsStreaming)),
        startStreaming: vi.fn(() => Promise.resolve('card-99')),
        streamText: vi.fn(() => Promise.resolve()),
        finalizeStreaming: vi.fn(() => Promise.resolve()),
      };
      const agent = new ChatAgent({
        chatId: 'oc_scope',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });

      async function* scopedIterator() {
        yield { parsed: { type: 'text', role: 'assistant', content: 'Chunk' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 3' }, raw: {} };
      }

      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: scopedIterator(),
      });
      (agent as any).isAgentTeamsEnabled = () => false;

      void agent.processMessage({ chatId: 'oc_scope', payload: 'hi', messageId: 'msg_1', chatType });
      await vi.waitFor(() => {
        expect(localCallbacks.sendMessage.mock.calls.some(
          (c: any[]) => typeof c[1] === 'string' && c[1].startsWith('✅ Complete')
        )).toBe(true);
      }, { timeout: 1000, interval: 20 });
      return localCallbacks;
    }

    it('streams for a p2p chat when the flag is on', async () => {
      const cb = await runTurn('p2p', true);
      expect(cb.startStreaming).toHaveBeenCalledTimes(1);
      expect(cb.finalizeStreaming).toHaveBeenCalledWith('card-99');
      expect(cb.sendMessage.mock.calls.some((c: any[]) => c[1] === 'Chunk')).toBe(false);
    });

    it('falls back to sendMessage for a group chat even when the flag is on (built-in p2p narrowing)', async () => {
      const cb = await runTurn('group', true);
      expect(cb.startStreaming).not.toHaveBeenCalled();
      expect(cb.streamText).not.toHaveBeenCalled();
      expect(cb.finalizeStreaming).not.toHaveBeenCalled();
      expect(cb.sendMessage.mock.calls.some((c: any[]) => c[1] === 'Chunk')).toBe(true);
    });

    it('falls back to sendMessage for a topic chat even when the flag is on (thread groups stay non-streaming)', async () => {
      const cb = await runTurn('topic', true);
      expect(cb.startStreaming).not.toHaveBeenCalled();
      expect(cb.finalizeStreaming).not.toHaveBeenCalled();
      expect(cb.sendMessage.mock.calls.some((c: any[]) => c[1] === 'Chunk')).toBe(true);
    });

    it('does not stream for a p2p chat when the flag is off (default-off unchanged)', async () => {
      const cb = await runTurn('p2p', false);
      expect(cb.startStreaming).not.toHaveBeenCalled();
      expect(cb.sendMessage.mock.calls.some((c: any[]) => c[1] === 'Chunk')).toBe(true);
    });

    // Issue #4510 acceptance #5: the full 3 chatType × 2 flag matrix. The two
    // flag-off cells below are logically short-circuited before the chatType
    // check (supportsStreaming=false → no driver), but pin them so the matrix
    // is explicitly covered against future gate reordering.
    it.each([
      ['group', 'group chat'],
      ['topic', 'topic chat'],
    ])('does not stream for a %s when the flag is off', async (chatType) => {
      const cb = await runTurn(chatType, false);
      expect(cb.startStreaming).not.toHaveBeenCalled();
      expect(cb.streamText).not.toHaveBeenCalled();
      expect(cb.finalizeStreaming).not.toHaveBeenCalled();
      expect(cb.sendMessage.mock.calls.some((c: any[]) => c[1] === 'Chunk')).toBe(true);
    });

    it('degrades to sendMessage when the flag is on and chatType is unknown (fail-safe)', async () => {
      const cb = await runTurn(undefined, true);
      expect(cb.startStreaming).not.toHaveBeenCalled();
      expect(cb.sendMessage.mock.calls.some((c: any[]) => c[1] === 'Chunk')).toBe(true);
    });
  });
});

  // Issue #4649 (review ③): the turn-completion promise was a single slot
  // written at PUSH time. A message queued behind a running turn overwrote
  // the slot, so (a) the in-flight turn's await was rejected as "superseded"
  // even though that turn was alive and would finish on its own (review ①
  // shape), and (b) the in-flight turn's result then resolved the QUEUED
  // message's promise — a fake "completed" recorded by the scheduler while
  // the queued turn had not started, its later death leaving nothing to
  // reject (the 38-day incident shape, preserved for queued messages —
  // review ③). These tests pin the per-message registry that replaces it.
  describe('Issue #4649 review ③: per-message turn completions', () => {
    /** 'pending' unless the promise has already settled (sync race — returns a Promise, never awaits). */
    function settlementOf(p: Promise<void>): Promise<'pending' | 'settled'> {
      return Promise.race([
        p.then(
          () => 'settled' as const,
          () => 'settled' as const,
        ),
        Promise.resolve('pending' as const),
      ]);
    }

    function makeAgent() {
      const localCallbacks = createMockCallbacks();
      const agent = new ChatAgent({
        chatId: 'oc_queue',
        callbacks: localCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      (agent as any).isAgentTeamsEnabled = () => false;
      return { agent, localCallbacks };
    }

    it('a queued message is NOT resolved by the previous turn\'s result — each message gets its own turn outcome', async () => {
      const { agent } = makeAgent();

      let releaseSecondTurn!: () => void;
      const secondTurnGate = new Promise<void>((resolve) => {
        releaseSecondTurn = resolve;
      });
      async function* twoGatedTurnsIterator() {
        yield { parsed: { type: 'text', role: 'assistant', content: 'turn 1 work' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 0.5k' }, raw: {} };
        await secondTurnGate; // park between turn 1's result and turn 2's events
        yield { parsed: { type: 'text', role: 'assistant', content: 'turn 2 work' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 0.5k' }, raw: {} };
      }
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: twoGatedTurnsIterator(),
      });

      // msg_1's turn is in flight; msg_2 (the scheduled one, say) queues
      // behind it on the same channel. Deterministic order: both
      // processMessage calls run synchronously to their first await, then
      // resume in FIFO microtask order, so msg_1 pushes first.
      await Promise.all([
        agent.processMessage({ chatId: 'oc_queue', payload: 'first', messageId: 'msg_1' }),
        agent.processMessage({ chatId: 'oc_queue', payload: 'second', messageId: 'msg_2' }),
      ]);

      const t1 = agent.turnCompleteFor('msg_1');
      const t2 = agent.turnCompleteFor('msg_2');
      expect(t1).toBeDefined();
      expect(t2).toBeDefined();

      // Turn 1's result settles ONLY msg_1's promise. Pre-fix (single slot):
      // it resolved msg_2's promise — the scheduler logged "completed" while
      // msg_2's turn had not started.
      await t1!;
      expect(await settlementOf(t2!)).toBe('pending');

      // Corollary (review ①): the queued push did not reject msg_1's promise
      // either — no fake "Turn superseded" for a turn that is alive and
      // finishing on its own. (t1 resolved above, it did not reject.)
      releaseSecondTurn();
      await t2!;
    });

    it('a queued message\'s turn death is visible: session death rejects its completion promise', async () => {
      // The other half of the incident shape: msg_2's queued turn dies with
      // the session. Pre-fix, the slot was already cleared by turn 1's
      // result, so the death was invisible (and the scheduler had already
      // recorded "completed"). Now the rejection is observable.
      const { agent } = makeAgent();

      async function* resultThenThrowIterator() {
        yield { parsed: { type: 'text', role: 'assistant', content: 'turn 1 work' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 0.5k' }, raw: {} };
        throw new Error('Iterator died mid-session');
      }
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: resultThenThrowIterator(),
      });

      await Promise.all([
        agent.processMessage({ chatId: 'oc_queue', payload: 'first', messageId: 'msg_1' }),
        agent.processMessage({ chatId: 'oc_queue', payload: 'second', messageId: 'msg_2' }),
      ]);

      const t1 = agent.turnCompleteFor('msg_1')!;
      const t2 = agent.turnCompleteFor('msg_2')!;

      await t1; // turn 1 completed normally
      await expect(t2).rejects.toThrow('Iterator died mid-session');
    });

    it('a message whose channel push is rejected gets its OWN rejection — live turns\' awaiters are untouched', async () => {
      // Channel closed at push: pre-fix this called rejectTurn() on the
      // single slot, and post-③ rejectTurn() settles ALL entries — the push
      // site must settle only the refused message's entry so an unrelated
      // in-flight turn's awaiter is not dragged into the failure.
      const { agent } = makeAgent();

      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      async function* gatedTurnIterator() {
        await turnGate;
        yield { parsed: { type: 'text', role: 'assistant', content: 'work' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 0.5k' }, raw: {} };
      }
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: gatedTurnIterator(),
      });

      // msg_1 accepted, its turn parks on the gate.
      await agent.processMessage({ chatId: 'oc_queue', payload: 'first', messageId: 'msg_1' });
      const t1 = agent.turnCompleteFor('msg_1')!;

      // msg_2: close the channel so its push is refused.
      (agent as any).channel = { push: () => false, close: vi.fn(), generator: vi.fn() };
      await agent.processMessage({ chatId: 'oc_queue', payload: 'second', messageId: 'msg_2' });

      await expect(agent.turnCompleteFor('msg_2')!).rejects.toThrow('Channel closed');
      expect(await settlementOf(t1)).toBe('pending'); // msg_1's turn unaffected

      releaseTurn();
      await t1; // still resolves with its own turn's outcome
    });

    it('turnCompleteFor: unknown messageId → undefined (never-started is distinguishable from finished)', async () => {
      // The contract turn ⑤ builds on: the handler treats undefined as a
      // FAILURE (message never entered a turn), so it must never be returned
      // for a message whose turn merely already finished.
      const { agent } = makeAgent();

      async function* oneTurnIterator() {
        yield { parsed: { type: 'text', role: 'assistant', content: 'work' }, raw: {} };
        yield { parsed: { type: 'result', content: '✅ Complete | Cost: $0.01 | Tokens: 0.5k' }, raw: {} };
      }
      (agent as any).createQueryStream = () => ({
        handle: { close: vi.fn(), cancel: vi.fn() },
        iterator: oneTurnIterator(),
      });

      expect(agent.turnCompleteFor('never_pushed')).toBeUndefined();

      await agent.processMessage({ chatId: 'oc_queue', payload: 'hello', messageId: 'msg_1' });
      await agent.turnCompleteFor('msg_1')!; // settles with the turn
      // Still retrievable AFTER settling — a caller grabbing it right after
      // processMessage() resolves can never miss it (pre-fix the slot was
      // cleared, making "finished" indistinguishable from "never started").
      expect(agent.turnCompleteFor('msg_1')).toBeDefined();
    });
  });
