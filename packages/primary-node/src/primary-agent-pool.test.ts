/**
 * Tests for PrimaryAgentPool (packages/primary-node/src/primary-agent-pool.ts)
 *
 * Issue #1617: Phase 3/4 — increasing unit test coverage to 70%.
 *
 * Tests cover:
 * 1. Constructor with default and custom options
 * 2. getOrCreateChatAgent() creates new agents on first call
 * 3. getOrCreateChatAgent() returns existing agent on subsequent calls
 * 4. getOrCreateChatAgent() passes options (messageBuilderOptions, cwdProvider, skipHistory)
 * 5. reset() disposes agent and removes from pool
 * 6. reset() with skipContext flag sets skip-history for next creation
 * 7. reset() on non-existent chatId is a no-op
 * 8. stop() delegates to agent.stop()
 * 9. stop() on non-existent chatId returns false
 * 10. disposeAll() disposes all agents and clears pool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AgentFactory — PrimaryAgentPool delegates creation to it
vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createChatAgent: vi.fn(),
  },
}));

import { AgentFactory } from './agents/factory.js';
import { PrimaryAgentPool } from './primary-agent-pool.js';
import type { ChatAgent } from './agents/chat-agent.js';
import type { ChatAgentCallbacks } from './agents/types.js';

/** Create a mock ChatAgent with standard fake methods */
const createMockAgent = (): ChatAgent =>
  ({
    dispose: vi.fn(),
    stop: vi.fn().mockReturnValue(true),
    processMessage: vi.fn(),
  }) as unknown as ChatAgent;

/** Create mock ChatAgentCallbacks */
const createMockCallbacks = (): ChatAgentCallbacks => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
});

