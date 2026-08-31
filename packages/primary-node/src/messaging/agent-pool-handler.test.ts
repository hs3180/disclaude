/**
 * Tests for AgentPoolMessageHandler.
 *
 * Covers:
 * - Constructor with required and optional options
 * - handleUserMessage: agent pool delegation, fire-and-forget pattern
 * - handleSystemMessage: unified agent pool path (RFC #3329)
 * - Attachment forwarding via UserMessageParams
 * - Error handling: getOrCreateChatAgent failures, processMessage rejections
 *
 * @see Issue #1617 Phase 4
 * @see Issue #3838 type fix — aligned with UserMessageParams-based API
 * @see Issue #3962 — error handling for agent creation and processMessage failures
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnSupersededError } from '@disclaude/core';
import { AgentPoolMessageHandler, type AgentPoolHandlerOptions } from './agent-pool-handler.js';
import type { ChatAgent } from '../agents/chat-agent.js';
import type { ChatAgentCallbacks } from '../agents/types.js';
import type pino from 'pino';

// Silence logger
const silentLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;

function createMockAgent(): ChatAgent {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
    // Issue #4649 (review ③⑤): the handler's waitForCompletion path pins the
    // turn via turnCompleteFor(messageId) — undefined by default so tests can
    // override per-case.
    turnCompleteFor: vi.fn(() => undefined),
  } as unknown as ChatAgent;
}

function createMockOptions(overrides?: Partial<AgentPoolHandlerOptions>): AgentPoolHandlerOptions {
  const mockAgent = createMockAgent();
  return {
    agentPool: {
      getOrCreateChatAgent: vi.fn().mockReturnValue(mockAgent),
    },
    callbacksFactory: vi.fn().mockReturnValue({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      onQueryComplete: vi.fn(),
    } as unknown as ChatAgentCallbacks),
    logger: silentLogger,
    ...overrides,
  };
}

describe('AgentPoolMessageHandler', () => {
  let handler: AgentPoolMessageHandler;
  let options: AgentPoolHandlerOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    options = createMockOptions();
    handler = new AgentPoolMessageHandler(options);
  });

  describe('constructor', () => {
    it('should create handler with all options', () => {
      const h = new AgentPoolMessageHandler(options);
      expect(h).toBeInstanceOf(AgentPoolMessageHandler);
    });

    it('should create handler without logger (uses default)', () => {
      const { logger: _, ...optsWithoutLogger } = options;
      const h = new AgentPoolMessageHandler(optsWithoutLogger as AgentPoolHandlerOptions);
      expect(h).toBeInstanceOf(AgentPoolMessageHandler);
    });
  });

  describe('handleUserMessage', () => {
    it('should get agent from pool and process message', async () => {
      await handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello', messageId: 'msg-1' });

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'chat-1',
        expect.any(Object),
        undefined, // Issue #4587 (part 2): no threadRootId → chat-scoped agent
      );
    });

    it('should call callbacksFactory with chatId', async () => {
      await handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello', messageId: 'msg-1' });

      expect(options.callbacksFactory).toHaveBeenCalledWith('chat-1');
    });

    it('should call agent.processMessage with UserMessageParams including attachments', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      const attachments = [{ id: 'att-1', fileName: 'test.png', mimeType: 'image/png', source: 'user' as const, createdAt: Date.now(), localPath: '/tmp/test.png' }];
      await handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello', messageId: 'msg-1', senderOpenId: 'user-1', attachments, chatHistoryContext: 'history context' });

      expect(mockAgent.processMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        payload: 'Hello',
        messageId: 'msg-1',
        senderOpenId: 'user-1',
        attachments,
        chatHistoryContext: 'history context',
      });
    });

    it('should handle message without optional fields', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello', messageId: 'msg-1' });

      expect(mockAgent.processMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        payload: 'Hello',
        messageId: 'msg-1',
      });
    });

    it('should return immediately (fire-and-forget)', async () => {
      // Even if processMessage is slow, handleUserMessage returns immediately
      const slowAgent = createMockAgent();
      vi.mocked(slowAgent.processMessage).mockReturnValue(new Promise(() => {})); // never resolves
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(slowAgent);

      // Should resolve immediately
      const result = handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello', messageId: 'msg-1' });
      await expect(result).resolves.toBeUndefined();
    });

    it('should handle multiple messages for different chats', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent)
        .mockReturnValueOnce(agent1)
        .mockReturnValueOnce(agent2);

      await handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello 1', messageId: 'msg-1' });
      await handler.handleUserMessage({ chatId: 'chat-2', payload: 'Hello 2', messageId: 'msg-2' });

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledTimes(2);
      expect(agent1.processMessage).toHaveBeenCalledWith({ chatId: 'chat-1', payload: 'Hello 1', messageId: 'msg-1' });
      expect(agent2.processMessage).toHaveBeenCalledWith({ chatId: 'chat-2', payload: 'Hello 2', messageId: 'msg-2' });
    });

    it('should catch getOrCreateChatAgent errors and notify user', async () => {
      const spawnError = new Error('Agent subprocess failed to spawn');
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockImplementation(() => { throw spawnError; });

      const result = handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello', messageId: 'msg-1' });

      // Should return resolved promise (not reject)
      await expect(result).resolves.toBeUndefined();

      // Should log the error with context
      expect(silentLogger.error).toHaveBeenCalledWith(
        { err: spawnError, chatId: 'chat-1', messageId: 'msg-1' },
        expect.stringContaining('Failed to create/get ChatAgent'),
      );

      // Should notify user with actionable error message
      const callbacks = vi.mocked(options.callbacksFactory).mock.results[0]!.value as ChatAgentCallbacks;
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        expect.stringContaining('/reset'),
        'msg-1',
      );
    });

    it('should catch processMessage rejection and log error', async () => {
      const mockAgent = createMockAgent();
      const processError = new Error('IPC socket disconnected');
      vi.mocked(mockAgent.processMessage).mockRejectedValue(processError);
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello', messageId: 'msg-1' });

      // Wait for the async .catch handler to execute
      await vi.waitFor(() => {
        expect(silentLogger.error).toHaveBeenCalledWith(
          { err: processError, chatId: 'chat-1', messageId: 'msg-1' },
          'Agent processMessage failed for user message',
        );
      });
    });

    // Issue #4587 (part 2): topic-group thread messages route to that
    // thread's own agent (pool keys on chatId::threadRoot).
    it('should pass threadRootId to the pool for a topic-group thread message (#4587 part 2)', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleUserMessage({
        chatId: 'oc_topic',
        payload: '研报问题',
        messageId: 'om_1',
        threadRootId: 'om_root',
      });

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'oc_topic',
        expect.any(Object),
        'om_root',
      );
      // The agent still receives the full params — processMessage's
      // threadRootId drives the reply anchor (part 1), unchanged here.
      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'oc_topic', messageId: 'om_1', threadRootId: 'om_root' }),
      );
    });

    it('should omit the thread argument for messages without threadRootId (#4587 part 2)', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleUserMessage({ chatId: 'chat-1', payload: 'Hello', messageId: 'msg-1' });

      // undefined threadRootId → chat-scoped agent, exactly as before.
      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'chat-1',
        expect.any(Object),
        undefined,
      );
    });
  });

  describe('handleSystemMessage', () => {
    it('should route system messages through agent pool (unified path, RFC #3329)', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1');

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'chat-1',
        expect.any(Object),
        undefined, // Issue #4587 (part 2): system messages stay chat-scoped
      );
      expect(mockAgent.processMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        payload: 'system payload',
        messageId: 'msg-sys-1',
      });
    });

    it('should return a resolved promise', async () => {
      const result = handler.handleSystemMessage('chat-1', 'payload', 'msg-1');
      await expect(result).resolves.toBeUndefined();
    });

    it('should catch getOrCreateChatAgent errors and notify user', async () => {
      const spawnError = new Error('Agent subprocess failed to spawn');
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockImplementation(() => { throw spawnError; });

      const result = handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1');

      // Should return resolved promise (not reject)
      await expect(result).resolves.toBeUndefined();

      // Should log the error with context
      expect(silentLogger.error).toHaveBeenCalledWith(
        { err: spawnError, chatId: 'chat-1', messageId: 'msg-sys-1' },
        expect.stringContaining('Failed to create/get ChatAgent'),
      );

      // Should notify user
      const callbacks = vi.mocked(options.callbacksFactory).mock.results[0]!.value as ChatAgentCallbacks;
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        expect.stringContaining('/reset'),
        'msg-sys-1',
      );
    });

    it('should catch processMessage rejection and log error', async () => {
      const mockAgent = createMockAgent();
      const processError = new Error('IPC socket disconnected');
      vi.mocked(mockAgent.processMessage).mockRejectedValue(processError);
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1');

      // Wait for the async .catch handler to execute
      await vi.waitFor(() => {
        expect(silentLogger.error).toHaveBeenCalledWith(
          { err: processError, chatId: 'chat-1', messageId: 'msg-sys-1' },
          'Agent processMessage failed for system message',
        );
      });
    });

    // Issue #4587 (part 2): system messages have no thread identity
    // (scheduler / loop tasks) and stay chat-scoped by design.
    it('should stay chat-scoped for system messages (no thread keying, #4587 part 2)', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleSystemMessage('oc_topic', 'scheduled payload', 'msg-sched');

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'oc_topic',
        expect.any(Object),
        undefined,
      );
    });

    // Issue #4648: the Scheduler now sets waitForCompletion on every
    // scheduled SystemMessage, so this branch (#4063, previously only the
    // Loop Runner) is on the critical path for ALL scheduled tasks — the
    // scheduler's "completed"/"failed" status is only as truthful as this
    // await. These tests pin the contract.
    describe('waitForCompletion: true (Issue #4648)', () => {
      it('waits for THIS message\'s turn (turnCompleteFor) before resolving — not just processMessage queueing (#4649 ③)', async () => {
        let releaseTurn!: () => void;
        const turnComplete = new Promise<void>((resolve) => { releaseTurn = resolve; });
        const mockAgent = {
          ...createMockAgent(),
          turnCompleteFor: vi.fn(() => turnComplete),
        } as unknown as ChatAgent;
        vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

        let settled = false;
        const result = handler
          .handleSystemMessage('chat-1', 'system payload', 'msg-sys-1', { waitForCompletion: true })
          .then(() => { settled = true; });

        // processMessage (queueing) has resolved, but the turn is still
        // running — the handler must NOT settle yet.
        await new Promise((r) => setImmediate(r));
        expect(mockAgent.processMessage).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);

        // Issue #4649 (review ③): per-message pin — the handler must look up
        // THIS message's turn, not whichever promise a getter happens to
        // expose (under interleaving that is another message's turn).
        expect(mockAgent.turnCompleteFor).toHaveBeenCalledWith('msg-sys-1');

        releaseTurn();
        await result;
        expect(settled).toBe(true);
      });

      it('propagates a failed turn so the scheduler failure path fires (#4648)', async () => {
        // The incident shape: the turn dies mid-stream and the per-turn
        // promise rejects. The handler must rethrow — that rejection is
        // exactly what turns the scheduler log into "failed" instead of the
        // premature "completed" that hid 38 days of dead runs.
        const turnError = new Error('Request failed with status code 400');
        const mockAgent = {
          ...createMockAgent(),
          turnCompleteFor: vi.fn(() => Promise.reject(turnError)),
        } as unknown as ChatAgent;
        vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

        await expect(
          handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1', { waitForCompletion: true }),
        ).rejects.toThrow('Request failed with status code 400');
      });

      it('propagates TurnSupersededError unwrapped so the scheduler can neutralize it (#4649 ①)', async () => {
        // Identity matters: the Scheduler branches on instanceof — a wrapped
        // or re-created error would fall into the generic failure path and
        // reintroduce the false-❌-on-interjection regression the typed error
        // exists to fix.
        const superseded = new TurnSupersededError();
        const mockAgent = {
          ...createMockAgent(),
          turnCompleteFor: vi.fn(() => Promise.reject(superseded)),
        } as unknown as ChatAgent;
        vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

        await expect(
          handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1', { waitForCompletion: true }),
        ).rejects.toBe(superseded);
      });

      it('rejects when the agent exposes no turn for this message — never-started is a failure, not completed (#4649 ⑤)', async () => {
        // Pre-#4649-review-⑤ this logged a warning and RESOLVED, so chronic
        // infrastructure failures (no session channel after session start)
        // were recorded as "completed" and stayed invisible to the #4648
        // consecutive-failure alert. The handler must reject instead.
        const mockAgent = createMockAgent(); // turnCompleteFor → undefined
        vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

        await expect(
          handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1', { waitForCompletion: true }),
        ).rejects.toThrow('Agent turn never started');

        expect(silentLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ chatId: 'chat-1', messageId: 'msg-sys-1' }),
          expect.stringContaining('waitForCompletion'),
        );
      });

      it('rejects when ChatAgent creation fails — agent-creation outage is countable, not "completed" (#4649 ⑤)', async () => {
        // Same reasoning as above for the no-agent path: the pool throwing
        // must reach the scheduler's failure branch. (getAgentSafely already
        // sent the user-facing "⚠️ Agent 创建失败" notice; the rejection is
        // the countable signal.) Without waitForCompletion the promise still
        // resolves — fire-and-forget callers keep their old contract.
        vi.mocked(options.agentPool.getOrCreateChatAgent).mockImplementation(() => {
          throw new Error('spawn failed');
        });

        await expect(
          handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1', { waitForCompletion: true }),
        ).rejects.toThrow('ChatAgent creation failed');

        await expect(
          handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1'),
        ).resolves.toBeUndefined();
      });
    });
  });
});
