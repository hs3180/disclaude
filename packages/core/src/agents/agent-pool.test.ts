/**
 * Unit tests for AgentPool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentPool, type ChatAgentFactory } from './agent-pool.js';
import type { ChatAgent } from './types.js';

// Create a mock ChatAgent factory
function createMockChatAgent(chatId: string): ChatAgent {
  return {
    type: 'chat',
    name: `mock-agent-${chatId}`,
    start: vi.fn().mockResolvedValue(undefined),
    handleInput: vi.fn(),
    processMessage: vi.fn(),
    taskComplete: undefined,
    runOnce: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    stop: vi.fn().mockReturnValue(true),
    dispose: vi.fn(),
  };
}

describe('AgentPool', () => {
  let pool: AgentPool;
  let mockFactory: ChatAgentFactory;

  beforeEach(() => {
    mockFactory = vi.fn(createMockChatAgent);
    pool = new AgentPool({
      chatAgentFactory: mockFactory,
    });
  });

  afterEach(() => {
    pool.disposeAll();
  });

  describe('constructor', () => {
    it('should create an AgentPool with the provided factory', () => {
      expect(pool).toBeDefined();
      expect(pool.size()).toBe(0);
    });
  });

  describe('getOrCreateChatAgent', () => {
    it('should create a new agent for a new chatId', () => {
      const agent = pool.getOrCreateChatAgent('chat-1');

      expect(agent).toBeDefined();
      expect(agent.type).toBe('chat');
      expect(agent.name).toBe('mock-agent-chat-1');
      expect(mockFactory).toHaveBeenCalledWith('chat-1');
      expect(pool.size()).toBe(1);
    });

    it('should return the same agent for the same chatId', () => {
      const agent1 = pool.getOrCreateChatAgent('chat-1');
      const agent2 = pool.getOrCreateChatAgent('chat-1');

      expect(agent1).toBe(agent2);
      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(pool.size()).toBe(1);
    });

    it('should create different agents for different chatIds', () => {
      const agent1 = pool.getOrCreateChatAgent('chat-1');
      const agent2 = pool.getOrCreateChatAgent('chat-2');

      expect(agent1).not.toBe(agent2);
      expect(mockFactory).toHaveBeenCalledTimes(2);
      expect(pool.size()).toBe(2);
    });
  });

  describe('has', () => {
    it('should return false for non-existent chatId', () => {
      expect(pool.has('non-existent')).toBe(false);
    });

    it('should return true for existing chatId', () => {
      pool.getOrCreateChatAgent('chat-1');
      expect(pool.has('chat-1')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent chatId', () => {
      expect(pool.get('non-existent')).toBeUndefined();
    });

    it('should return the agent for existing chatId', () => {
      const createdAgent = pool.getOrCreateChatAgent('chat-1');
      const retrievedAgent = pool.get('chat-1');

      expect(retrievedAgent).toBe(createdAgent);
    });
  });

  describe('dispose', () => {
    it('should return false when disposing non-existent chatId', () => {
      const result = pool.dispose('non-existent');
      expect(result).toBe(false);
    });

    it('should dispose and remove the agent for existing chatId', () => {
      const agent = pool.getOrCreateChatAgent('chat-1');
      const result = pool.dispose('chat-1');

      expect(result).toBe(true);
      expect(agent.dispose).toHaveBeenCalled();
      expect(pool.has('chat-1')).toBe(false);
      expect(pool.size()).toBe(0);
    });

    it('should only dispose once even if called multiple times', () => {
      const agent = pool.getOrCreateChatAgent('chat-1');
      pool.dispose('chat-1');
      pool.dispose('chat-1');

      expect(agent.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('should not throw when resetting non-existent chatId', () => {
      expect(() => pool.reset('non-existent')).not.toThrow();
    });

    it('should call reset on the agent for existing chatId', () => {
      const agent = pool.getOrCreateChatAgent('chat-1');
      pool.reset('chat-1');

      expect(agent.reset).toHaveBeenCalledWith('chat-1', undefined);
    });

    it('should pass keepContext parameter to agent reset', () => {
      const agent = pool.getOrCreateChatAgent('chat-1');
      pool.reset('chat-1', true);

      expect(agent.reset).toHaveBeenCalledWith('chat-1', true);
    });
  });

  describe('stop', () => {
    it('should return false when stopping non-existent chatId', () => {
      const result = pool.stop('non-existent');
      expect(result).toBe(false);
    });

    it('should call stop on the agent and return true', () => {
      const agent = pool.getOrCreateChatAgent('chat-1');
      const result = pool.stop('chat-1');

      expect(agent.stop).toHaveBeenCalledWith('chat-1');
      expect(result).toBe(true);
    });
  });

  describe('size', () => {
    it('should return 0 for empty pool', () => {
      expect(pool.size()).toBe(0);
    });

    it('should return correct count of agents', () => {
      pool.getOrCreateChatAgent('chat-1');
      pool.getOrCreateChatAgent('chat-2');
      pool.getOrCreateChatAgent('chat-3');

      expect(pool.size()).toBe(3);
    });

    it('should decrease after disposal', () => {
      pool.getOrCreateChatAgent('chat-1');
      pool.getOrCreateChatAgent('chat-2');
      pool.dispose('chat-1');

      expect(pool.size()).toBe(1);
    });
  });

  describe('getActiveChatIds', () => {
    it('should return empty array for empty pool', () => {
      expect(pool.getActiveChatIds()).toEqual([]);
    });

    it('should return all active chatIds', () => {
      pool.getOrCreateChatAgent('chat-1');
      pool.getOrCreateChatAgent('chat-2');
      pool.getOrCreateChatAgent('chat-3');

      const chatIds = pool.getActiveChatIds();
      expect(chatIds).toHaveLength(3);
      expect(chatIds).toContain('chat-1');
      expect(chatIds).toContain('chat-2');
      expect(chatIds).toContain('chat-3');
    });

    it('should not include disposed chatIds', () => {
      pool.getOrCreateChatAgent('chat-1');
      pool.getOrCreateChatAgent('chat-2');
      pool.dispose('chat-1');

      const chatIds = pool.getActiveChatIds();
      expect(chatIds).toHaveLength(1);
      expect(chatIds).toContain('chat-2');
    });
  });

  describe('disposeAll', () => {
    it('should dispose all agents and clear the pool', () => {
      const agent1 = pool.getOrCreateChatAgent('chat-1');
      const agent2 = pool.getOrCreateChatAgent('chat-2');
      const agent3 = pool.getOrCreateChatAgent('chat-3');

      pool.disposeAll();

      expect(agent1.dispose).toHaveBeenCalled();
      expect(agent2.dispose).toHaveBeenCalled();
      expect(agent3.dispose).toHaveBeenCalled();
      expect(pool.size()).toBe(0);
      expect(pool.getActiveChatIds()).toEqual([]);
    });

    it('should not throw when called on empty pool', () => {
      expect(() => pool.disposeAll()).not.toThrow();
    });

    it('should continue disposing even if one agent throws', () => {
      const agent1 = pool.getOrCreateChatAgent('chat-1');
      const agent2 = pool.getOrCreateChatAgent('chat-2');

      // Make agent1.dispose throw
      (agent1.dispose as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Dispose error');
      });

      pool.disposeAll();

      expect(agent1.dispose).toHaveBeenCalled();
      expect(agent2.dispose).toHaveBeenCalled();
      expect(pool.size()).toBe(0);
    });
  });
});
