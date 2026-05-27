/**
 * Tests for AgentPoolMessageHandler.
 *
 * Issue #3803: Tests verify that system messages (scheduled tasks)
 * use the systemExecutor path (workspace-scoped) rather than the
 * agent pool (which may have project-scoped cwdProvider).
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentPoolMessageHandler } from './agent-pool-handler.js';
import type { ChatAgent } from '../agents/chat-agent.js';
import type { ChatAgentCallbacks } from '../agents/types.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockAgent(overrides?: Partial<ChatAgent>): ChatAgent {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
    taskComplete: Promise.resolve(),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as ChatAgent;
}

function createMockPool(agent: ChatAgent) {
  return {
    getOrCreateChatAgent: vi.fn().mockReturnValue(agent),
  };
}

const mockCallbacks: ChatAgentCallbacks = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
};

const callbacksFactory = vi.fn().mockReturnValue(mockCallbacks);

// ============================================================================
// Tests
// ============================================================================

describe('AgentPoolMessageHandler', () => {
  describe('handleSystemMessage', () => {
    it('should use systemExecutor when provided (Issue #3803)', async () => {
      const systemExecutor = vi.fn().mockResolvedValue(undefined);
      const agent = createMockAgent();
      const pool = createMockPool(agent);

      const handler = new AgentPoolMessageHandler({
        agentPool: pool,
        callbacksFactory,
        systemExecutor,
      });

      await handler.handleSystemMessage('chat-123', 'scheduled task prompt', 'msg-001');

      expect(systemExecutor).toHaveBeenCalledWith('chat-123', 'scheduled task prompt', 'msg-001');
      // Should NOT create agent from pool
      expect(pool.getOrCreateChatAgent).not.toHaveBeenCalled();
    });

    it('should fall back to agent pool when no systemExecutor (Issue #3803)', async () => {
      const agent = createMockAgent();
      const pool = createMockPool(agent);

      const handler = new AgentPoolMessageHandler({
        agentPool: pool,
        callbacksFactory,
        // No systemExecutor
      });

      await handler.handleSystemMessage('chat-123', 'task prompt', 'msg-002');

      // Should create agent from pool (this path has cwdProvider)
      expect(pool.getOrCreateChatAgent).toHaveBeenCalledWith('chat-123', mockCallbacks);
    });
  });

  describe('handleUserMessage', () => {
    it('should always use agent pool for user messages', async () => {
      const systemExecutor = vi.fn().mockResolvedValue(undefined);
      const agent = createMockAgent();
      const pool = createMockPool(agent);

      const handler = new AgentPoolMessageHandler({
        agentPool: pool,
        callbacksFactory,
        systemExecutor,
      });

      await handler.handleUserMessage({
        chatId: 'chat-123',
        messageId: 'msg-003',
        senderOpenId: 'user-001',
        payload: 'Hello agent',
      });

      // User messages always go through pool (has cwdProvider for project mode)
      expect(pool.getOrCreateChatAgent).toHaveBeenCalledWith('chat-123', mockCallbacks);
      // systemExecutor should NOT be called for user messages
      expect(systemExecutor).not.toHaveBeenCalled();
    });
  });
});
