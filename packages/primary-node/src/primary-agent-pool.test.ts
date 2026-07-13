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
const mockAgents: Map<string, { dispose: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; updateCallbacks: ReturnType<typeof vi.fn>; taskComplete?: Promise<void>; isBusy: boolean }> = new Map();

// Mock AgentFactory
vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createChatAgent: vi.fn((_name: string, chatId: string, _callbacks: unknown, _options?: unknown) => {
      const agent = {
        dispose: vi.fn(),
        stop: vi.fn().mockReturnValue(true),
        updateCallbacks: vi.fn().mockReturnValue(true),
        taskComplete: undefined as Promise<void> | undefined,
        isBusy: false,
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
        { messageBuilderOptions: undefined, cwdProvider: undefined, skipHistory: false },
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
        { messageBuilderOptions, cwdProvider: undefined, skipHistory: false },
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
        { messageBuilderOptions: undefined, cwdProvider, skipHistory: false },
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
        { messageBuilderOptions, cwdProvider, skipHistory: false },
      );
    });

    it('should update callbacks on existing agent (Issue #3776)', () => {
      const pool = new PrimaryAgentPool();
      const feishuCallbacks = createMockCallbacks();
      const restCallbacks = createMockCallbacks();

      // First call: Feishu creates the agent
      const agent = pool.getOrCreateChatAgent('chat-1', feishuCallbacks);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledOnce();

      // Second call: REST sends a message for the same chatId
      const sameAgent = pool.getOrCreateChatAgent('chat-1', restCallbacks);

      // Should return the same agent instance
      expect(sameAgent).toBe(agent);
      // Should NOT create a new agent
      expect(AgentFactory.createChatAgent).toHaveBeenCalledOnce();
      // Should update callbacks to REST's callbacks
      expect(agent.updateCallbacks).toHaveBeenCalledWith(restCallbacks);
    });

    it('should update callbacks on each call with different callbacks', () => {
      const pool = new PrimaryAgentPool();
      const callbacks1 = createMockCallbacks();
      const callbacks2 = createMockCallbacks();
      const callbacks3 = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-1', callbacks1);
      pool.getOrCreateChatAgent('chat-1', callbacks2);
      pool.getOrCreateChatAgent('chat-1', callbacks3);

      const agent = mockAgents.get('chat-1')!;
      // First call creates, next two update callbacks
      expect(agent.updateCallbacks).toHaveBeenCalledWith(callbacks2);
      expect(agent.updateCallbacks).toHaveBeenCalledWith(callbacks3);
      expect(agent.updateCallbacks).toHaveBeenCalledTimes(2);
    });

    it('should pass through updateCallbacks return value (concurrency signal)', () => {
      const pool = new PrimaryAgentPool();
      const callbacks1 = createMockCallbacks();
      const callbacks2 = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-1', callbacks1);
      const agent = mockAgents.get('chat-1')!;

      // Simulate agent being busy (updateCallbacks returns false)
      agent.updateCallbacks.mockReturnValue(false);
      pool.getOrCreateChatAgent('chat-1', callbacks2);

      // The pool should still call updateCallbacks even when agent is busy
      // (the agent handles deferral internally)
      expect(agent.updateCallbacks).toHaveBeenCalledWith(callbacks2);
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

    it('should make the next getOrCreate skip history after reset(chatId, true) (#4206)', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.reset('chat-skip', true);

      pool.getOrCreateChatAgent('chat-skip', callbacks);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-skip',
        callbacks,
        { messageBuilderOptions: undefined, cwdProvider: undefined, skipHistory: true },
      );
    });

    it('should clear a stale skip-history flag on reset(chatId, false) so the next agent reloads history (#4206 nit)', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      // reset(chatId, true) sets the skip-history flag (no agent exists yet, so
      // nothing to dispose — this mirrors a clearContext task whose flag was
      // set but whose consuming getOrCreate never ran because the task failed).
      pool.reset('chat-stale', true);
      // reset(chatId, false) must clear that stale flag.
      pool.reset('chat-stale', false);

      pool.getOrCreateChatAgent('chat-stale', callbacks);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-stale',
        callbacks,
        { messageBuilderOptions: undefined, cwdProvider: undefined, skipHistory: false },
      );
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

  // ==========================================================================
  // idle eviction (Issue #4169)
  // ==========================================================================

  describe('idle eviction (Issue #4169)', () => {
    it('should dispose agents idle longer than idleTimeoutMs', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-idle', callbacks);
      const agent = mockAgents.get('chat-idle')!;

      const evicted = pool.evictIdleAgents(Date.now() + 2000);

      expect(evicted).toEqual(['chat-idle']);
      expect(agent.dispose).toHaveBeenCalledOnce();
      // Evicted agent is gone — next access re-creates it
      pool.getOrCreateChatAgent('chat-idle', callbacks);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2);
    });

    it('should NOT evict recently-used agents', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-fresh', callbacks);
      const agent = mockAgents.get('chat-fresh')!;

      const evicted = pool.evictIdleAgents(Date.now());

      expect(evicted).toEqual([]);
      expect(agent.dispose).not.toHaveBeenCalled();
    });

    it('should NOT evict busy agents', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-busy', callbacks);
      const agent = mockAgents.get('chat-busy')!;
      agent.isBusy = true;

      const evicted = pool.evictIdleAgents(Date.now() + 100000);

      expect(evicted).toEqual([]);
      expect(agent.dispose).not.toHaveBeenCalled();
    });

    it('should be disabled when idleTimeoutMs is 0', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 0 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-dis', callbacks);

      const evicted = pool.evictIdleAgents(Date.now() + 999999);

      expect(evicted).toEqual([]);
    });

    it('startIdleSweep/stopIdleSweep should be idempotent', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000 });
      expect(() => pool.startIdleSweep()).not.toThrow();
      expect(() => pool.startIdleSweep()).not.toThrow();
      expect(() => pool.stopIdleSweep()).not.toThrow();
      expect(() => pool.stopIdleSweep()).not.toThrow();
    });
  });

  describe('pool stats / leak diagnostics (Issue #4256)', () => {
    it('getPoolStats() reports active/busy/idle for current agents', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-a', callbacks);
      pool.getOrCreateChatAgent('chat-b', callbacks);
      pool.getOrCreateChatAgent('chat-c', callbacks);
      // Mark one busy, the rest idle
      mockAgents.get('chat-a')!.isBusy = true;

      const stats = pool.getPoolStats();

      expect(stats.active).toBe(3);
      expect(stats.busy).toBe(1);
      expect(stats.idle).toBe(2);
    });

    it('peakActive retains the high-water mark after agents are evicted', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('c1', callbacks);
      pool.getOrCreateChatAgent('c2', callbacks);
      pool.getOrCreateChatAgent('c3', callbacks);
      expect(pool.getPoolStats().peakActive).toBe(3);

      // Evict all three (all idle) — active drops to 0 but peakActive must NOT.
      pool.evictIdleAgents(Date.now() + 5000);
      const stats = pool.getPoolStats();
      expect(stats.active).toBe(0);
      expect(stats.peakActive).toBe(3);
    });

    it('totalEvictions accumulates across sweeps', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('e1', callbacks);
      pool.getOrCreateChatAgent('e2', callbacks);

      pool.evictIdleAgents(Date.now() + 5000);
      expect(pool.getPoolStats().totalEvictions).toBe(2);

      // Re-create and evict again — counter keeps climbing.
      pool.getOrCreateChatAgent('e3', callbacks);
      pool.evictIdleAgents(Date.now() + 10000);
      expect(pool.getPoolStats().totalEvictions).toBe(3);
    });
  });
});
