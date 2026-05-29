/**
 * Tests for AgentPoolMessageHandler.
 *
 * Covers:
 * - Constructor with required and optional options
 * - handleUserMessage: agent pool delegation, fire-and-forget pattern
 * - handleSystemMessage: unified agent pool path (RFC #3329)
 * - Attachment forwarding via UserMessageParams
 *
 * @see Issue #1617 Phase 4
 * @see Issue #3838 type fix — aligned with UserMessageParams-based API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentPoolMessageHandler, type AgentPoolHandlerOptions } from './agent-pool-handler.js';
import type { ChatAgent } from '../agents/chat-agent.js';
import type { ChatAgentCallbacks } from '../agents/types.js';
import type pino from 'pino';

// Silence logger
const silentLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger;

function createMockAgent(): ChatAgent {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
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
  });

  describe('handleSystemMessage', () => {
    it('should route system messages through agent pool (unified path, RFC #3329)', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1');

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'chat-1',
        expect.any(Object),
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
  });
});
