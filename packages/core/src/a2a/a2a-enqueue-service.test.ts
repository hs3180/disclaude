/**
 * Unit tests for A2AEnqueueService — Agent-to-Agent task delegation.
 *
 * Tests cover:
 * - Successful enqueue with default and explicit priority
 * - Anti-recursion protection (same projectKey)
 * - Anti-recursion allows cross-project delegation
 * - Rate limiting: sliding window enforcement
 * - Rate limiting: window expiry resets budget
 * - Rate limiting: per-source isolation
 * - Route failure propagation
 * - Source traceability in routed messages
 * - Edge cases: empty payload, no project binding
 *
 * @see Issue #3334 (Phase 4: A2A messaging — Agent-to-Agent task delegation)
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  A2AEnqueueRequest,
  A2AEnqueueResult,
  A2ARouteMessage,
} from './types.js';
import { A2AEnqueueService } from './a2a-enqueue-service.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Tracked routed messages for assertions */
interface TrackedCall {
  message: A2ARouteMessage;
  result: A2AEnqueueResult;
}

/** Create a test service with configurable project bindings */
function createTestService(options: {
  projectBindings?: Record<string, string>; // chatId → projectKey
  routeResults?: 'ok' | 'error';
  rateLimit?: { maxMessagesPerWindow: number; windowMs: number };
}) {
  const routedMessages: TrackedCall[] = [];
  const projectBindings = options.projectBindings ?? {};

  const service = new A2AEnqueueService({
    getProjectKeyForChatId: (chatId: string) => projectBindings[chatId],
    routeMessage: (message: A2ARouteMessage): A2AEnqueueResult => {
      if (options.routeResults === 'error') {
        return { ok: false, error: `Router error: queue full for "${message.projectKey}"` };
      }
      const result: A2AEnqueueResult = { ok: true, messageId: message.id };
      routedMessages.push({ message, result });
      return result;
    },
    rateLimit: options.rateLimit,
  });

  return { service, routedMessages };
}

