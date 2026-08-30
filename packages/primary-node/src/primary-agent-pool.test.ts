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

// Issue #4256: mock createLogger so logPoolSnapshot() output is observable in
// tests without a real pino instance. vi.hoisted() makes mockLogger available
// to the (hoisted) module mock factory before evaluation.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@disclaude/core', async (importOriginal) => {
  // Issue #4587 (part 2): buildSessionKey / chatIdOfSessionKey are pure
  // functions with no dependencies — pull the real implementations from core
  // instead of re-implementing them here (PR #4590 review N4), and stub only
  // the logger.
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: () => mockLogger,
  };
});

// Track mock agent instances for assertions
// Issue #4620: mock now carries turnStartedAtMs (0 = not set; tests that
// exercise the observation-based fallback leave it 0/undefined).
const mockAgents: Map<string, { dispose: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; updateCallbacks: ReturnType<typeof vi.fn>; taskComplete?: Promise<void>; isBusy: boolean; turnStartedAtMs?: number }> = new Map();

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
        // Issue #4620: default 0 = agent does not report a turn-start
        // timestamp → pool falls back to observation-based tracking.
        turnStartedAtMs: 0,
      };
      mockAgents.set(chatId, agent);
      return agent;
    }),
  },
}));

import { AgentFactory } from './agents/factory.js';
import { PrimaryAgentPool, chatIdOfSessionKey } from './primary-agent-pool.js';

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
        { messageBuilderOptions: undefined, cwdProvider: undefined, cwdResolver: undefined, skipHistory: false },
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
        { messageBuilderOptions, cwdProvider: undefined, cwdResolver: undefined, skipHistory: false },
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
        { messageBuilderOptions: undefined, cwdProvider, cwdResolver: undefined, skipHistory: false },
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
        { messageBuilderOptions, cwdProvider, cwdResolver: undefined, skipHistory: false },
      );
    });

    // Issue #4448 (direction #1): the structured resolver travels with
    // cwdProvider so ChatAgent can warn the chat on the bound-missing
    // workspace fallback.
    it('should pass cwdResolver to factory when provided (Issue #4448 direction #1)', () => {
      const cwdProvider: CwdProvider = () => '/project';
      const cwdResolver = (_chatId: string) => ({
        effectiveCwd: '/project',
        boundWorkingDir: '/project',
        reason: 'bound' as const,
      });
      const pool = new PrimaryAgentPool({ cwdProvider, cwdResolver });
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-resolver', callbacks);

      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'chat-resolver',
        callbacks,
        { messageBuilderOptions: undefined, cwdProvider, cwdResolver, skipHistory: false },
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
        { messageBuilderOptions: undefined, cwdProvider: undefined, cwdResolver: undefined, skipHistory: false },
      );
    });

    it('forgets provider-side session state on reset — keyed by the PLAIN chatId (#4644)', () => {
      const forgotten: string[] = [];
      const pool = new PrimaryAgentPool({
        forgetProviderSession: (chatId) => forgotten.push(chatId),
      });
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-ev', callbacks);
      pool.reset('chat-ev');

      // The provider stash is keyed by the plain chatId (what ChatAgent passes
      // as the SDK sessionKey), NOT this pool's composite thread key.
      expect(forgotten).toEqual(['chat-ev']);
    });

    it('forgets provider session state even when NO agent exists — the eviction-stash window (#4644)', () => {
      const forgotten: string[] = [];
      const pool = new PrimaryAgentPool({
        forgetProviderSession: (chatId) => forgotten.push(chatId),
      });

      // No ChatAgent instance: the chat was idle-evicted from the pool while
      // its codex evicted-thread stash lived on in the provider. A /reset now
      // must still clear that stash — pool disposal alone cannot reach it.
      expect(() => pool.reset('chat-gone')).not.toThrow();
      expect(forgotten).toEqual(['chat-gone']);
    });

    it('forgets with the plain chatId on a THREAD reset too — matching the SDK sessionKey wiring (#4644)', () => {
      const forgotten: string[] = [];
      const pool = new PrimaryAgentPool({
        forgetProviderSession: (chatId) => forgotten.push(chatId),
      });
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('chat-t', callbacks, 'om_root');
      pool.reset('chat-t', false, 'om_root');

      // Pool slot key is chat-t::om_root, but the codex stash is keyed by the
      // plain chatId the stream registered with — the forget must use that.
      expect(forgotten).toEqual(['chat-t']);
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

  // ==========================================================================
  // busy-turn hard cap (Issue #4577)
  // ==========================================================================

  describe('busy-turn hard cap (Issue #4577)', () => {
    it('should stop (not evict) a busy agent whose turn exceeds the hard cap', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-runaway', callbacks);
      const agent = mockAgents.get('chat-runaway')!;
      agent.isBusy = true;

      const t0 = Date.now();
      // First sweep observes the busy turn and records its start.
      pool.evictIdleAgents(t0);
      expect(agent.stop).not.toHaveBeenCalled();
      // Agent is still busy before the cap elapses — untouched.
      pool.evictIdleAgents(t0 + 4000);
      expect(agent.stop).not.toHaveBeenCalled();
      expect(agent.dispose).not.toHaveBeenCalled();
      // Past the cap: query is stopped, but the agent is NOT disposed
      // mid-turn (the stop unwinds it; the normal idle path reclaims later).
      const evicted = pool.evictIdleAgents(t0 + 5100);
      expect(evicted).toEqual([]);
      expect(agent.stop).toHaveBeenCalledOnce();
      expect(agent.stop).toHaveBeenCalledWith('chat-runaway');
      expect(agent.dispose).not.toHaveBeenCalled();
    });

    it('should NOT stop busy agents within the cap (existing behavior preserved)', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 60_000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-legit', callbacks);
      const agent = mockAgents.get('chat-legit')!;
      agent.isBusy = true;

      const t0 = Date.now();
      pool.evictIdleAgents(t0);
      pool.evictIdleAgents(t0 + 30_000);

      expect(agent.stop).not.toHaveBeenCalled();
      expect(agent.dispose).not.toHaveBeenCalled();
    });

    it('should give the next busy turn a fresh cap window after a stop', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-again', callbacks);
      const agent = mockAgents.get('chat-again')!;
      agent.isBusy = true;

      const t0 = Date.now();
      pool.evictIdleAgents(t0); // observe busy start
      pool.evictIdleAgents(t0 + 6000); // cap exceeded → stop, marker cleared
      expect(agent.stop).toHaveBeenCalledOnce();
      // Still busy (turn hasn't unwound yet) — the stop must not re-fire
      // on every subsequent sweep tick.
      pool.evictIdleAgents(t0 + 7000);
      pool.evictIdleAgents(t0 + 8000);
      expect(agent.stop).toHaveBeenCalledOnce();
    });

    it('should clear the busy marker when the turn ends, resetting the window', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-cycle', callbacks);
      const agent = mockAgents.get('chat-cycle')!;
      const t0 = Date.now();

      // Turn 1: busy for a while, ends before cap. The idle sweep at
      // t0+4000 clears the busy marker; idle timeout is disabled for this
      // agent's chat by keeping lastUsedAt fresh (a new message arrived
      // between the two sweeps, which is exactly how a short turn-then-new-
      // message cycle looks in production).
      agent.isBusy = true;
      pool.evictIdleAgents(t0);
      agent.isBusy = false;
      pool.evictIdleAgents(t0 + 500); // idle but recently used → marker cleared, not evicted
      expect(agent.stop).not.toHaveBeenCalled();
      expect(pool.get('chat-cycle')).toBeDefined();

      // Turn 2 starts: busy again. If the turn-1 marker had leaked, the
      // sweep at t0+4500 would compute busy-since = t0 (4500 < 5000, ok)
      // but t0+5600 → 5600ms ≥ cap would stop early with the turn-2 window
      // being only 1100ms. With the marker cleared, turn 2 is observed
      // fresh at t0+4500 and nothing fires.
      agent.isBusy = true;
      pool.evictIdleAgents(t0 + 4500); // turn-2 start observed here
      pool.evictIdleAgents(t0 + 5600); // 1100ms into turn 2 < 5000 cap → no stop
      expect(agent.stop).not.toHaveBeenCalled();
      // Cap measured from turn 2's first observation (t0+4500): at t0+9510
      // the window is 5010ms ≥ 5000 → stop fires.
      pool.evictIdleAgents(t0 + 9510);
      expect(agent.stop).toHaveBeenCalledOnce();
    });

    it('should be disabled when busyTurnHardCapMs is 0', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 0 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-uncapped', callbacks);
      const agent = mockAgents.get('chat-uncapped')!;
      agent.isBusy = true;

      const t0 = Date.now();
      pool.evictIdleAgents(t0);
      pool.evictIdleAgents(t0 + 10_000_000);

      expect(agent.stop).not.toHaveBeenCalled();
      expect(agent.dispose).not.toHaveBeenCalled();
    });

    it('default cap (90 min) applies when the option is omitted', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-default', callbacks);
      const agent = mockAgents.get('chat-default')!;
      agent.isBusy = true;

      const t0 = Date.now();
      pool.evictIdleAgents(t0);
      // Just under 90 min: untouched.
      pool.evictIdleAgents(t0 + 89 * 60 * 1000);
      expect(agent.stop).not.toHaveBeenCalled();
      // Past 90 min: stopped.
      pool.evictIdleAgents(t0 + 91 * 60 * 1000);
      expect(agent.stop).toHaveBeenCalledOnce();
    });

    it('should still enforce the busy cap when idle eviction is disabled (idleTimeoutMs=0)', () => {
      // The cap is the memory-bounding control for runaway turns; it must
      // not be silently disabled along with idle eviction — an unbounded
      // pool is exactly where a runaway turn hurts most (Issue #4577
      // evidence A/B). Same always-on principle as the #4256 snapshot.
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 0, busyTurnHardCapMs: 5000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-uncapped-pool', callbacks);
      const agent = mockAgents.get('chat-uncapped-pool')!;
      agent.isBusy = true;

      const t0 = Date.now();
      const evictedEarly = pool.evictIdleAgents(t0);
      expect(evictedEarly).toEqual([]);
      expect(agent.stop).not.toHaveBeenCalled();
      // Past the cap with idle eviction off: the busy turn is still stopped
      // (and nothing is evicted — the agent stays for the idle path that
      // will never fire, but the runaway turn no longer holds its tree).
      const evicted = pool.evictIdleAgents(t0 + 6000);
      expect(evicted).toEqual([]);
      expect(agent.stop).toHaveBeenCalledOnce();
      expect(agent.dispose).not.toHaveBeenCalled();
    });

    it('should fire onBusyCapExceeded after a hard-cap stop', async () => {
      const onBusyCapExceeded = vi.fn().mockResolvedValue(undefined);
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5 * 60 * 1000, onBusyCapExceeded });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-notify', callbacks);
      const agent = mockAgents.get('chat-notify')!;
      agent.isBusy = true;

      const t0 = Date.now();
      pool.evictIdleAgents(t0);
      pool.evictIdleAgents(t0 + 5 * 60 * 1000 + 100);
      expect(agent.stop).toHaveBeenCalledOnce();

      // The hook is fire-and-forget; flush microtasks before asserting.
      await vi.waitFor(() => {
        expect(onBusyCapExceeded).toHaveBeenCalledOnce();
      });
      expect(onBusyCapExceeded).toHaveBeenCalledWith('chat-notify', 5);
    });

    it('should not fire onBusyCapExceeded when not wired (log-only, no crash)', () => {
      // Default construction (no hook): the stop still happens and the
      // sweep completes without throwing.
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-silent', callbacks);
      const agent = mockAgents.get('chat-silent')!;
      agent.isBusy = true;

      const t0 = Date.now();
      pool.evictIdleAgents(t0);
      expect(() => pool.evictIdleAgents(t0 + 5100)).not.toThrow();
      expect(agent.stop).toHaveBeenCalledOnce();
    });

    it('should swallow onBusyCapExceeded rejection — a failing channel must not break the sweep', async () => {
      const onBusyCapExceeded = vi.fn().mockRejectedValue(new Error('channel down'));
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5000, onBusyCapExceeded });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-flaky', callbacks);
      const agent = mockAgents.get('chat-flaky')!;
      agent.isBusy = true;

      const t0 = Date.now();
      pool.evictIdleAgents(t0);
      // Must not throw synchronously (the sweep loop) nor emit unhandledRejection.
      expect(() => pool.evictIdleAgents(t0 + 5100)).not.toThrow();
      expect(agent.stop).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(onBusyCapExceeded).toHaveBeenCalledOnce();
      });
      // The failure is logged (fire-and-forget contract), not propagated.
      await vi.waitFor(() => {
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ chatId: 'chat-flaky' }),
          'Failed to send busy-cap notification'
        );
      });
    });

    it('Issue #4620: back-to-back turns never accumulate — a new turn after 90min of session wall-clock is not insta-killed', () => {
      // Regression shape from the issue: many completed turns where every
      // sweep tick lands mid-turn of SOME turn (short interactive-card
      // turns arriving every few minutes). The observation-based marker
      // never saw !isBusy, so it anchored to the first turn; the next turn
      // was killed ~77s in with a false "running for 90 minutes" message.
      const cap = 90 * 60 * 1000;
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 0, busyTurnHardCapMs: cap });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-b2b', callbacks);
      const agent = mockAgents.get('chat-b2b')!;

      const t0 = Date.now();
      const sweep = 5 * 60 * 1000; // production sweep interval
      // Two hours of 5-minute turns, each reported by the agent with its
      // own authoritative turnStartedAtMs (as ChatAgent now does).
      for (let turnStart = t0; turnStart < t0 + 120 * 60 * 1000; turnStart += sweep) {
        agent.isBusy = true;
        agent.turnStartedAtMs = turnStart;
        // Sweep lands mid-turn (turns span the full sweep interval).
        pool.evictIdleAgents(turnStart + sweep / 2);
        // Turn completes just before the next sweep would fire.
        agent.isBusy = false;
        agent.turnStartedAtMs = 0;
      }
      expect(agent.stop).not.toHaveBeenCalled();

      // New turn starts (interactive-card click) — 120+ min after session
      // start but only ~77s into THIS turn. Must NOT be insta-killed.
      const newTurnStart = t0 + 125 * 60 * 1000;
      agent.isBusy = true;
      agent.turnStartedAtMs = newTurnStart;
      pool.evictIdleAgents(newTurnStart + 77 * 1000);
      expect(agent.stop).not.toHaveBeenCalled();
      // And a genuinely over-long turn IS still capped (cap still enforced).
      pool.evictIdleAgents(newTurnStart + cap + 1000);
      expect(agent.stop).toHaveBeenCalledOnce();
      expect(agent.stop).toHaveBeenCalledWith('chat-b2b');
    });

    it('Issue #4620: a genuine single runaway turn still trips the cap via turnStartedAtMs', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-runaway4620', callbacks);
      const agent = mockAgents.get('chat-runaway4620')!;

      const t0 = Date.now();
      agent.isBusy = true;
      agent.turnStartedAtMs = t0;
      // First sweep observes the busy agent — with the authoritative
      // timestamp available, the cap is measured from t0 immediately.
      pool.evictIdleAgents(t0 + 1000);
      expect(agent.stop).not.toHaveBeenCalled();
      pool.evictIdleAgents(t0 + 5100);
      expect(agent.stop).toHaveBeenCalledOnce();
    });

    it('Issue #4620: agents without turnStartedAtMs keep the observation-based fallback', () => {
      // Backward compatibility: a mock/older agent that reports isBusy but
      // no turn-start timestamp falls back to the pre-#4620 marker logic.
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-fallback', callbacks);
      const agent = mockAgents.get('chat-fallback')!;
      (agent as { turnStartedAtMs?: number }).turnStartedAtMs = undefined;

      const t0 = Date.now();
      agent.isBusy = true;
      pool.evictIdleAgents(t0); // observe busy start
      pool.evictIdleAgents(t0 + 4000);
      expect(agent.stop).not.toHaveBeenCalled();
      pool.evictIdleAgents(t0 + 5100);
      expect(agent.stop).toHaveBeenCalledOnce();
    });

    it('Issue #4620 (review fix): same-millisecond turns in different chats do not collide on the stop-guard', () => {
      // Group broadcast shape: two chats' turns start at the SAME epoch ms.
      // With a bare-timestamp guard key, chat A's over-cap stop would mark
      // the shared timestamp as handled, silently skipping chat B's stop
      // (and A going idle could even delete B's guard → double stop).
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000, busyTurnHardCapMs: 5000 });
      const callbacks = createMockCallbacks();
      pool.getOrCreateChatAgent('chat-collide-a', callbacks);
      pool.getOrCreateChatAgent('chat-collide-b', callbacks);
      const agentA = mockAgents.get('chat-collide-a')!;
      const agentB = mockAgents.get('chat-collide-b')!;

      const t0 = Date.now();
      agentA.isBusy = true;
      agentA.turnStartedAtMs = t0;
      agentB.isBusy = true;
      agentB.turnStartedAtMs = t0; // same millisecond as A

      // Both turns exceed the cap — BOTH must be stopped despite the
      // identical turnStartedAtMs.
      pool.evictIdleAgents(t0 + 5100);
      expect(agentA.stop).toHaveBeenCalledOnce();
      expect(agentA.stop).toHaveBeenCalledWith('chat-collide-a');
      expect(agentB.stop).toHaveBeenCalledOnce();
      expect(agentB.stop).toHaveBeenCalledWith('chat-collide-b');

      // The guard must also not leak across chats: A going idle must not
      // clear B's guard (B still busy → repeated sweeps must not re-stop B).
      agentA.isBusy = false; // A's turn ended; B's (stopped) turn continues
      pool.evictIdleAgents(t0 + 5100 + 60000);
      expect(agentA.stop).toHaveBeenCalledOnce(); // unchanged
      expect(agentB.stop).toHaveBeenCalledOnce(); // NOT re-stopped by idle-A cleanup
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

    it('emits an idle-sweep snapshot even when idle eviction is disabled (idleTimeoutMs=0)', () => {
      // Issue #4256 (part 2): the snapshot timer must run regardless of the
      // eviction toggle, so leak diagnostics stay live when the pool is
      // unbounded. evictIdleAgents() is a no-op when idleTimeoutMs<=0.
      vi.useFakeTimers();
      try {
        const pool = new PrimaryAgentPool({ idleTimeoutMs: 0, idleSweepIntervalMs: 1000 });
        pool.startIdleSweep();
        mockLogger.info.mockClear();
        vi.advanceTimersByTime(1000);
        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'idle-sweep' }),
          'Agent pool snapshot (Issue #4256)',
        );
        pool.stopIdleSweep();
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits an immediate snapshot whenever peakActive hits a new high-water mark', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();
      mockLogger.info.mockClear();
      pool.getOrCreateChatAgent('p1', callbacks); // new peak (active 1)
      pool.getOrCreateChatAgent('p1', callbacks); // existing agent — no new peak
      pool.getOrCreateChatAgent('p2', callbacks); // new peak (active 2)

      const calls = mockLogger.info.mock.calls as unknown as Array<
        [Record<string, unknown>, string]
      >;
      const peakSnapshots = calls.filter(
        ([data, msg]) => msg === 'Agent pool snapshot (Issue #4256)' && data?.reason === 'peak',
      );
      expect(peakSnapshots).toHaveLength(2);
      expect(peakSnapshots[0][0]?.active).toBe(1);
      expect(peakSnapshots[1][0]?.active).toBe(2);
      expect(peakSnapshots[1][0]?.peakActive).toBe(2);
    });
  });

  // ==========================================================================
  // Per-thread session keying (Issue #4587 part 2)
  // ==========================================================================

  describe('per-thread session keying (Issue #4587 part 2)', () => {
    it('creates separate agents for two threads of the same topic group', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      const agentA = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');
      const agentB = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadB');

      expect(agentA).not.toBe(agentB);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2);
    });

    it('returns the same agent for subsequent messages in the same thread', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      const agentA1 = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');
      const agentA2 = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');

      expect(agentA1).toBe(agentA2);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledOnce();
    });

    it('constructs thread agents with the PLAIN chatId (boundChatId/history stay chat-scoped)', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');

      // The factory receives the plain chatId — never the composite key — so
      // the agent's boundChatId guard (#644), HistoryManager, and callbacks
      // keep addressing the chat, not the thread.
      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'oc_topic',
        callbacks,
        { messageBuilderOptions: undefined, cwdProvider: undefined, cwdResolver: undefined, skipHistory: false },
      );
      // And it is still retrievable only via the thread key...
      expect(pool.get('oc_topic', 'om_threadA')).toBeDefined();
      expect(pool.get('oc_topic')).toBeUndefined();
    });

    it('lazy migration: a thread agent never clobbers the existing chat-scoped agent', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      // Existing chat-scoped session (pre-topic-message state).
      const chatScoped = pool.getOrCreateChatAgent('oc_topic', callbacks);
      // First topic-group thread message arrives — it must get its OWN agent,
      // leaving the chat-scoped one untouched (the issue's 惰性迁移).
      const threadAgent = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');

      expect(threadAgent).not.toBe(chatScoped);
      expect(AgentFactory.createChatAgent).toHaveBeenCalledTimes(2);
      expect(pool.get('oc_topic')).toBe(chatScoped);
      expect(pool.get('oc_topic', 'om_threadA')).toBe(threadAgent);
    });

    it('reset(chatId, skip, threadRoot) disposes only that thread agent', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      const chatScoped = pool.getOrCreateChatAgent('oc_topic', callbacks);
      const agentA = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');
      const agentB = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadB');

      pool.reset('oc_topic', undefined, 'om_threadA');

      expect(agentA.dispose).toHaveBeenCalledOnce();
      expect(agentB.dispose).not.toHaveBeenCalled();
      expect(chatScoped.dispose).not.toHaveBeenCalled();
      // Other slots still return their cached agents.
      expect(pool.get('oc_topic')).toBe(chatScoped);
      expect(pool.get('oc_topic', 'om_threadB')).toBe(agentB);
    });

    it('reset without threadRoot still resets the chat-scoped agent only', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      const chatScoped = pool.getOrCreateChatAgent('oc_topic', callbacks);
      const agentA = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');

      pool.reset('oc_topic');

      expect(chatScoped.dispose).toHaveBeenCalledOnce();
      expect(agentA.dispose).not.toHaveBeenCalled();
    });

    it('reset(chatId, true, threadRoot) skips history for that thread only (#4206 × #4587)', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');
      pool.reset('oc_topic', true, 'om_threadA');
      mockAgents.clear();

      pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');
      expect(AgentFactory.createChatAgent).toHaveBeenCalledWith(
        'pilot',
        'oc_topic',
        callbacks,
        expect.objectContaining({ skipHistory: true }),
      );
    });

    it('stop(chatId, threadRoot) stops only that thread agent, with the plain chatId', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      const agentA = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');
      const agentB = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadB');

      const result = pool.stop('oc_topic', 'om_threadA');

      expect(result).toBe(true);
      // stop() receives the PLAIN chatId — the agent's boundChatId guard
      // rejects the composite key.
      expect(agentA.stop).toHaveBeenCalledWith('oc_topic');
      expect(agentB.stop).not.toHaveBeenCalled();
    });

    it('isAgentBusy(chatId, threadRoot) checks that thread only', () => {
      const pool = new PrimaryAgentPool();
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('oc_topic', callbacks);
      // The factory mock returns a shared shape per call — capture the thread
      // agent by return value (mockAgents keys on the plain chatId).
      pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');
      const threadAgent = pool.get('oc_topic', 'om_threadA');
      (threadAgent as unknown as { isBusy: boolean }).isBusy = true;

      // A busy thread does not make the chat-scoped agent (or another thread)
      // look busy — scheduler gating keys on the chat-scoped agent.
      expect(pool.isAgentBusy('oc_topic', 'om_threadA')).toBe(true);
      expect(pool.isAgentBusy('oc_topic')).toBe(false);
      expect(pool.isAgentBusy('oc_topic', 'om_threadB')).toBe(false);
    });

    it('idle eviction evicts thread agents under their session key and keeps others', () => {
      const pool = new PrimaryAgentPool({ idleTimeoutMs: 1000 });
      const callbacks = createMockCallbacks();

      pool.getOrCreateChatAgent('oc_topic', callbacks);
      pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');

      const evicted = pool.evictIdleAgents(Date.now() + 2000);

      // Session keys, not plain chatIds, are reported for thread agents.
      expect(evicted).toEqual(['oc_topic', 'oc_topic::om_threadA']);
      expect(pool.get('oc_topic')).toBeUndefined();
      expect(pool.get('oc_topic', 'om_threadA')).toBeUndefined();
    });

    it('busy-cap stop and notification address the PLAIN chatId for a thread agent', () => {
      const onBusyCapExceeded = vi.fn();
      const pool = new PrimaryAgentPool({
        idleTimeoutMs: 1000,
        busyTurnHardCapMs: 5000,
        onBusyCapExceeded,
      });
      const callbacks = createMockCallbacks();
      const agent = pool.getOrCreateChatAgent('oc_topic', callbacks, 'om_threadA');
      (agent as unknown as { isBusy: boolean }).isBusy = true;

      const t0 = Date.now();
      pool.evictIdleAgents(t0); // observe busy start
      pool.evictIdleAgents(t0 + 5100); // cap exceeded

      // agent.stop() and the user-facing hook both get the plain chatId —
      // the agent's boundChatId guard and the channel key on chatId.
      expect(agent.stop).toHaveBeenCalledWith('oc_topic');
      expect(onBusyCapExceeded).toHaveBeenCalledWith('oc_topic', expect.any(Number));
    });

    it('chatIdOfSessionKey inverts buildSessionKey', () => {
      expect(chatIdOfSessionKey('oc_topic')).toBe('oc_topic');
      expect(chatIdOfSessionKey('oc_topic::om_threadA')).toBe('oc_topic');
    });
  });
});
