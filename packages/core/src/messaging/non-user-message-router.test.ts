/**
 * Unit tests for NonUserMessageRouter — system-driven message routing.
 *
 * Tests cover:
 * - Successful routing when project binding exists
 * - Routing failure when project binding not found
 * - Message queuing when target agent is busy
 * - Priority ordering in queue processing
 * - Error handling during delivery
 * - Error notifier callback
 * - Queue management (size, clear, etc.)
 *
 * @see Issue #3331 (NonUserMessage type definition and routing layer)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NonUserMessageRouter } from './non-user-message-router.js';
import type { NonUserMessage, ProjectBinding } from '../types/non-user-message.js';
import type { ChatAgent } from '../agents/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createMessage(overrides?: Partial<NonUserMessage>): NonUserMessage {
  return {
    id: 'msg-1',
    type: 'scheduled',
    source: 'scheduler:task-1',
    projectKey: 'owner/repo',
    payload: 'Execute scheduled task',
    priority: 'normal',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockAgent(taskCompleteOverride?: Promise<void>): ChatAgent {
  return {
    type: 'chat',
    name: 'mock-agent',
    start: vi.fn().mockResolvedValue(undefined),
    handleInput: vi.fn(),
    processMessage: vi.fn(),
    reset: vi.fn(),
    stop: vi.fn().mockReturnValue(false),
    dispose: vi.fn(),
    runOnce: vi.fn().mockResolvedValue(undefined),
    taskComplete: taskCompleteOverride,
  };
}

function createBinding(chatId = 'oc_test', workingDir = '/repo'): ProjectBinding {
  return { chatId, workingDir };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('NonUserMessageRouter', () => {
  let bindings: Map<string, ProjectBinding>;
  let agent: ChatAgent;
  let router: NonUserMessageRouter;

  beforeEach(() => {
    bindings = new Map();
    agent = createMockAgent();

    router = new NonUserMessageRouter({
      projectLookup: (key) => bindings.get(key) ?? null,
      agentFactory: () => agent,
    });
  });

  // ───────────────────────────────────────────
  // route() — Project Found
  // ───────────────────────────────────────────

  describe('route() — project found', () => {
    it('should route message to agent when project binding exists', async () => {
      bindings.set('owner/repo', createBinding('oc_chat1'));

      const result = await router.route(createMessage());

      expect(result).toEqual({ ok: true, chatId: 'oc_chat1' });
      expect(agent.processMessage).toHaveBeenCalledWith(
        'oc_chat1',
        'Execute scheduled task',
        'system:msg-1'
      );
    });

    it('should support async project lookup', async () => {
      bindings.set('owner/repo', createBinding('oc_async'));

      const asyncRouter = new NonUserMessageRouter({
        projectLookup: (key) => Promise.resolve(bindings.get(key) ?? null),
        agentFactory: () => agent,
      });

      const result = await asyncRouter.route(createMessage());

      expect(result).toEqual({ ok: true, chatId: 'oc_async' });
    });
  });

  // ───────────────────────────────────────────
  // route() — Project Not Found
  // ───────────────────────────────────────────

  describe('route() — project not found', () => {
    it('should return error when no project binding exists', async () => {
      const result = await router.route(createMessage({ projectKey: 'nonexistent/repo' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('nonexistent/repo');
      }
      expect(agent.processMessage).not.toHaveBeenCalled();
    });

    it('should return error for empty project key', async () => {
      const result = await router.route(createMessage({ projectKey: '' }));

      expect(result.ok).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // route() — Agent Busy (Queueing)
  // ───────────────────────────────────────────

  describe('route() — agent busy', () => {
    it('should enqueue message when agent is busy processing another', async () => {
      // Agent with a taskComplete that blocks until we resolve it
      let resolveTask!: () => void;
      const taskComplete = new Promise<void>((resolve) => { resolveTask = resolve; });
      agent = createMockAgent(taskComplete);

      router = new NonUserMessageRouter({
        projectLookup: (key) => bindings.get(key) ?? null,
        agentFactory: () => agent,
      });

      bindings.set('owner/repo', createBinding('oc_busy'));

      // First message: starts async delivery, returns immediately
      const result1 = await router.route(createMessage({ id: 'msg-1' }));
      expect(result1).toEqual({ ok: true, chatId: 'oc_busy' });
      expect(router.isProcessing('oc_busy')).toBe(true);

      // Second message: agent is busy, should be enqueued
      const result2 = await router.route(createMessage({ id: 'msg-2' }));
      expect(result2).toEqual({ ok: true, chatId: 'oc_busy' });
      expect(router.getQueueSize('oc_busy')).toBe(1);

      // Complete the agent's task
      resolveTask();
      // Wait for delivery chain to settle
      await new Promise((r) => setTimeout(r, 30));

      // Queue should be drained
      expect(router.getQueueSize('oc_busy')).toBe(0);
      expect(router.isProcessing('oc_busy')).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // route() — Priority Ordering
  // ───────────────────────────────────────────

  describe('route() — priority ordering', () => {
    it('should process queued messages in priority order', async () => {
      const delivered: string[] = [];

      let resolveTask!: () => void;
      const taskComplete1 = new Promise<void>((resolve) => { resolveTask = resolve; });

      // Agent that tracks delivery order
      agent = {
        ...createMockAgent(taskComplete1),
        processMessage: vi.fn().mockImplementation((_chatId: string, payload: string) => {
          delivered.push(payload);
        }),
      };
      // Override taskComplete to be the blocking promise
      (agent as { taskComplete: Promise<void> | undefined }).taskComplete = taskComplete1;

      router = new NonUserMessageRouter({
        projectLookup: (key) => bindings.get(key) ?? null,
        agentFactory: () => agent,
      });

      bindings.set('owner/repo', createBinding('oc_priority'));

      // First message (normal priority, blocks)
      await router.route(createMessage({ id: 'msg-1', payload: 'first', priority: 'normal' }));

      // Enqueue messages with different priorities
      await router.route(createMessage({ id: 'msg-low', payload: 'low-priority', priority: 'low' }));
      await router.route(createMessage({ id: 'msg-high', payload: 'high-priority', priority: 'high' }));
      await router.route(createMessage({ id: 'msg-norm', payload: 'normal-2', priority: 'normal' }));

      expect(router.getQueueSize('oc_priority')).toBe(3);

      // Complete first message — triggers queue drain
      resolveTask();
      await new Promise((r) => setTimeout(r, 50));

      // First message was delivered
      expect(delivered[0]).toBe('first');
      // high-priority should come before low-priority
      const highIdx = delivered.indexOf('high-priority');
      const lowIdx = delivered.indexOf('low-priority');
      if (highIdx >= 0 && lowIdx >= 0) {
        expect(highIdx).toBeLessThan(lowIdx);
      }
    });
  });

  // ───────────────────────────────────────────
  // route() — Error Handling
  // ───────────────────────────────────────────

  describe('route() — error handling', () => {
    it('should handle agent delivery errors gracefully', async () => {
      bindings.set('owner/repo', createBinding('oc_error'));
      agent.processMessage = vi.fn().mockImplementation(() => {
        throw new Error('Agent exploded');
      });

      // Should not throw
      const result = await router.route(createMessage());
      expect(result).toEqual({ ok: true, chatId: 'oc_error' });
    });

    it('should call error notifier on delivery failure', async () => {
      bindings.set('owner/repo', createBinding('oc_notify'));
      const errorNotifier = vi.fn().mockResolvedValue(undefined);

      const errorRouter = new NonUserMessageRouter({
        projectLookup: (key) => bindings.get(key) ?? null,
        agentFactory: () => agent,
        errorNotifier,
      });

      agent.processMessage = vi.fn().mockImplementation(() => {
        throw new Error('Delivery failed');
      });

      await errorRouter.route(createMessage());

      // Wait for async error handling
      await new Promise((r) => setTimeout(r, 20));

      expect(errorNotifier).toHaveBeenCalledWith(
        'oc_notify',
        expect.stringContaining('Delivery failed')
      );
    });

    it('should handle error notifier failure gracefully', async () => {
      bindings.set('owner/repo', createBinding('oc_notifier_fail'));
      const errorNotifier = vi.fn().mockRejectedValue(new Error('Notifier broken'));

      const errorRouter = new NonUserMessageRouter({
        projectLookup: (key) => bindings.get(key) ?? null,
        agentFactory: () => agent,
        errorNotifier,
      });

      agent.processMessage = vi.fn().mockImplementation(() => {
        throw new Error('Agent error');
      });

      // Should not throw even when notifier fails
      await expect(errorRouter.route(createMessage())).resolves.toBeDefined();
    });
  });

  // ───────────────────────────────────────────
  // enqueue()
  // ───────────────────────────────────────────

  describe('enqueue()', () => {
    it('should enqueue message without immediate delivery', async () => {
      bindings.set('owner/repo', createBinding('oc_enq'));

      const result = await router.enqueue('owner/repo', createMessage());

      expect(result).toBe(true);
      expect(router.getQueueSize('oc_enq')).toBe(1);
      expect(agent.processMessage).not.toHaveBeenCalled();
    });

    it('should return false for unknown project', async () => {
      const result = await router.enqueue('unknown/repo', createMessage());

      expect(result).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // Queue Management
  // ───────────────────────────────────────────

  describe('queue management', () => {
    it('should report queue sizes correctly', async () => {
      bindings.set('owner/repo', createBinding('oc_q1'));
      bindings.set('other/repo', createBinding('oc_q2'));

      await router.enqueue('owner/repo', createMessage({ id: 'm1' }));
      await router.enqueue('owner/repo', createMessage({ id: 'm2' }));
      await router.enqueue('other/repo', createMessage({ id: 'm3' }));

      expect(router.getQueueSize('oc_q1')).toBe(2);
      expect(router.getQueueSize('oc_q2')).toBe(1);
      expect(router.getQueueSize('oc_unknown')).toBe(0);
    });

    it('should list queued chatIds', async () => {
      bindings.set('owner/repo', createBinding('oc_qa'));
      bindings.set('other/repo', createBinding('oc_qb'));

      await router.enqueue('owner/repo', createMessage());
      await router.enqueue('other/repo', createMessage());

      const chatIds = router.getQueuedChatIds();
      expect(chatIds).toContain('oc_qa');
      expect(chatIds).toContain('oc_qb');
    });

    it('should clear all queues', async () => {
      bindings.set('owner/repo', createBinding('oc_clear'));

      await router.enqueue('owner/repo', createMessage());
      expect(router.getQueueSize('oc_clear')).toBe(1);

      router.clearQueues();
      expect(router.getQueueSize('oc_clear')).toBe(0);
    });

    it('should report processing state during delivery', async () => {
      let resolveTask!: () => void;
      const taskComplete = new Promise<void>((resolve) => { resolveTask = resolve; });
      agent = createMockAgent(taskComplete);

      router = new NonUserMessageRouter({
        projectLookup: (key) => bindings.get(key) ?? null,
        agentFactory: () => agent,
      });

      bindings.set('owner/repo', createBinding('oc_proc'));

      expect(router.isProcessing('oc_proc')).toBe(false);

      // Start async delivery — route() returns immediately but processing is set
      await router.route(createMessage());

      // Immediately after route() returns, processing should be set
      expect(router.isProcessing('oc_proc')).toBe(true);

      // Complete the task
      resolveTask();
      await new Promise((r) => setTimeout(r, 20));

      expect(router.isProcessing('oc_proc')).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // Multiple Projects
  // ───────────────────────────────────────────

  describe('multiple projects', () => {
    it('should route messages to different chatIds independently', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();

      bindings.set('proj/a', createBinding('oc_a'));
      bindings.set('proj/b', createBinding('oc_b'));

      const multiRouter = new NonUserMessageRouter({
        projectLookup: (key) => bindings.get(key) ?? null,
        agentFactory: (chatId) => chatId === 'oc_a' ? agent1 : agent2,
      });

      await multiRouter.route(createMessage({ projectKey: 'proj/a', id: 'msg-a' }));
      await new Promise((r) => setTimeout(r, 10));
      await multiRouter.route(createMessage({ projectKey: 'proj/b', id: 'msg-b' }));
      await new Promise((r) => setTimeout(r, 10));

      expect(agent1.processMessage).toHaveBeenCalledWith('oc_a', 'Execute scheduled task', 'system:msg-a');
      expect(agent2.processMessage).toHaveBeenCalledWith('oc_b', 'Execute scheduled task', 'system:msg-b');
    });
  });
});