/** Create a standard enqueue request */
function createRequest(overrides: Partial<A2AEnqueueRequest> = {}): A2AEnqueueRequest {
  return {
    projectKey: 'target-project',
    payload: 'Triage all open issues',
    sourceChatId: 'oc_source_chat_123',
    ...overrides,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('A2AEnqueueService', () => {

  // ───────────────────────────────────────────
  // Successful Enqueue
  // ───────────────────────────────────────────

  describe('successful enqueue', () => {
    it('should enqueue a task and return messageId', () => {
      const { service, routedMessages } = createTestService({});

      const result = service.enqueue(createRequest());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.messageId).toBeDefined();
        expect(typeof result.messageId).toBe('string');
      }
      expect(routedMessages).toHaveLength(1);
    });

    it('should use "normal" priority by default', () => {
      const { service, routedMessages } = createTestService({});

      service.enqueue(createRequest());

      expect(routedMessages[0]!.message.priority).toBe('normal');
    });

    it('should respect explicit priority', () => {
      const { service, routedMessages } = createTestService({});

      service.enqueue(createRequest({ priority: 'high' }));

      expect(routedMessages[0]!.message.priority).toBe('high');
    });

    it('should use "low" priority when specified', () => {
      const { service, routedMessages } = createTestService({});

      service.enqueue(createRequest({ priority: 'low' }));

      expect(routedMessages[0]!.message.priority).toBe('low');
    });
  });

  // ───────────────────────────────────────────
  // Source Traceability
  // ───────────────────────────────────────────

  describe('source traceability', () => {
    it('should record source chatId in message source field', () => {
      const { service, routedMessages } = createTestService({});

      service.enqueue(createRequest({ sourceChatId: 'oc_chat_abc' }));

      expect(routedMessages[0]!.message.source).toBe('chat:oc_chat_abc');
    });

    it('should set correct projectKey in routed message', () => {
      const { service, routedMessages } = createTestService({});

      service.enqueue(createRequest({ projectKey: 'owner/repo' }));

      expect(routedMessages[0]!.message.projectKey).toBe('owner/repo');
    });

    it('should set payload in routed message', () => {
      const { service, routedMessages } = createTestService({});

      service.enqueue(createRequest({ payload: 'Review all PRs' }));

      expect(routedMessages[0]!.message.payload).toBe('Review all PRs');
    });

    it('should set createdAt to a valid ISO timestamp', () => {
      const { service, routedMessages } = createTestService({});

      service.enqueue(createRequest());

      const { message } = routedMessages[0]!;
      const { createdAt } = message;
      expect(new Date(createdAt).toISOString()).toBe(createdAt);
    });
  });

  // ───────────────────────────────────────────
  // Anti-Recursion Protection
  // ───────────────────────────────────────────

  describe('anti-recursion protection', () => {
    it('should reject when source agent is bound to the same project', () => {
      const { service } = createTestService({
        projectBindings: {
          'oc_source_chat_123': 'target-project',
        },
      });

      const result = service.enqueue(createRequest({
        projectKey: 'target-project',
        sourceChatId: 'oc_source_chat_123',
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Anti-recursion');
        expect(result.error).toContain('target-project');
      }
    });

    it('should allow cross-project delegation', () => {
      const { service, routedMessages } = createTestService({
        projectBindings: {
          'oc_source_chat_123': 'source-project',
        },
      });

      const result = service.enqueue(createRequest({
        projectKey: 'different-project',
        sourceChatId: 'oc_source_chat_123',
      }));

      expect(result.ok).toBe(true);
      expect(routedMessages).toHaveLength(1);
      expect(routedMessages[0]!.message.projectKey).toBe('different-project');
    });

    it('should allow enqueue when source agent has no project binding', () => {
      const { service, routedMessages } = createTestService({
        projectBindings: {}, // no bindings — source agent is in default workspace
      });

      const result = service.enqueue(createRequest());

      expect(result.ok).toBe(true);
      expect(routedMessages).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────
  // Rate Limiting
  // ───────────────────────────────────────────

  describe('rate limiting', () => {
    it('should allow messages within rate limit', () => {
      const { service } = createTestService({
        rateLimit: { maxMessagesPerWindow: 5, windowMs: 60_000 },
      });

      for (let i = 0; i < 5; i++) {
        const result = service.enqueue(createRequest({ payload: `Task ${i}` }));
        expect(result.ok).toBe(true);
      }
    });

    it('should reject messages exceeding rate limit', () => {
      const { service } = createTestService({
        rateLimit: { maxMessagesPerWindow: 3, windowMs: 60_000 },
      });

      // Send 3 messages (should succeed)
      for (let i = 0; i < 3; i++) {
        const result = service.enqueue(createRequest({ payload: `Task ${i}` }));
        expect(result.ok).toBe(true);
      }

      // 4th message should be rejected
      const result = service.enqueue(createRequest({ payload: 'Task 3' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Rate limit');
      }
    });

    it('should track rate limits independently per source', () => {
      const { service } = createTestService({
        rateLimit: { maxMessagesPerWindow: 2, windowMs: 60_000 },
      });

      // Source A: 2 messages
      const resultA1 = service.enqueue(createRequest({ sourceChatId: 'oc_A', payload: 'Task A1' }));
      const resultA2 = service.enqueue(createRequest({ sourceChatId: 'oc_A', payload: 'Task A2' }));
      expect(resultA1.ok).toBe(true);
      expect(resultA2.ok).toBe(true);

      // Source A: 3rd message should fail
      const resultA3 = service.enqueue(createRequest({ sourceChatId: 'oc_A', payload: 'Task A3' }));
      expect(resultA3.ok).toBe(false);

      // Source B: should still be allowed (independent budget)
      const resultB1 = service.enqueue(createRequest({ sourceChatId: 'oc_B', payload: 'Task B1' }));
      expect(resultB1.ok).toBe(true);
    });

    it('should reset rate limit after window expires', () => {
      vi.useFakeTimers();

      try {
        const { service } = createTestService({
          rateLimit: { maxMessagesPerWindow: 2, windowMs: 10_000 },
        });

        // Send 2 messages
        service.enqueue(createRequest({ payload: 'Task 1' }));
        service.enqueue(createRequest({ payload: 'Task 2' }));

        // 3rd should be rejected
        const result1 = service.enqueue(createRequest({ payload: 'Task 3' }));
        expect(result1.ok).toBe(false);

        // Advance time past the window
        vi.advanceTimersByTime(10_001);

        // Now should be allowed again
        const result2 = service.enqueue(createRequest({ payload: 'Task 4' }));
        expect(result2.ok).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should use default rate limit when not configured', () => {
      const { service } = createTestService({});

      // Default is 10 per 60s — 10 should succeed
      for (let i = 0; i < 10; i++) {
        const result = service.enqueue(createRequest({ payload: `Task ${i}` }));
        expect(result.ok).toBe(true);
      }

      // 11th should fail
      const result = service.enqueue(createRequest({ payload: 'Task 10' }));
      expect(result.ok).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // Route Failure Propagation
  // ───────────────────────────────────────────

  describe('route failure propagation', () => {
    it('should propagate router errors to the caller', () => {
      const { service } = createTestService({
        routeResults: 'error',
      });

      const result = service.enqueue(createRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Router error');
      }
    });
  });

  // ───────────────────────────────────────────
  // Rate Limit Status
  // ───────────────────────────────────────────

  describe('getRateLimitStatus', () => {
    it('should return zero usage for new source', () => {
      const { service } = createTestService({});

      const status = service.getRateLimitStatus('oc_new_chat');

      expect(status.currentCount).toBe(0);
      expect(status.maxPerWindow).toBe(10); // default
      expect(status.resetsAt).toBeUndefined();
    });

    it('should reflect current usage after messages', () => {
      const { service } = createTestService({
        rateLimit: { maxMessagesPerWindow: 5, windowMs: 60_000 },
      });

      service.enqueue(createRequest({ payload: 'Task 1' }));
      service.enqueue(createRequest({ payload: 'Task 2' }));

      const status = service.getRateLimitStatus('oc_source_chat_123');

      expect(status.currentCount).toBe(2);
      expect(status.maxPerWindow).toBe(5);
      expect(status.resetsAt).toBeDefined();
    });
  });

  // ───────────────────────────────────────────
  // Edge Cases
  // ───────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle enqueue with empty payload', () => {
      const { service, routedMessages } = createTestService({});

      const result = service.enqueue(createRequest({ payload: '' }));

      expect(result.ok).toBe(true);
      expect(routedMessages[0]!.message.payload).toBe('');
    });

    it('should handle enqueue with very long payload', () => {
      const { service, routedMessages } = createTestService({});
      const longPayload = 'x'.repeat(10_000);

      const result = service.enqueue(createRequest({ payload: longPayload }));

      expect(result.ok).toBe(true);
      expect(routedMessages[0]!.message.payload).toBe(longPayload);
    });

    it('should handle multiple enqueues to different projects from same source', () => {
      const { service, routedMessages } = createTestService({});

      service.enqueue(createRequest({ projectKey: 'project-A', payload: 'Task A' }));
      service.enqueue(createRequest({ projectKey: 'project-B', payload: 'Task B' }));
      service.enqueue(createRequest({ projectKey: 'project-C', payload: 'Task C' }));

      expect(routedMessages).toHaveLength(3);
      expect(routedMessages.map(m => m.message.projectKey)).toEqual([
        'project-A',
        'project-B',
        'project-C',
      ]);
    });

    it('should check anti-recursion before rate limiting', () => {
      const { service } = createTestService({
        projectBindings: {
          'oc_source': 'same-project',
        },
      });

      // Anti-recursion should trigger first, even if rate limit would also fail
      const result = service.enqueue(createRequest({
        projectKey: 'same-project',
        sourceChatId: 'oc_source',
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Anti-recursion');
      }
    });

    it('should not record message timestamp on route failure', () => {
      const { service } = createTestService({
        routeResults: 'error',
        rateLimit: { maxMessagesPerWindow: 1, windowMs: 60_000 },
      });

      // First attempt fails (route error)
      const result1 = service.enqueue(createRequest());
      expect(result1.ok).toBe(false);

      // Rate limit should still have budget since failed route didn't record
      const status = service.getRateLimitStatus('oc_source_chat_123');
      expect(status.currentCount).toBe(0);
    });
  });
});
