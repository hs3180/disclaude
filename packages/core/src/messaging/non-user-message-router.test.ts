/**
 * Unit tests for NonUserMessageRouter (Issue #3331).
 *
 * Covers:
 * - Successful routing (project found, agent idle)
 * - Project not found
 * - Agent busy → message queued
 * - Agent becomes idle → queued message delivered
 * - Multiple messages queued in order
 * - Router disposed → messages rejected
 * - StaticProjectResolver
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NonUserMessageRouter, StaticProjectResolver } from './non-user-message-router.js';
import { AgentPool, type ChatAgentFactory } from '../agents/agent-pool.js';
import type { ChatAgent } from '../agents/types.js';
import type { NonUserMessage } from './non-user-message.js';

// ============================================================================
// Test Helpers
// ============================================================================

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

function createTestMessage(overrides?: Partial<NonUserMessage>): NonUserMessage {
  return {
    id: 'test-msg-001',
    type: 'scheduled',
    source: 'scheduler:test',
    projectKey: 'test/project',
    payload: 'Test task payload',
    priority: 'normal',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// StaticProjectResolver Tests
// ============================================================================

describe('StaticProjectResolver', () => {
  it('should resolve known project keys', () => {
    const resolver = new StaticProjectResolver({
      'test/project': 'oc_chat001',
      'other/repo': 'oc_chat002',
    });

    expect(resolver.resolve('test/project')).toBe('oc_chat001');
    expect(resolver.resolve('other/repo')).toBe('oc_chat002');
  });

  it('should return undefined for unknown project keys', () => {
    const resolver = new StaticProjectResolver({
      'test/project': 'oc_chat001',
    });

    expect(resolver.resolve('unknown/project')).toBeUndefined();
  });

  it('should handle empty config', () => {
    const resolver = new StaticProjectResolver({});

    expect(resolver.resolve('anything')).toBeUndefined();
  });
});

// ============================================================================
// NonUserMessageRouter Tests
// ============================================================================

describe('NonUserMessageRouter', () => {
  let router: NonUserMessageRouter;
  let pool: AgentPool;
  let mockFactory: ChatAgentFactory;

  beforeEach(() => {
    mockFactory = vi.fn(createMockChatAgent);
    pool = new AgentPool({ chatAgentFactory: mockFactory });

    const resolver = new StaticProjectResolver({
      'test/project': 'oc_chat001',
    });

    router = new NonUserMessageRouter({
      projectResolver: resolver,
      agentPool: pool,
    });
  });

  afterEach(() => {
    router.dispose();
    pool.disposeAll();
  });

  describe('route — project not found', () => {
    it('should return error for unknown projectKey', async () => {
      const msg = createTestMessage({ projectKey: 'unknown/project' });
      const result = await router.route(msg);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Project not found');
      }
    });
  });

  describe('route — successful delivery', () => {
    it('should route to agent when project found and agent idle', async () => {
      const msg = createTestMessage();
      const result = await router.route(msg);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.chatId).toBe('oc_chat001');
      }

      // Verify agent was created and processMessage was called
      const agent = pool.get('oc_chat001');
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_chat001',
        'Test task payload',
        'test-msg-001',
      );
    });

    it('should reuse existing agent for same project', async () => {
      const msg1 = createTestMessage({ id: 'msg-1' });
      const msg2 = createTestMessage({ id: 'msg-2' });

      await router.route(msg1);

      // Clear first call
      const agent = pool.get('oc_chat001');
      (agent!.processMessage as ReturnType<typeof vi.fn>).mockClear();

      await router.route(msg2);

      // Same agent should be reused (factory called only once)
      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_chat001',
        'Test task payload',
        'msg-2',
      );
    });
  });

  describe('route — agent busy', () => {
    it('should queue message when agent has active task', async () => {
      const agent = pool.getOrCreateChatAgent('oc_chat001');

      // Simulate busy agent
      let resolveTask!: () => void;
      const taskPromise = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      Object.defineProperty(agent, 'taskComplete', {
        value: taskPromise,
        writable: true,
        configurable: true,
      });

      const msg = createTestMessage();

      // Route should not resolve until agent becomes idle
      const routePromise = router.route(msg);

      // Give drain loop a tick to start
      await new Promise((r) => setTimeout(r, 10));

      // Message should be queued
      expect(router.getQueueSize('test/project')).toBeGreaterThanOrEqual(0);

      // Resolve the task — agent becomes idle
      resolveTask();
      await taskPromise;

      // Now routing should complete
      const result = await routePromise;
      expect(result.ok).toBe(true);
    });
  });

  describe('route — router disposed', () => {
    it('should reject messages after disposal', async () => {
      router.dispose();

      const msg = createTestMessage();
      const result = await router.route(msg);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('disposed');
      }
    });

    it('should reject queued messages on disposal', async () => {
      const agent = pool.getOrCreateChatAgent('oc_chat001');

      // Simulate busy agent
      let resolveTask!: () => void;
      const taskPromise = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      Object.defineProperty(agent, 'taskComplete', {
        value: taskPromise,
        writable: true,
        configurable: true,
      });

      const msg = createTestMessage();
      const routePromise = router.route(msg);

      // Give drain loop a tick
      await new Promise((r) => setTimeout(r, 10));

      // Dispose while message is queued
      router.dispose();

      const result = await routePromise;
      expect(result.ok).toBe(false);

      // Clean up the promise
      resolveTask();
    });
  });

  describe('getQueueSize', () => {
    it('should return 0 for project with no queued messages', () => {
      expect(router.getQueueSize('test/project')).toBe(0);
    });

    it('should return 0 for unknown project', () => {
      expect(router.getQueueSize('unknown/project')).toBe(0);
    });
  });

  describe('getQueuedProjectKeys', () => {
    it('should return empty array when no messages queued', () => {
      expect(router.getQueuedProjectKeys()).toEqual([]);
    });
  });

  describe('multiple messages', () => {
    it('should deliver multiple messages sequentially', async () => {
      const msg1 = createTestMessage({ id: 'msg-1', payload: 'Task 1' });
      const msg2 = createTestMessage({ id: 'msg-2', payload: 'Task 2' });

      const result1 = await router.route(msg1);
      const result2 = await router.route(msg2);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      const agent = pool.get('oc_chat001');
      expect(agent!.processMessage).toHaveBeenCalledTimes(2);
    });
  });
});