describe('PrimaryAgentPool', () => {
  let pool: PrimaryAgentPool;
  let mockAgent: ChatAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent = createMockAgent();
    vi.mocked(AgentFactory.createChatAgent).mockReturnValue(mockAgent);
    pool = new PrimaryAgentPool();
  });

  // ==========================================================================
  // getOrCreateChatAgent()
  // ==========================================================================

  describe('getOrCreateChatAgent()', () => {
    it('should create a new agent via AgentFactory on first call', () => {
      const callbacks = createMockCallbacks();
      const agent = pool.getOrCreateChatAgent('chat-1', callbacks);

      expect(agent).toBe(mockAgent);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledOnce();
      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-1',
        callbacks,
        expect.objectContaining({
          messageBuilderOptions: undefined,
          cwdProvider: undefined,
          skipHistory: false,
        }),
      );
    });

    it('should return the same agent on subsequent calls for same chatId', () => {
      const callbacks = createMockCallbacks();

      const agent1 = pool.getOrCreateChatAgent('chat-1', callbacks);
      const agent2 = pool.getOrCreateChatAgent('chat-1', callbacks);

      expect(agent1).toBe(agent2);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledOnce();
    });

    it('should create separate agents for different chatIds', () => {
      const secondAgent = createMockAgent();
      vi.mocked(AgentFactory.createChatAgent)
        .mockReturnValueOnce(mockAgent)
        .mockReturnValueOnce(secondAgent);

      const callbacks1 = createMockCallbacks();
      const callbacks2 = createMockCallbacks();

      const agent1 = pool.getOrCreateChatAgent('chat-1', callbacks1);
      const agent2 = pool.getOrCreateChatAgent('chat-2', callbacks2);

      expect(agent1).not.toBe(agent2);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2);
    });

    it('should pass messageBuilderOptions to AgentFactory when provided', () => {
      const messageBuilderOptions = {
        platformHeader: 'Feishu',
        toolSections: true,
      } as any;
      const poolWithOptions = new PrimaryAgentPool({ messageBuilderOptions });
      const callbacks = createMockCallbacks();

      poolWithOptions.getOrCreateChatAgent('chat-1', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-1',
        callbacks,
        expect.objectContaining({
          messageBuilderOptions,
        }),
      );
    });

    it('should pass cwdProvider to AgentFactory when provided', () => {
      const cwdProvider = vi.fn().mockReturnValue('/project/custom');
      const poolWithCwd = new PrimaryAgentPool({ cwdProvider });
      const callbacks = createMockCallbacks();

      poolWithCwd.getOrCreateChatAgent('chat-1', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-1',
        callbacks,
        expect.objectContaining({
          cwdProvider,
        }),
      );
    });
  });

  // ==========================================================================
  // reset()
  // ==========================================================================

  describe('reset()', () => {
    it('should dispose the agent and remove it from the pool', () => {
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-1', callbacks);

      pool.reset('chat-1');

      expect(mockAgent.dispose).toHaveBeenCalledOnce();

      // Verify agent is removed — next call should create a new one
      const newAgent = createMockAgent();
      vi.mocked(AgentFactory.createChatAgent).mockReturnValue(newAgent);

      const result = pool.getOrCreateChatAgent('chat-1', callbacks);
      expect(result).toBe(newAgent);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2);
    });

    it('should be a no-op for non-existent chatId', () => {
      // Should not throw
      pool.reset('non-existent');

      expect(mockAgent.dispose).not.toHaveBeenCalled();
    });

    it('should set skipHistory flag when skipContext is true', () => {
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-1', callbacks);

      pool.reset('chat-1', true);

      // Next creation should have skipHistory: true
      const newAgent = createMockAgent();
      vi.mocked(AgentFactory.createChatAgent).mockReturnValue(newAgent);
      pool.getOrCreateChatAgent('chat-1', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenLastCalledWith(
        'pilot',
        'chat-1',
        callbacks,
        expect.objectContaining({ skipHistory: true }),
      );
    });

    it('should clear skipHistory flag after creating the next agent', () => {
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-1', callbacks);
      pool.reset('chat-1', true);

      // First creation after reset: skipHistory = true
      const agent2 = createMockAgent();
      vi.mocked(AgentFactory.createChatAgent).mockReturnValue(agent2);
      pool.getOrCreateChatAgent('chat-1', callbacks);

      // Dispose and get again — skipHistory should be false (cleared)
      pool.reset('chat-1');
      const agent3 = createMockAgent();
      vi.mocked(AgentFactory.createChatAgent).mockReturnValue(agent3);
      pool.getOrCreateChatAgent('chat-1', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenLastCalledWith(
        'pilot',
        'chat-1',
        callbacks,
        expect.objectContaining({ skipHistory: false }),
      );
    });

    it('should not set skipHistory when skipContext is false/undefined', () => {
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-1', callbacks);

      pool.reset('chat-1'); // skipContext undefined

      const newAgent = createMockAgent();
      vi.mocked(AgentFactory.createChatAgent).mockReturnValue(newAgent);
      pool.getOrCreateChatAgent('chat-1', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenLastCalledWith(
        'pilot',
        'chat-1',
        callbacks,
        expect.objectContaining({ skipHistory: false }),
      );
    });
  });

  // ==========================================================================
  // stop()
  // ==========================================================================

  describe('stop()', () => {
    it('should delegate to agent.stop() and return true when agent exists', () => {
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-1', callbacks);

      const result = pool.stop('chat-1');

      expect(mockAgent.stop).toHaveBeenCalledWith('chat-1');
      expect(result).toBe(true);
    });

    it('should return false when no agent exists for chatId', () => {
      const result = pool.stop('non-existent');

      expect(result).toBe(false);
    });

    it('should return false when agent stop returns false', () => {
      vi.mocked(mockAgent.stop).mockReturnValue(false);
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-1', callbacks);

      const result = pool.stop('chat-1');

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // disposeAll()
  // ==========================================================================

  describe('disposeAll()', () => {
    it('should dispose all agents and clear the pool', () => {
      const callbacks1 = createMockCallbacks();
      const callbacks2 = createMockCallbacks();
      const agent2 = createMockAgent();

      vi.mocked(AgentFactory.createChatAgent)
        .mockReturnValueOnce(mockAgent)
        .mockReturnValueOnce(agent2);

      pool.getOrCreateChatAgent('chat-1', callbacks1);
      pool.getOrCreateChatAgent('chat-2', callbacks2);

      pool.disposeAll();

      expect(mockAgent.dispose).toHaveBeenCalledOnce();
      expect(agent2.dispose).toHaveBeenCalledOnce();

      // Pool is cleared — new calls create fresh agents
      const newAgent = createMockAgent();
      vi.mocked(AgentFactory.createChatAgent).mockReturnValue(newAgent);
      pool.getOrCreateChatAgent('chat-1', callbacks1);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(3);
    });

    it('should be a no-op when pool is empty', () => {
      // Should not throw
      pool.disposeAll();
    });
  });
});
