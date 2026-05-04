/**
 * Unit tests for PrimaryAgentPool.
 *
 * Issue #1617: Test coverage for PrimaryAgentPool — the agent pool that manages
 * ChatAgent instances per chatId for Primary Node.
 *
 * Tests cover:
 * - Agent creation and caching (same chatId returns same agent)
 * - MessageBuilderOptions propagation to created agents
 * - reset() delegation to cached agents
 * - stop() delegation and return value propagation
 * - stop() for unknown chatId returns false
 * - reset() for unknown chatId is a no-op
 * - disposeAll() cleans up all agents
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrimaryAgentPool, type PrimaryAgentPoolOptions } from './primary-agent-pool.js';
import type { ChatAgent } from './agents/chat-agent.js';
import type { ChatAgentCallbacks } from './agents/types.js';

// Mock AgentFactory to control agent creation
vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createChatAgent: vi.fn(),
  },
}));

// Import after mock setup
import { AgentFactory } from './agents/factory.js';

const mockedCreateChatAgent = vi.mocked(AgentFactory.createChatAgent);

/**
 * Helper: create a mock ChatAgent with configurable behavior.
 */
function createMockAgent(overrides: Partial<{
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}> = {}): ChatAgent {
  return {
    reset: overrides.reset ?? vi.fn(),
    stop: overrides.stop ?? vi.fn(() => true),
    dispose: overrides.dispose ?? vi.fn(),
  } as unknown as ChatAgent;
}

/**
 * Helper: create mock ChatAgentCallbacks.
 */
function createMockCallbacks(): ChatAgentCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
  };
}

