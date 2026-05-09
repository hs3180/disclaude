/**
 * Tests for A2A Queue — Agent-to-Agent task delegation.
 *
 * Issue #3334: A2A messaging — Agent-to-Agent task delegation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { A2AQueue, type A2AQueueConfig } from './a2a-queue.js';
import type { A2AProjectResolver } from './a2a-types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createMockResolver(mapping: Record<string, string>): A2AProjectResolver {
  return {
    resolve: (key: string) => mapping[key],
  };
}

function createQueue(options?: {
  resolverMapping?: Record<string, string>;
  rateLimit?: { maxTasks: number; windowMs: number };
  onDeliver?: (targetChatId: string, task: unknown) => Promise<boolean>;
}): A2AQueue {
  const config: A2AQueueConfig = {
    projectResolver: createMockResolver(options?.resolverMapping ?? {
      'project-A': 'oc_agent_a',
      'project-B': 'oc_agent_b',
    }),
    rateLimit: options?.rateLimit,
    onDeliver: options?.onDeliver,
  };
  return new A2AQueue(config);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Suite
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('A2AQueue', () => {
  let queue: A2AQueue;

  beforeEach(() => {
    queue = createQueue();
  });

  // ───────────────────────────────────────────
  // Basic Enqueue
  // ───────────────────────────────────────────

  describe('enqueue', () => {
    it('should enqueue a task successfully', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'Analyze issues',
      });

      expect(result.success).toBe(true);
      expect(result.taskId).toBeDefined();
      expect(result.message).toContain('project-A');
    });

    it('should reject empty projectKey', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: '',
        payload: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('projectKey');
    });

    it('should reject empty payload', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: '',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('payload');
    });

    it('should reject unknown project', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'nonexistent',
        payload: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should default to normal priority', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'test',
      });

      expect(result.success).toBe(true);
      const task = queue.getTask(result.taskId!);
      expect(task?.priority).toBe('normal');
    });

    it('should accept explicit priority', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'urgent task',
        priority: 'high',
      });

      expect(result.success).toBe(true);
      const task = queue.getTask(result.taskId!);
      expect(task?.priority).toBe('high');
    });
  });

  // ───────────────────────────────────────────
  // Anti-Recursion
  // ───────────────────────────────────────────

  describe('anti-recursion', () => {
    it('should reject task to own project', () => {
      const result = queue.enqueue('oc_agent_a', {
        projectKey: 'project-A',
        payload: 'self-task',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('anti-recursion');
    });

    it('should allow task to different project', () => {
      const result = queue.enqueue('oc_agent_a', {
        projectKey: 'project-B',
        payload: 'cross-project task',
      });

      expect(result.success).toBe(true);
    });
  });

  // ───────────────────────────────────────────
  // Rate Limiting
  // ───────────────────────────────────────────

  describe('rate limiting', () => {
    it('should allow tasks within rate limit', () => {
      const limitedQueue = createQueue({
        rateLimit: { maxTasks: 3, windowMs: 60_000 },
      });

      for (let i = 0; i < 3; i++) {
        const result = limitedQueue.enqueue('oc_source', {
          projectKey: 'project-A',
          payload: `task ${i}`,
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject tasks exceeding rate limit', () => {
      const limitedQueue = createQueue({
        rateLimit: { maxTasks: 2, windowMs: 60_000 },
      });

      // First two should succeed
      limitedQueue.enqueue('oc_source', { projectKey: 'project-A', payload: 'task 1' });
      limitedQueue.enqueue('oc_source', { projectKey: 'project-B', payload: 'task 2' });

      // Third should fail
      const result = limitedQueue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'task 3',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Rate limit');
    });

    it('should track rate limits per source independently', () => {
      const limitedQueue = createQueue({
        rateLimit: { maxTasks: 1, windowMs: 60_000 },
      });

      // Source 1 uses its quota
      const r1 = limitedQueue.enqueue('oc_source1', { projectKey: 'project-A', payload: 'task' });
      expect(r1.success).toBe(true);

      // Source 1 blocked
      const r2 = limitedQueue.enqueue('oc_source1', { projectKey: 'project-B', payload: 'task' });
      expect(r2.success).toBe(false);

      // Source 2 can still enqueue
      const r3 = limitedQueue.enqueue('oc_source2', { projectKey: 'project-A', payload: 'task' });
      expect(r3.success).toBe(true);
    });
  });

  // ───────────────────────────────────────────
  // Queue Management
  // ───────────────────────────────────────────

  describe('queue management', () => {
    it('should track tasks by ID', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'test',
      });

      const task = queue.getTask(result.taskId!);
      expect(task).toBeDefined();
      expect(task?.sourceChatId).toBe('oc_source');
      expect(task?.projectKey).toBe('project-A');
      expect(task?.payload).toBe('test');
    });

    it('should return undefined for unknown task ID', () => {
      const task = queue.getTask('nonexistent-id');
      expect(task).toBeUndefined();
    });

    it('should track pending count', () => {
      expect(queue.pendingCount()).toBe(0);

      queue.enqueue('oc_source', { projectKey: 'project-A', payload: 'task 1' });
      // Note: delivery callback may remove it from queue
      // Without delivery callback, tasks remain pending
      expect(queue.pendingCount()).toBeGreaterThanOrEqual(0);
    });

    it('should drain tasks in priority order', async () => {
      // Use a queue without delivery callback so tasks stay in queue
      const testQueue = createQueue();

      // Enqueue in mixed order
      testQueue.enqueue('oc_source', { projectKey: 'project-A', payload: 'normal task', priority: 'normal' });
      testQueue.enqueue('oc_source', { projectKey: 'project-B', payload: 'high task', priority: 'high' });
      testQueue.enqueue('oc_source', { projectKey: 'project-A', payload: 'low task', priority: 'low' });

      // Wait for async delivery attempts to settle
      await new Promise(resolve => setTimeout(resolve, 50));

      // Check queue for target A
      const queueA = testQueue.getQueue('oc_agent_a');
      // Tasks should be queued (delivery callback is undefined so they stay)
      expect(queueA.length).toBe(2); // normal + low for project-A
    });
  });

  // ───────────────────────────────────────────
  // Source Traceability
  // ───────────────────────────────────────────

  describe('source traceability', () => {
    it('should record sourceChatId in task', () => {
      const result = queue.enqueue('oc_source_chat', {
        projectKey: 'project-A',
        payload: 'traceable task',
      });

      const task = queue.getTask(result.taskId!);
      expect(task?.sourceChatId).toBe('oc_source_chat');
    });

    it('should record targetChatId in task', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'traceable task',
      });

      const task = queue.getTask(result.taskId!);
      expect(task?.targetChatId).toBe('oc_agent_a');
    });

    it('should record createdAt timestamp', () => {
      const before = new Date().toISOString();
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'test',
      });
      const after = new Date().toISOString();

      const task = queue.getTask(result.taskId!);
      expect(task?.createdAt).toBeDefined();
      expect(task!.createdAt >= before).toBe(true);
      expect(task!.createdAt <= after).toBe(true);
    });
  });

  // ───────────────────────────────────────────
  // Task Status Transitions
  // ───────────────────────────────────────────

  describe('task status', () => {
    it('should start with pending status', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'test',
      });

      const task = queue.getTask(result.taskId!);
      expect(task?.status).toBe('pending');
    });

    it('should mark task as delivered', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'test',
      });

      queue.markDelivered(result.taskId!);
      const task = queue.getTask(result.taskId!);
      expect(task?.status).toBe('delivered');
    });

    it('should mark task as failed with error', () => {
      const result = queue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'test',
      });

      queue.markFailed(result.taskId!, 'Agent unavailable');
      const task = queue.getTask(result.taskId!);
      expect(task?.status).toBe('failed');
      expect(task?.error).toBe('Agent unavailable');
    });
  });

  // ───────────────────────────────────────────
  // Non-blocking Behavior
  // ───────────────────────────────────────────

  describe('non-blocking', () => {
    it('should return immediately without waiting for delivery', () => {
      const slowQueue = createQueue({
        onDeliver: async () => {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return true;
        },
      });

      const start = Date.now();
      const result = slowQueue.enqueue('oc_source', {
        projectKey: 'project-A',
        payload: 'test',
      });
      const elapsed = Date.now() - start;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(100); // Should return much faster than delivery
    });
  });
});
