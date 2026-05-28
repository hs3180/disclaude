/**
 * Tests for PrimaryAgentPool (packages/primary-node/src/primary-agent-pool.ts)
 *
 * Issue #1617: Add unit tests for PrimaryAgentPool.
 *
 * Tests cover:
 * 1. getOrCreateChatAgent() creates new agents and returns cached ones
 * 2. getOrCreateChatAgent() passes options (messageBuilderOptions, cwdProvider) to factory
 * 3. reset() disposes and removes a specific agent
 * 4. reset() is no-op for non-existent chatId
 * 5. stop() delegates to agent.stop() and returns result
 * 6. stop() returns false for non-existent chatId
 * 7. disposeAll() disposes all agents and clears the pool
 * 8. disposeAll() on empty pool is safe
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CwdProvider } from '@disclaude/core';

// Track mock agent instances for assertions
const mockAgents: Map<string, { dispose: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = new Map();

// Mock AgentFactory
vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createChatAgent: vi.fn((_name: string, chatId: string, _callbacks: unknown, _options?: unknown) => {
      const agent = {
        dispose: vi.fn(),
        stop: vi.fn().mockReturnValue(true),
      };
      mockAgents.set(chatId, agent);
      return agent;
    }),
  },
}));

import { AgentFactory } from './agents/factory.js';
import { PrimaryAgentPool } from './primary-agent-pool.js';

// Helper to create mock ChatAgentCallbacks
const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
});

describe('PrimaryAgentPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgents.clear();
  });

  // ==========================================================================
  // getOrCreateChatAgent()
  // ==========================================================================

  describe('getOrCreateChatAgent()', () => {
    it('should create a new agent for a new chatId', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      const agent = pool.getOrCreateChatAgent('chat-1', callbacks);

      expect(agent).toBeDefined();
      expect(AgentFactory.createChatAgent).toHaveBeenCalledOnce();
      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-1',
        callbacks,
        { messageBuilderOptions: undefined, cwdProvider: undefined },
      );
    });

    it('should return the same agent for the same chatId', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      const agent1 = pool.getOrCreateChatAgent('chat-1', callbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-1', callbacks);

      expect(agent1).toBe(agent2);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledOnce();
    });

    it('should create different agents for different chatIds', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      const agent1 = pool.getOrCreateChatAgent('chat-1', callbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-2', callbacks);

      expect(agent1).not.toBe(agent2);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2);
    });

    it('should pass messageBuilderOptions to factory when provided', () => {
      const messageBuilderOptions = { channel: 'feishu' } as any;
      const pool = new PrimaryAgentPool({ messageBuilderOptions });
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-opts', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-opts',
        callbacks,
        { messageBuilderOptions, cwdProvider: undefined },
      );
    });

    it('should pass cwdProvider to factory when provided', () => {
      const cwdProvider: CwdProvider = () => '/project';
      const pool = new PrimaryAgentPool({ cwdProvider });
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-cwd', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-cwd',
        callbacks,
        { messageBuilderOptions: undefined, cwdProvider },
      );
    });

    it('should pass both options when both are provided', () => {
      const messageBuilderOptions = { channel: 'feishu' } as any;
      const cwdProvider: CwdProvider = () => '/project';
      const pool = new PrimaryAgentPool({ messageBuilderOptions, cwdProvider });
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-both', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-both',
        callbacks,
        { messageBuilderOptions, cwdProvider },
      );
    });
  });

  // ==========================================================================
  // reset()
  // ==========================================================================

  describe('reset()', () => {
    it('should dispose and remove the agent for a given chatId', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-reset', callbacks);
      const agent = mockAgents.get('chat-reset')!;

      pool.reset('chat-reset');

      expect(agent.dispose).toHaveBeenCalledOnce();

      // Next getOrCreate should create a new agent, not return cached
      pool.getOrCreateChatAgent('chat-reset', callbacks);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2);
    });

    it('should be a no-op for non-existent chatId', () => {
      const pool = new PrimaryAgentPool();

      // Should not throw
      expect(() => pool.reset('nonexistent')).not.toThrow();
    });

    it('should not affect other agents when resetting one', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-a', callbacks);
      pool.getOrCreateChatAgent('chat-b', callbacks);

      pool.reset('chat-a');

      const agentB = mockAgents.get('chat-b')!;
      expect(agentB.dispose).not.toHaveBeenCalled();

      // chat-b should still return cached agent
      pool.getOrCreateChatAgent('chat-b', callbacks);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2); // only 2 creates
    });
  });

  // ==========================================================================
  // stop()
  // ==========================================================================

  describe('stop()', () => {
    it('should delegate to agent.stop() and return true when agent exists', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-stop', callbacks);
      const agent = mockAgents.get('chat-stop')!;
      agent.stop.mockReturnValue(true);

      const result = pool.stop('chat-stop');

      expect(agent.stop).toHaveBeenCalledWith('chat-stop');
      expect(result).toBe(true);
    });

    it('should return false when agent.stop() returns false', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-nostop', callbacks);
      const agent = mockAgents.get('chat-nostop')!;
      agent.stop.mockReturnValue(false);

      const result = pool.stop('chat-nostop');

      expect(result).toBe(false);
    });

    it('should return false for non-existent chatId', () => {
      const pool = new PrimaryAgentPool();

      const result = pool.stop('nonexistent');

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // disposeAll()
  // ==========================================================================

  describe('disposeAll()', () => {
    it('should dispose all agents and clear the pool', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-1', callbacks);
      pool.getOrCreateChatAgent('chat-2', callbacks);
      pool.getOrCreateChatAgent('chat-3', callbacks);

      pool.disposeAll();

      // All agents should be disposed
      for (const agent of mockAgents.values()) {
        expect(agent.dispose).toHaveBeenCalledOnce();
      }

      // Pool should be empty — new calls should create fresh agents
      vi.clearAllMocks();
      pool.getOrCreateChatAgent('chat-1', callbacks);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledOnce();
    });

    it('should be safe to call on empty pool', () => {
      const pool = new PrimaryAgentPool();

      expect(() => pool.disposeAll()).not.toThrow();
    });

    it('should be safe to call disposeAll multiple times', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-1', callbacks);

      pool.disposeAll();
      pool.disposeAll(); // second call should not throw

      const agent = mockAgents.get('chat-1')!;
      // dispose should have been called only once (from first disposeAll)
      expect(agent.dispose).toHaveBeenCalledOnce();
    });
  });
});
