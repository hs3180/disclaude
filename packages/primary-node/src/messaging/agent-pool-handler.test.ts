/**
 * Tests for AgentPoolMessageHandler.
 *
 * Covers:
 * - Constructor with required and optional options
 * - handleUserMessage: agent pool delegation, fire-and-forget pattern
 * - handleSystemMessage: with/without systemExecutor
 * - Attachment forwarding
 * - chatHistoryContext forwarding
 *
 * @see Issue #1617 Phase 4
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
      const h = new AgentPoolMessageHandler({
        ...options,
        systemExecutor: vi.fn().mockResolvedValue(undefined),
      });
      expect(h).toBeInstanceOf(AgentPoolMessageHandler);
    });

    it('should create handler without systemExecutor', () => {
      const { systemExecutor: _, ...optsWithoutExecutor } = options;
      const h = new AgentPoolMessageHandler(optsWithoutExecutor as AgentPoolHandlerOptions);
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
      await handler.handleUserMessage('chat-1', 'Hello', 'msg-1');

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'chat-1',
        expect.any(Object),
      );
    });

    it('should call callbacksFactory with chatId', async () => {
      await handler.handleUserMessage('chat-1', 'Hello', 'msg-1');

      expect(options.callbacksFactory).toHaveBeenCalledWith('chat-1');
    });

    it('should call agent.processMessage with all arguments', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      const attachments = [{ id: 'att-1', fileName: 'test.png', mimeType: 'image/png', source: 'user' as const, createdAt: Date.now(), localPath: '/tmp/test.png' }];
      await handler.handleUserMessage('chat-1', 'Hello', 'msg-1', 'user-1', attachments, 'history context');

      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'chat-1',
        'Hello',
        'msg-1',
        'user-1',
        attachments,
        'history context',
      );
    });

    it('should handle message without optional args', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      await handler.handleUserMessage('chat-1', 'Hello', 'msg-1');

      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'chat-1',
        'Hello',
        'msg-1',
        undefined,
        undefined,
        undefined,
      );
    });

    it('should return immediately (fire-and-forget)', async () => {
      // Even if processMessage is slow, handleUserMessage returns immediately
      const slowAgent = createMockAgent();
      vi.mocked(slowAgent.processMessage).mockReturnValue(new Promise(() => {})); // never resolves
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(slowAgent);

      // Should resolve immediately
      const result = handler.handleUserMessage('chat-1', 'Hello', 'msg-1');
      await expect(result).resolves.toBeUndefined();
    });

    it('should handle multiple messages for different chats', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent)
        .mockReturnValueOnce(agent1)
        .mockReturnValueOnce(agent2);

      await handler.handleUserMessage('chat-1', 'Hello 1', 'msg-1');
      await handler.handleUserMessage('chat-2', 'Hello 2', 'msg-2');

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledTimes(2);
      expect(agent1.processMessage).toHaveBeenCalledWith('chat-1', 'Hello 1', 'msg-1', undefined, undefined, undefined);
      expect(agent2.processMessage).toHaveBeenCalledWith('chat-2', 'Hello 2', 'msg-2', undefined, undefined, undefined);
    });
  });

  describe('handleSystemMessage', () => {
    it('should delegate to systemExecutor when provided', async () => {
      const executor = vi.fn().mockResolvedValue(undefined);
      options = createMockOptions({ systemExecutor: executor });
      handler = new AgentPoolMessageHandler(options);

      await handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1');

      expect(executor).toHaveBeenCalledWith('chat-1', 'system payload', 'msg-sys-1');
      // Should NOT call agent pool when systemExecutor is present
      expect(options.agentPool.getOrCreateChatAgent).not.toHaveBeenCalled();
    });

    it('should fall back to agent pool when no systemExecutor', async () => {
      const mockAgent = createMockAgent();
      vi.mocked(options.agentPool.getOrCreateChatAgent).mockReturnValue(mockAgent);

      // Create handler without systemExecutor
      const { systemExecutor: _, ...optsNoExec } = options;
      handler = new AgentPoolMessageHandler(optsNoExec as AgentPoolHandlerOptions);

      await handler.handleSystemMessage('chat-1', 'system payload', 'msg-sys-1');

      expect(options.agentPool.getOrCreateChatAgent).toHaveBeenCalledWith(
        'chat-1',
        expect.any(Object),
      );
      expect(mockAgent.processMessage).toHaveBeenCalledWith(
        'chat-1',
        'system payload',
        'msg-sys-1',
      );
    });

    it('should await systemExecutor completion', async () => {
      let resolveExecutor: () => void = () => {};
      const executor = vi.fn().mockImplementation(() => new Promise<void>(r => { resolveExecutor = r; }));
      options = createMockOptions({ systemExecutor: executor });
      handler = new AgentPoolMessageHandler(options);

      const promise = handler.handleSystemMessage('chat-1', 'payload', 'msg-1');

      // Should not be resolved yet
      let resolved = false;
      void promise.then(() => { resolved = true; });

      // Give microtask queue a tick
      await new Promise(r => setTimeout(r, 0));
      expect(resolved).toBe(false);

      // Now resolve
      resolveExecutor();
      await promise;
      expect(resolved).toBe(true);
    });
  });
});
