/**
 * Tests for AgentPoolMessageHandler.
 *
 * Verifies that the handler correctly bridges InputMessageRouter
 * with the existing ChatAgent pool.
 *
 * Issue #3659: Test coverage for RFC #3329 related components.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentPoolMessageHandler, type AgentPoolHandlerOptions } from './agent-pool-handler.js';
import type { ChatAgent } from '../agents/chat-agent.js';
import type { ChatAgentCallbacks } from '../agents/types.js';

// Mock ChatAgent with processMessage method
function createMockChatAgent(): ChatAgent {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatAgent;
}

// Default callbacks factory
function createMockCallbacksFactory(): (chatId: string) => ChatAgentCallbacks {
  return (_chatId: string) => ({
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
  });
}

describe('AgentPoolMessageHandler', () => {
  let handler: AgentPoolMessageHandler;
  let mockAgentPool: AgentPoolHandlerOptions['agentPool'];
  let callbacksFactory: AgentPoolHandlerOptions['callbacksFactory'];
  let mockAgent: ReturnType<typeof createMockChatAgent>;

  beforeEach(() => {
    mockAgent = createMockChatAgent();
    mockAgentPool = {
      getOrCreateChatAgent: vi.fn().mockReturnValue(mockAgent),
    };
    callbacksFactory = createMockCallbacksFactory();
    handler = new AgentPoolMessageHandler({
      agentPool: mockAgentPool,
      callbacksFactory,
    });
  });

  describe('handleUserMessage', () => {
    it('should get or create agent from pool and process message', async () => {
      await handler.handleUserMessage('oc_test', 'Hello', 'msg-1');

      expect(mockAgentPool.getOrCreateChatAgent).toHaveBeenCalledTimes(1);
      expect(mockAgentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'oc_test',
        expect.any(Object),
      );
      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'oc_test',
        'Hello',
        'msg-1',
        undefined,
        undefined,
        undefined,
      );
    });

    it('should pass all user message parameters to agent', async () => {
      const attachments = [{ fileId: 'file-1', fileName: 'test.png' }];
      await handler.handleUserMessage(
        'oc_test',
        'Hello with files',
        'msg-2',
        'ou_sender123',
        attachments as any,
        'chat history context',
      );

      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'oc_test',
        'Hello with files',
        'msg-2',
        'ou_sender123',
        attachments,
        'chat history context',
      );
    });

    it('should pass chatId-specific callbacks to agent pool', async () => {
      const capturedCallbacks: ChatAgentCallbacks[] = [];
      const customFactory = (_chatId: string): ChatAgentCallbacks => {
        const cbs: ChatAgentCallbacks = {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendCard: vi.fn().mockResolvedValue(undefined),
          sendFile: vi.fn().mockResolvedValue(undefined),
        };
        capturedCallbacks.push(cbs);
        return cbs;
      };

      const customHandler = new AgentPoolMessageHandler({
        agentPool: mockAgentPool,
        callbacksFactory: customFactory,
      });

      await customHandler.handleUserMessage('oc_chat1', 'msg', 'm1');
      await customHandler.handleUserMessage('oc_chat2', 'msg', 'm2');

      expect(capturedCallbacks).toHaveLength(2);
      expect(mockAgentPool.getOrCreateChatAgent).toHaveBeenNthCalledWith(
        1,
        'oc_chat1',
        capturedCallbacks[0],
      );
      expect(mockAgentPool.getOrCreateChatAgent).toHaveBeenNthCalledWith(
        2,
        'oc_chat2',
        capturedCallbacks[1],
      );
    });

    it('should return immediately (fire-and-forget pattern)', async () => {
      // processMessage returns a promise that hasn't resolved yet
      let resolveProcessMessage: () => void;
      (mockAgent.processMessage as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<void>((resolve) => {
          resolveProcessMessage = resolve;
        }),
      );

      // handleUserMessage should return immediately
      const result = handler.handleUserMessage('oc_test', 'Hello', 'msg-1');

      // Should resolve without waiting for processMessage
      await result;

      // processMessage was called but not yet resolved
      expect(mockAgent.processMessage).toHaveBeenCalled();

      // Now resolve
      resolveProcessMessage!();
    });
  });

  describe('handleSystemMessage', () => {
    it('should delegate to systemExecutor when provided', async () => {
      const mockSystemExecutor = vi.fn().mockResolvedValue(undefined);
      const handlerWithExecutor = new AgentPoolMessageHandler({
        agentPool: mockAgentPool,
        callbacksFactory,
        systemExecutor: mockSystemExecutor,
      });

      await handlerWithExecutor.handleSystemMessage('oc_test', 'System prompt', 'sched-1');

      expect(mockSystemExecutor).toHaveBeenCalledWith('oc_test', 'System prompt', 'sched-1');
      // Should NOT use agent pool when systemExecutor is provided
      expect(mockAgentPool.getOrCreateChatAgent).not.toHaveBeenCalled();
    });

    it('should fall back to agent pool when no systemExecutor', async () => {
      await handler.handleSystemMessage('oc_test', 'System prompt', 'sched-1');

      // Should use agent pool
      expect(mockAgentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'oc_test',
        expect.any(Object),
      );
      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'oc_test',
        'System prompt',
        'sched-1',
      );
    });

    it('should await systemExecutor completion', async () => {
      let resolveExecutor: () => void;
      const mockSystemExecutor = vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          resolveExecutor = resolve;
        }),
      );

      const handlerWithExecutor = new AgentPoolMessageHandler({
        agentPool: mockAgentPool,
        callbacksFactory,
        systemExecutor: mockSystemExecutor,
      });

      const promise = handlerWithExecutor.handleSystemMessage('oc_test', 'prompt', 'id-1');

      // Should not be resolved yet
      let resolved = false;
      void promise.then(() => { resolved = true; });
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      // Resolve the executor
      resolveExecutor!();
      await promise;
      expect(resolved).toBe(true);
    });

    it('should propagate errors from systemExecutor', async () => {
      const mockSystemExecutor = vi.fn().mockRejectedValue(new Error('Executor failed'));
      const handlerWithExecutor = new AgentPoolMessageHandler({
        agentPool: mockAgentPool,
        callbacksFactory,
        systemExecutor: mockSystemExecutor,
      });

      await expect(
        handlerWithExecutor.handleSystemMessage('oc_test', 'prompt', 'id-1'),
      ).rejects.toThrow('Executor failed');
    });
  });

  describe('constructor', () => {
    it('should accept custom logger', () => {
      const customLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
        level: 'info',
      } as any;

      const handlerWithLogger = new AgentPoolMessageHandler({
        agentPool: mockAgentPool,
        callbacksFactory,
        logger: customLogger,
      });

      expect(handlerWithLogger).toBeDefined();
    });
  });
});
