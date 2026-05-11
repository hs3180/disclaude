/**
 * Tests for PrimaryAgentPool (packages/primary-node/src/primary-agent-pool.ts)
 *
 * Tests the agent pool management: creation, retrieval, reset, stop, and disposal.
 * Uses mocked AgentFactory and ChatAgent to isolate pool logic.
 *
 * @see Issue #1617 - Test Coverage (Phase 4)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track factory calls for assertions
const factoryCalls: Array<{ chatId: string; options: any }> = [];

// Mock AgentFactory
vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createChatAgent: vi.fn().mockImplementation(
      (_name: string, chatId: string, _callbacks: any, options?: any) => {
        factoryCalls.push({ chatId, options });
        const agent = {
          chatId,
          reset: vi.fn(),
          stop: vi.fn().mockReturnValue(false),
          dispose: vi.fn(),
        };
        return agent;
      },
    ),
  },
}));

// Mock logger
vi.mock('@disclaude/core', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
}));

import { PrimaryAgentPool } from './primary-agent-pool.js';
import { AgentFactory } from './agents/factory.js';
import type { ChatAgentCallbacks } from './agents/types.js';

const mockCallbacks: ChatAgentCallbacks = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
};

describe('PrimaryAgentPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factoryCalls.length = 0;
  });

  describe('constructor', () => {
    it('should create pool with default options', () => {
      const pool = new PrimaryAgentPool();
      expect(pool).toBeDefined();
    });

    it('should accept messageBuilderOptions', () => {
      const options = {
        messageBuilderOptions: {
          platformHeader: 'Feishu',
        },
      };
      const pool = new PrimaryAgentPool(options);
      expect(pool).toBeDefined();
    });
  });

  describe('getOrCreateChatAgent', () => {
    it('should create a new agent for unseen chatId', () => {
      const pool = new PrimaryAgentPool();
      const agent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);

      expect(agent).toBeDefined();
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(1);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-1',
        mockCallbacks,
        { messageBuilderOptions: undefined },
      );
    });

    it('should return the same agent for the same chatId', () => {
      const pool = new PrimaryAgentPool();
      const agent1 = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-1', mockCallbacks);

      expect(agent1).toBe(agent2);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(1);
    });

    it('should create separate agents for different chatIds', () => {
      const pool = new PrimaryAgentPool();
      const agent1 = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-2', mockCallbacks);

      expect(agent1).not.toBe(agent2);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2);
    });

    it('should pass messageBuilderOptions to factory', () => {
      const messageBuilderOptions = { platformHeader: 'Feishu' };
      const pool = new PrimaryAgentPool({ messageBuilderOptions });
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-1',
        mockCallbacks,
        { messageBuilderOptions },
      );
    });
  });

  describe('reset', () => {
    it('should reset the agent for the given chatId', () => {
      const pool = new PrimaryAgentPool();
      const agent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);

      pool.reset('chat-1');

      expect(agent.reset).toHaveBeenCalledWith('chat-1', undefined);
    });

    it('should pass keepContext to agent reset', () => {
      const pool = new PrimaryAgentPool();
      const agent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);

      pool.reset('chat-1', true);

      expect(agent.reset).toHaveBeenCalledWith('chat-1', true);
    });

    it('should be a no-op for unknown chatId', () => {
      const pool = new PrimaryAgentPool();

      // Should not throw
      pool.reset('nonexistent');
    });
  });

  describe('stop', () => {
    it('should stop the agent for the given chatId', () => {
      const pool = new PrimaryAgentPool();
      const agent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      (agent.stop as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const result = pool.stop('chat-1');

      expect(result).toBe(true);
      expect(agent.stop).toHaveBeenCalledWith('chat-1');
    });

    it('should return false for unknown chatId', () => {
      const pool = new PrimaryAgentPool();

      const result = pool.stop('nonexistent');

      expect(result).toBe(false);
    });

    it('should return the agent stop result', () => {
      const pool = new PrimaryAgentPool();
      const agent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      (agent.stop as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = pool.stop('chat-1');

      expect(result).toBe(false);
    });
  });

  describe('disposeAll', () => {
    it('should dispose all agents and clear the pool', () => {
      const pool = new PrimaryAgentPool();
      const agent1 = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-2', mockCallbacks);

      pool.disposeAll();

      expect(agent1.dispose).toHaveBeenCalledTimes(1);
      expect(agent2.dispose).toHaveBeenCalledTimes(1);

      // After disposal, new calls should create new agents
      const newAgent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      expect(newAgent).not.toBe(agent1);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(3);
    });

    it('should be safe to call on empty pool', () => {
      const pool = new PrimaryAgentPool();

      // Should not throw
      pool.disposeAll();
    });
  });
});
