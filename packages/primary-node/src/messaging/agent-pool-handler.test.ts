/**
 * Tests for AgentPoolMessageHandler (packages/primary-node/src/messaging/agent-pool-handler.ts)
 *
 * Issue #1617: Phase 3/4 — increasing unit test coverage to 70%.
 *
 * Tests cover:
 * 1. handleUserMessage() creates agent via pool and delegates to processMessage
 * 2. handleUserMessage() passes all parameters correctly (chatId, payload, messageId, senderOpenId, attachments, chatHistoryContext)
 * 3. handleUserMessage() returns immediately (fire-and-forget pattern)
 * 4. handleSystemMessage() with systemExecutor delegates to executor
 * 5. handleSystemMessage() without systemExecutor falls back to persistent agent
 * 6. Constructor accepts custom logger
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { AgentPoolMessageHandler } from './agent-pool-handler.js';
import type { ChatAgentCallbacks } from '../agents/types.js';
import type { ChatAgent } from '../agents/chat-agent.js';

/** Create a mock ChatAgent */
const createMockAgent = (): ChatAgent =>
  ({
    processMessage: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    stop: vi.fn().mockReturnValue(false),
  }) as unknown as ChatAgent;

/** Create mock ChatAgentCallbacks */
const createMockCallbacks = (): ChatAgentCallbacks => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
});

describe('AgentPoolMessageHandler', () => {
  let mockAgent: ChatAgent;
  let mockAgentPool: { getOrCreateChatAgent: ReturnType<typeof vi.fn> };
  let mockCallbacksFactory: ReturnType<typeof vi.fn>;
  let handler: AgentPoolMessageHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent = createMockAgent();
    mockAgentPool = {
      getOrCreateChatAgent: vi.fn().mockReturnValue(mockAgent),
    };
    mockCallbacksFactory = vi.fn().mockReturnValue(createMockCallbacks());
    handler = new AgentPoolMessageHandler({
      agentPool: mockAgentPool,
      callbacksFactory: mockCallbacksFactory,
    });
  });

  // ==========================================================================
  // handleUserMessage()
  // ==========================================================================

  describe('handleUserMessage()', () => {
    it('should get/create agent and call processMessage with all params', async () => {
      const result = await handler.handleUserMessage(
        'chat-1',
        'Hello world',
        'msg-001',
        'user-open-id',
        [{ fileId: 'f1', fileName: 'doc.pdf' }] as any,
        'previous context',
      );

      expect(mockCallbacksFactory).toHaveBeenCalledWith('chat-1');
      expect(mockAgentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'chat-1',
        expect.anything(),
      );
      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'chat-1',
        'Hello world',
        'msg-001',
        'user-open-id',
        [{ fileId: 'f1', fileName: 'doc.pdf' }],
        'previous context',
      );
      // Fire-and-forget: resolves immediately regardless of processMessage
      expect(result).toBeUndefined();
    });

    it('should work with minimal params (no senderOpenId, attachments, or chatHistoryContext)', async () => {
      await handler.handleUserMessage('chat-2', 'Hi', 'msg-002');

      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'chat-2',
        'Hi',
        'msg-002',
        undefined,
        undefined,
        undefined,
      );
    });

    it('should return immediately (fire-and-forget) even if processMessage is slow', async () => {
      let resolveProcess: () => void = () => {};
      vi.mocked(mockAgent.processMessage).mockImplementation(
        () => new Promise<void>((resolve) => { resolveProcess = resolve; }),
      );

      const result = await handler.handleUserMessage('chat-1', 'test', 'msg-003');

      // Should resolve immediately before processMessage completes
      expect(result).toBeUndefined();

      resolveProcess();
    });
  });

  // ==========================================================================
  // handleSystemMessage()
  // ==========================================================================

  describe('handleSystemMessage()', () => {
    it('should delegate to systemExecutor when provided', async () => {
      const systemExecutor = vi.fn().mockResolvedValue(undefined);
      handler = new AgentPoolMessageHandler({
        agentPool: mockAgentPool,
        callbacksFactory: mockCallbacksFactory,
        systemExecutor,
      });

      await handler.handleSystemMessage('chat-1', '/reset', 'msg-010');

      expect(systemExecutor).toHaveBeenCalledWith('chat-1', '/reset', 'msg-010');
      // Should NOT use pool when systemExecutor is available
      expect(mockAgentPool.getOrCreateChatAgent).not.toHaveBeenCalled();
    });

    it('should fall back to persistent agent when no systemExecutor', async () => {
      await handler.handleSystemMessage('chat-1', '/status', 'msg-011');

      expect(mockCallbacksFactory).toHaveBeenCalledWith('chat-1');
      expect(mockAgentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'chat-1',
        expect.anything(),
      );
      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'chat-1',
        '/status',
        'msg-011',
      );
    });

    it('should await systemExecutor before returning', async () => {
      const executorCallOrder: string[] = [];
      const systemExecutor = vi.fn().mockImplementation(async () => {
        executorCallOrder.push('executor-start');
        await new Promise((r) => setTimeout(r, 10));
        executorCallOrder.push('executor-done');
      });

      handler = new AgentPoolMessageHandler({
        agentPool: mockAgentPool,
        callbacksFactory: mockCallbacksFactory,
        systemExecutor,
      });

      await handler.handleSystemMessage('chat-1', '/test', 'msg-012');

      expect(executorCallOrder).toEqual(['executor-start', 'executor-done']);
    });
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should accept a custom logger', () => {
      const customLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as Logger;

      const handlerWithLogger = new AgentPoolMessageHandler({
        agentPool: mockAgentPool,
        callbacksFactory: mockCallbacksFactory,
        logger: customLogger,
      });

      // Handler should use custom logger (verify it doesn't throw)
      expect(handlerWithLogger).toBeDefined();
    });
  });
});