describe('PrimaryAgentPool', () => {
  let pool: PrimaryAgentPool;
  let callbacks: ChatAgentCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new PrimaryAgentPool();
    callbacks = createMockCallbacks();
  });

  // ─── Constructor ───────────────────────────────────────────────

  describe('constructor', () => {
    it('should create a pool with default options', () => {
      const defaultPool = new PrimaryAgentPool();
      expect(defaultPool).toBeDefined();
    });

    it('should accept MessageBuilderOptions', () => {
      const options: PrimaryAgentPoolOptions = {
        messageBuilderOptions: {
          buildHeader: () => 'Test Header',
        },
      };
      const poolWithOptions = new PrimaryAgentPool(options);
      expect(poolWithOptions).toBeDefined();
    });

    it('should accept empty options', () => {
      const poolWithEmpty = new PrimaryAgentPool({});
      expect(poolWithEmpty).toBeDefined();
    });
  });

  // ─── getOrCreateChatAgent ──────────────────────────────────────

  describe('getOrCreateChatAgent', () => {
    it('should create a new agent via AgentFactory', () => {
      const mockAgent = createMockAgent();
      mockedCreateChatAgent.mockReturnValue(mockAgent);

      const result = pool.getOrCreateChatAgent('chat-123', callbacks);

      expect(result).toBe(mockAgent);
      expect(mockedCreateChatAgent).toHaveBeenCalledOnce();
      expect(mockedCreateChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-123',
        callbacks,
        { messageBuilderOptions: undefined },
      );
    });

    it('should return the same agent for the same chatId', () => {
      const mockAgent = createMockAgent();
      mockedCreateChatAgent.mockReturnValue(mockAgent);

      const first = pool.getOrCreateChatAgent('chat-123', callbacks);
      const second = pool.getOrCreateChatAgent('chat-123', callbacks);

      expect(first).toBe(second);
      expect(mockedCreateChatAgent).toHaveBeenCalledOnce();
    });

    it('should create different agents for different chatIds', () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();
      mockedCreateChatAgent
        .mockReturnValueOnce(agent1)
        .mockReturnValueOnce(agent2);

      const first = pool.getOrCreateChatAgent('chat-1', callbacks);
      const second = pool.getOrCreateChatAgent('chat-2', callbacks);

      expect(first).not.toBe(second);
      expect(first).toBe(agent1);
      expect(second).toBe(agent2);
      expect(mockedCreateChatAgent).toHaveBeenCalledTimes(2);
    });

    it('should not call AgentFactory again when agent is cached', () => {
      const mockAgent = createMockAgent();
      mockedCreateChatAgent.mockReturnValue(mockAgent);

      // First call creates the agent
      pool.getOrCreateChatAgent('chat-abc', callbacks);
      // Subsequent calls should use the cache
      pool.getOrCreateChatAgent('chat-abc', callbacks);
      pool.getOrCreateChatAgent('chat-abc', callbacks);

      expect(mockedCreateChatAgent).toHaveBeenCalledOnce();
    });

    it('should pass messageBuilderOptions to AgentFactory', () => {
      const messageBuilderOptions = {
        buildHeader: () => 'Custom Header',
        buildPostHistory: () => 'Custom Post History',
      };
      const poolWithOptions = new PrimaryAgentPool({ messageBuilderOptions });
      const mockAgent = createMockAgent();
      mockedCreateChatAgent.mockReturnValue(mockAgent);

      poolWithOptions.getOrCreateChatAgent('chat-456', callbacks);

      expect(mockedCreateChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-456',
        callbacks,
        { messageBuilderOptions },
      );
    });

    it('should pass undefined messageBuilderOptions when not configured', () => {
      const poolNoOptions = new PrimaryAgentPool();
      const mockAgent = createMockAgent();
      mockedCreateChatAgent.mockReturnValue(mockAgent);

      poolNoOptions.getOrCreateChatAgent('chat-789', callbacks);

      expect(mockedCreateChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-789',
        callbacks,
        { messageBuilderOptions: undefined },
      );
    });

    it('should handle multiple chatIds concurrently', () => {
      const agents = new Map<string, ChatAgent>();
      mockedCreateChatAgent.mockImplementation((_name: string, chatId: string) => {
        const agent = createMockAgent();
        agents.set(chatId, agent);
        return agent;
      });

      const results = ['chat-a', 'chat-b', 'chat-c'].map((id) =>
        pool.getOrCreateChatAgent(id, callbacks),
      );

      // Each chatId gets a unique agent
      expect(results).toHaveLength(3);
      expect(new Set(results).size).toBe(3);

      // Retrieving again returns the same cached agents
      for (let i = 0; i < 3; i++) {
        const again = pool.getOrCreateChatAgent(
          ['chat-a', 'chat-b', 'chat-c'][i],
          callbacks,
        );
        expect(again).toBe(results[i]);
      }
    });
  });

  // ─── reset ─────────────────────────────────────────────────────

  describe('reset', () => {
    it('should delegate reset to the cached agent with chatId', () => {
      const mockReset = vi.fn();
      const mockAgent = createMockAgent({ reset: mockReset });
      mockedCreateChatAgent.mockReturnValue(mockAgent);
      pool.getOrCreateChatAgent('chat-reset', callbacks);

      pool.reset('chat-reset');

      expect(mockReset).toHaveBeenCalledWith('chat-reset', undefined);
    });

    it('should pass keepContext=true when specified', () => {
      const mockReset = vi.fn();
      const mockAgent = createMockAgent({ reset: mockReset });
      mockedCreateChatAgent.mockReturnValue(mockAgent);
      pool.getOrCreateChatAgent('chat-keep', callbacks);

      pool.reset('chat-keep', true);

      expect(mockReset).toHaveBeenCalledWith('chat-keep', true);
    });

    it('should pass keepContext=false when explicitly set', () => {
      const mockReset = vi.fn();
      const mockAgent = createMockAgent({ reset: mockReset });
      mockedCreateChatAgent.mockReturnValue(mockAgent);
      pool.getOrCreateChatAgent('chat-nokeep', callbacks);

      pool.reset('chat-nokeep', false);

      expect(mockReset).toHaveBeenCalledWith('chat-nokeep', false);
    });

    it('should not throw when resetting a chatId that has no agent', () => {
      expect(() => pool.reset('nonexistent-chat')).not.toThrow();
    });

    it('should not call reset on agents for different chatIds', () => {
      const reset1 = vi.fn();
      const reset2 = vi.fn();
      mockedCreateChatAgent
        .mockReturnValueOnce(createMockAgent({ reset: reset1 }))
        .mockReturnValueOnce(createMockAgent({ reset: reset2 }));

      pool.getOrCreateChatAgent('chat-a', callbacks);
      pool.getOrCreateChatAgent('chat-b', callbacks);

      pool.reset('chat-a');

      expect(reset1).toHaveBeenCalledWith('chat-a', undefined);
      expect(reset2).not.toHaveBeenCalled();
    });
  });

  // ─── stop ──────────────────────────────────────────────────────

  describe('stop', () => {
    it('should delegate stop to the cached agent and return true', () => {
      const mockStop = vi.fn(() => true);
      const mockAgent = createMockAgent({ stop: mockStop });
      mockedCreateChatAgent.mockReturnValue(mockAgent);
      pool.getOrCreateChatAgent('chat-stop', callbacks);

      const result = pool.stop('chat-stop');

      expect(result).toBe(true);
      expect(mockStop).toHaveBeenCalledWith('chat-stop');
    });

    it('should return false when the agent has no active query', () => {
      const mockStop = vi.fn(() => false);
      const mockAgent = createMockAgent({ stop: mockStop });
      mockedCreateChatAgent.mockReturnValue(mockAgent);
      pool.getOrCreateChatAgent('chat-idle', callbacks);

      const result = pool.stop('chat-idle');

      expect(result).toBe(false);
      expect(mockStop).toHaveBeenCalledWith('chat-idle');
    });

    it('should return false for a chatId that has no agent', () => {
      const result = pool.stop('nonexistent-chat');

      expect(result).toBe(false);
    });

    it('should not call stop on agents for different chatIds', () => {
      const stop1 = vi.fn(() => true);
      const stop2 = vi.fn(() => false);
      mockedCreateChatAgent
        .mockReturnValueOnce(createMockAgent({ stop: stop1 }))
        .mockReturnValueOnce(createMockAgent({ stop: stop2 }));

      pool.getOrCreateChatAgent('chat-x', callbacks);
      pool.getOrCreateChatAgent('chat-y', callbacks);

      pool.stop('chat-x');

      expect(stop1).toHaveBeenCalledWith('chat-x');
      expect(stop2).not.toHaveBeenCalled();
    });
  });

  // ─── disposeAll ────────────────────────────────────────────────

  describe('disposeAll', () => {
    it('should dispose all cached agents', () => {
      const dispose1 = vi.fn();
      const dispose2 = vi.fn();
      const dispose3 = vi.fn();
      mockedCreateChatAgent
        .mockReturnValueOnce(createMockAgent({ dispose: dispose1 }))
        .mockReturnValueOnce(createMockAgent({ dispose: dispose2 }))
        .mockReturnValueOnce(createMockAgent({ dispose: dispose3 }));

      pool.getOrCreateChatAgent('chat-1', callbacks);
      pool.getOrCreateChatAgent('chat-2', callbacks);
      pool.getOrCreateChatAgent('chat-3', callbacks);

      pool.disposeAll();

      expect(dispose1).toHaveBeenCalledOnce();
      expect(dispose2).toHaveBeenCalledOnce();
      expect(dispose3).toHaveBeenCalledOnce();
    });

    it('should clear the agent cache so new agents are created', () => {
      const preAgent = createMockAgent();
      const postAgent = createMockAgent();
      mockedCreateChatAgent
        .mockReturnValueOnce(preAgent)
        .mockReturnValueOnce(postAgent);

      const before = pool.getOrCreateChatAgent('chat-reuse', callbacks);
      expect(before).toBe(preAgent);

      pool.disposeAll();

      const after = pool.getOrCreateChatAgent('chat-reuse', callbacks);
      expect(after).toBe(postAgent);
      expect(after).not.toBe(before);
      expect(mockedCreateChatAgent).toHaveBeenCalledTimes(2);
    });

    it('should not throw when called on an empty pool', () => {
      expect(() => pool.disposeAll()).not.toThrow();
    });

    it('should handle being called multiple times in succession', () => {
      const mockDispose = vi.fn();
      mockedCreateChatAgent.mockReturnValue(createMockAgent({ dispose: mockDispose }));

      pool.getOrCreateChatAgent('chat-multi', callbacks);

      pool.disposeAll();
      pool.disposeAll();

      // Agent was disposed only once (the first call)
      expect(mockDispose).toHaveBeenCalledOnce();
    });
  });

  // ─── Integration scenarios ─────────────────────────────────────

  describe('integration scenarios', () => {
    it('should support create → reset → stop → dispose lifecycle', () => {
      const mockReset = vi.fn();
      const mockStop = vi.fn(() => true);
      const mockDispose = vi.fn();
      const mockAgent = createMockAgent({
        reset: mockReset,
        stop: mockStop,
        dispose: mockDispose,
      });
      mockedCreateChatAgent.mockReturnValue(mockAgent);

      // Create
      const agent = pool.getOrCreateChatAgent('chat-lifecycle', callbacks);
      expect(agent).toBe(mockAgent);

      // Reset
      pool.reset('chat-lifecycle', false);
      expect(mockReset).toHaveBeenCalledWith('chat-lifecycle', false);

      // Stop
      const stopped = pool.stop('chat-lifecycle');
      expect(stopped).toBe(true);
      expect(mockStop).toHaveBeenCalledWith('chat-lifecycle');

      // Dispose all
      pool.disposeAll();
      expect(mockDispose).toHaveBeenCalledOnce();
    });

    it('should isolate agents across different chatIds', () => {
      const resetA = vi.fn();
      const resetB = vi.fn();
      const stopA = vi.fn(() => true);
      const stopB = vi.fn(() => false);
      const disposeA = vi.fn();
      const disposeB = vi.fn();

      mockedCreateChatAgent
        .mockReturnValueOnce(createMockAgent({ reset: resetA, stop: stopA, dispose: disposeA }))
        .mockReturnValueOnce(createMockAgent({ reset: resetB, stop: stopB, dispose: disposeB }));

      pool.getOrCreateChatAgent('chat-alpha', callbacks);
      pool.getOrCreateChatAgent('chat-beta', callbacks);

      // Operations on chat-alpha should not affect chat-beta
      pool.reset('chat-alpha');
      expect(resetA).toHaveBeenCalled();
      expect(resetB).not.toHaveBeenCalled();

      pool.stop('chat-alpha');
      expect(stopA).toHaveBeenCalled();
      expect(stopB).not.toHaveBeenCalled();

      // Dispose all cleans up both
      pool.disposeAll();
      expect(disposeA).toHaveBeenCalled();
      expect(disposeB).toHaveBeenCalled();
    });
  });
});
