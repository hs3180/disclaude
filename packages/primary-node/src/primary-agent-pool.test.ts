/**
 * Unit tests for PrimaryAgentPool.
 *
 * Tests the agent lifecycle management: creation, retrieval, reset, stop, and disposal.
 * Uses mocks for AgentFactory and ChatAgent to isolate PrimaryAgentPool logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrimaryAgentPool } from './primary-agent-pool.js';
import type { ChatAgentCallbacks } from './agents/types.js';

// Mock ChatAgent interface for testing
interface MockChatAgent {
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getChatId: ReturnType<typeof vi.fn>;
}

// Create a factory function that produces mock agents
const createdAgents: MockChatAgent[] = [];

function createMockAgent(): MockChatAgent {
  const agent = {
    reset: vi.fn(),
    stop: vi.fn(() => true),
    dispose: vi.fn(),
    getChatId: vi.fn(() => 'test-chat-id'),
  };
  createdAgents.push(agent);
  return agent;
}

// Mock the AgentFactory module
vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createChatAgent: vi.fn((_name: string, chatId: string, _callbacks: ChatAgentCallbacks) => {
      const agent = createMockAgent();
      agent.getChatId = vi.fn(() => chatId);
      return agent;
    }),
  },
}));

describe('PrimaryAgentPool', () => {
  let pool: PrimaryAgentPool;
  let mockCallbacks: ChatAgentCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    createdAgents.length = 0;
    pool = new PrimaryAgentPool();
    mockCallbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
      onDone: vi.fn(),
    };
  });

  describe('constructor', () => {
    it('should create a pool with default options', () => {
      const defaultPool = new PrimaryAgentPool();
      expect(defaultPool).toBeDefined();
    });

    it('should accept MessageBuilderOptions', () => {
      const optionsPool = new PrimaryAgentPool({
        messageBuilderOptions: {
          buildHeader: () => 'Test Header',
        },
      });
      expect(optionsPool).toBeDefined();
    });
  });

  describe('getOrCreateChatAgent', () => {
    it('should create a new agent for a new chatId', () => {
      const agent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);

      expect(agent).toBeDefined();
      expect(createdAgents).toHaveLength(1);
    });

    it('should return the same agent for the same chatId', () => {
      const agent1 = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-1', mockCallbacks);

      expect(agent1).toBe(agent2);
      expect(createdAgents).toHaveLength(1);
    });

    it('should create different agents for different chatIds', () => {
      const agent1 = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-2', mockCallbacks);

      expect(agent1).not.toBe(agent2);
      expect(createdAgents).toHaveLength(2);
    });

    it('should pass chatId to AgentFactory', async () => {
      const { AgentFactory } = await import('./agents/factory.js');
      pool.getOrCreateChatAgent('chat-123', mockCallbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-123',
        mockCallbacks,
        { messageBuilderOptions: undefined }
      );
    });

    it('should pass MessageBuilderOptions to AgentFactory', async () => {
      const { AgentFactory } = await import('./agents/factory.js');
      const options = {
        messageBuilderOptions: {
          buildHeader: () => 'Custom Header',
        },
      };
      const optionsPool = new PrimaryAgentPool(options);

      optionsPool.getOrCreateChatAgent('chat-1', mockCallbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-1',
        mockCallbacks,
        { messageBuilderOptions: options.messageBuilderOptions }
      );
    });

    it('should not call AgentFactory again when agent already exists', async () => {
      const { AgentFactory } = await import('./agents/factory.js');
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('should reset an existing agent', () => {
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      pool.reset('chat-1');

      expect(createdAgents[0].reset).toHaveBeenCalledWith('chat-1', undefined);
    });

    it('should reset with keepContext flag', () => {
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      pool.reset('chat-1', true);

      expect(createdAgents[0].reset).toHaveBeenCalledWith('chat-1', true);
    });

    it('should not throw when resetting non-existent chatId', () => {
      expect(() => pool.reset('non-existent')).not.toThrow();
    });

    it('should only reset the targeted agent, not others', () => {
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      pool.getOrCreateChatAgent('chat-2', mockCallbacks);

      pool.reset('chat-1');

      expect(createdAgents[0].reset).toHaveBeenCalledWith('chat-1', undefined);
      expect(createdAgents[1].reset).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should stop an active agent and return true', () => {
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      const result = pool.stop('chat-1');

      expect(createdAgents[0].stop).toHaveBeenCalledWith('chat-1');
      expect(result).toBe(true);
    });

    it('should return false for non-existent chatId', () => {
      const result = pool.stop('non-existent');

      expect(result).toBe(false);
    });

    it('should return the result from agent.stop()', () => {
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      createdAgents[0].stop = vi.fn(() => false);

      const result = pool.stop('chat-1');

      expect(result).toBe(false);
    });
  });

  describe('disposeAll', () => {
    it('should dispose all agents', () => {
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      pool.getOrCreateChatAgent('chat-2', mockCallbacks);
      pool.getOrCreateChatAgent('chat-3', mockCallbacks);

      pool.disposeAll();

      expect(createdAgents[0].dispose).toHaveBeenCalled();
      expect(createdAgents[1].dispose).toHaveBeenCalled();
      expect(createdAgents[2].dispose).toHaveBeenCalled();
    });

    it('should allow creating new agents after disposal', () => {
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      pool.disposeAll();

      // Should be able to create new agents
      const newAgent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      expect(newAgent).toBeDefined();
      expect(createdAgents).toHaveLength(2);
    });

    it('should not throw when called on empty pool', () => {
      expect(() => pool.disposeAll()).not.toThrow();
    });

    it('should clear all agents so subsequent reset/stop are no-ops', () => {
      pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      pool.disposeAll();

      // These should not throw
      expect(() => pool.reset('chat-1')).not.toThrow();
      expect(pool.stop('chat-1')).toBe(false);
    });
  });

  describe('lifecycle integration', () => {
    it('should support full agent lifecycle: create → use → reset → stop → dispose', () => {
      // Create
      const agent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      expect(agent).toBeDefined();

      // Use (retrieve same)
      const sameAgent = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      expect(sameAgent).toBe(agent);

      // Reset
      pool.reset('chat-1');
      expect(createdAgents[0].reset).toHaveBeenCalled();

      // Stop
      pool.stop('chat-1');
      expect(createdAgents[0].stop).toHaveBeenCalled();

      // Dispose
      pool.disposeAll();
      expect(createdAgents[0].dispose).toHaveBeenCalled();
    });

    it('should handle multiple agents with independent lifecycles', () => {
      const agent1 = pool.getOrCreateChatAgent('chat-1', mockCallbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-2', mockCallbacks);

      // Reset only agent1
      pool.reset('chat-1');
      expect(createdAgents[0].reset).toHaveBeenCalled();
      expect(createdAgents[1].reset).not.toHaveBeenCalled();

      // Stop only agent2
      pool.stop('chat-2');
      expect(createdAgents[0].stop).not.toHaveBeenCalled();
      expect(createdAgents[1].stop).toHaveBeenCalled();

      // Both should still be in pool
      expect(pool.getOrCreateChatAgent('chat-1', mockCallbacks)).toBe(agent1);
      expect(pool.getOrCreateChatAgent('chat-2', mockCallbacks)).toBe(agent2);
    });
  });
});
