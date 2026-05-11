/**
 * Unit tests for A2ARouter (Issue #3334).
 *
 * Tests:
 * - Basic enqueue task success flow
 * - Anti-recursion protection
 * - Rate limiting
 * - Parameter validation
 * - Error handling when router not initialized
 * - Rate limit quota tracking
 */

import { describe, it, expect, vi } from 'vitest';
import {
  A2ARouter,
  type A2AEnqueueCallback,
} from './a2a-router.js';
import type {
  A2AMessage,
  ProjectLookup,
  ProjectLookupResult,
} from '../types/unified-message.js';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockProjectLookup(
  projects: Record<string, ProjectLookupResult>
): ProjectLookup {
  return {
    lookup(projectKey: string): ProjectLookupResult | undefined {
      return projects[projectKey];
    },
  };
}

function createMockEnqueue(): {
  callback: A2AEnqueueCallback;
  calls: Array<{ projectKey: string; message: A2AMessage }>;
} {
  const calls: Array<{ projectKey: string; message: A2AMessage }> = [];
  const callback: A2AEnqueueCallback = (projectKey, message) => {
    calls.push({ projectKey, message });
    return Promise.resolve();
  };
  return { callback, calls };
}

function createFailingEnqueue(error: Error): A2AEnqueueCallback {
  return () => Promise.reject(error);
}

// ============================================================================
// Test Fixtures
// ============================================================================

const SOURCE_CHAT_ID = 'oc_source_chat';
const TARGET_CHAT_ID = 'oc_target_chat';
const PROJECT_KEY = 'test/repo';
const PROJECT_LOOKUP = createMockProjectLookup({
  [PROJECT_KEY]: { chatId: TARGET_CHAT_ID, workingDir: '/path/to/project' },
});
const OTHER_PROJECT_KEY = 'other/repo';
const PROJECT_LOOKUP_WITH_OTHER = createMockProjectLookup({
  [PROJECT_KEY]: { chatId: TARGET_CHAT_ID, workingDir: '/path/to/project' },
  [OTHER_PROJECT_KEY]: { chatId: 'oc_other_chat', workingDir: '/path/to/other' },
});

// ============================================================================
// Tests
// ============================================================================

describe('A2ARouter', () => {

  // ──────────────────────────────────────────────
  // Basic Success Flow
  // ──────────────────────────────────────────────

  describe('enqueueTask success', () => {
    it('should enqueue a task successfully', async () => {
      const { callback, calls } = createMockEnqueue();
      const router = new A2ARouter({
        projectLookup: PROJECT_LOOKUP,
        enqueue: callback,
      });

      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'Triage all open issues',
        priority: 'high',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain(PROJECT_KEY);
      expect(result.message).toContain('high');
      expect(calls).toHaveLength(1);
      expect(calls[0].projectKey).toBe(PROJECT_KEY);
    });

    it('should create A2AMessage with correct fields', async () => {
      const { callback, calls } = createMockEnqueue();
      const router = new A2ARouter({
        projectLookup: PROJECT_LOOKUP,
        enqueue: callback,
      });

      await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'Test payload',
      });

      const [firstCall] = calls;
      const { message } = firstCall;
      expect(message.source).toBe('agent');
      expect(message.fromChatId).toBe(SOURCE_CHAT_ID);
      expect(message.projectKey).toBe(PROJECT_KEY);
      expect(message.payload).toBe('Test payload');
      expect(message.priority).toBe('normal'); // default
      expect(message.id).toMatch(/^a2a-/);
      expect(message.createdAt).toBeDefined();
    });

    it('should default priority to "normal"', async () => {
      const { callback, calls } = createMockEnqueue();
      const router = new A2ARouter({
        projectLookup: PROJECT_LOOKUP,
        enqueue: callback,
      });

      await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'Test',
      });

      expect(calls[0].message.priority).toBe('normal');
    });

    it('should work without projectLookup (no anti-recursion check)', async () => {
      const { callback, calls } = createMockEnqueue();
      const router = new A2ARouter({ enqueue: callback });

      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'Test',
      });

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────
  // Anti-Recursion Protection
  // ──────────────────────────────────────────────

  describe('anti-recursion', () => {
    it('should reject when agent enqueues to its own project', async () => {
      const { callback } = createMockEnqueue();
      const router = new A2ARouter({
        projectLookup: PROJECT_LOOKUP,
        enqueue: callback,
      });

      // SOURCE_CHAT_ID === TARGET_CHAT_ID → recursion
      const result = await router.enqueueTask({
        fromChatId: TARGET_CHAT_ID, // same as project's chatId
        projectKey: PROJECT_KEY,
        payload: 'Self-delegation attempt',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Anti-recursion');
      expect(result.message).toContain(TARGET_CHAT_ID);
    });

    it('should allow enqueue to different project', async () => {
      const { callback, calls } = createMockEnqueue();
      const router = new A2ARouter({
        projectLookup: PROJECT_LOOKUP_WITH_OTHER,
        enqueue: callback,
      });

      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: OTHER_PROJECT_KEY,
        payload: 'Delegate to other project',
      });

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it('should allow enqueue when project not found in lookup', async () => {
      const { callback, calls } = createMockEnqueue();
      const emptyLookup = createMockProjectLookup({});
      const router = new A2ARouter({
        projectLookup: emptyLookup,
        enqueue: callback,
      });

      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: 'nonexistent/repo',
        payload: 'Test',
      });

      // No recursion risk since project not found
      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────
  // Rate Limiting
  // ──────────────────────────────────────────────

  describe('rate limiting', () => {
    it('should allow messages within the limit', async () => {
      const { callback, calls } = createMockEnqueue();
      const router = new A2ARouter({
        enqueue: callback,
        maxMessagesPerWindow: 3,
        windowMs: 60_000,
      });

      for (let i = 0; i < 3; i++) {
        const result = await router.enqueueTask({
          fromChatId: SOURCE_CHAT_ID,
          projectKey: PROJECT_KEY,
          payload: `Message ${i}`,
        });
        expect(result.success).toBe(true);
      }

      expect(calls).toHaveLength(3);
    });

    it('should reject messages exceeding the limit', async () => {
      const { callback } = createMockEnqueue();
      const router = new A2ARouter({
        enqueue: callback,
        maxMessagesPerWindow: 2,
        windowMs: 60_000,
      });

      // First two should succeed
      await router.enqueueTask({ fromChatId: SOURCE_CHAT_ID, projectKey: PROJECT_KEY, payload: '1' });
      await router.enqueueTask({ fromChatId: SOURCE_CHAT_ID, projectKey: PROJECT_KEY, payload: '2' });

      // Third should be rejected
      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: '3',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Rate limit exceeded');
      expect(result.message).toContain('2');
    });

    it('should track rate limits per fromChatId independently', async () => {
      const { callback, calls } = createMockEnqueue();
      const router = new A2ARouter({
        enqueue: callback,
        maxMessagesPerWindow: 2,
        windowMs: 60_000,
      });

      // Two messages from chat A
      await router.enqueueTask({ fromChatId: 'chat_A', projectKey: PROJECT_KEY, payload: 'A1' });
      await router.enqueueTask({ fromChatId: 'chat_A', projectKey: PROJECT_KEY, payload: 'A2' });

      // Chat A should be rate limited
      const resultA = await router.enqueueTask({ fromChatId: 'chat_A', projectKey: PROJECT_KEY, payload: 'A3' });
      expect(resultA.success).toBe(false);

      // Chat B should still be allowed
      const resultB = await router.enqueueTask({ fromChatId: 'chat_B', projectKey: PROJECT_KEY, payload: 'B1' });
      expect(resultB.success).toBe(true);

      expect(calls).toHaveLength(3); // 2 from A + 1 from B
    });

    it('should reset rate limit after window expires', async () => {
      vi.useFakeTimers();

      const { callback, calls } = createMockEnqueue();
      const router = new A2ARouter({
        enqueue: callback,
        maxMessagesPerWindow: 1,
        windowMs: 1000, // 1 second
      });

      // First message succeeds
      const result1 = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'First',
      });
      expect(result1.success).toBe(true);

      // Second message is rate limited
      const result2 = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'Second',
      });
      expect(result2.success).toBe(false);

      // Advance time past the window
      vi.advanceTimersByTime(1001);

      // Should be allowed again
      const result3 = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'Third',
      });
      expect(result3.success).toBe(true);

      expect(calls).toHaveLength(2);

      vi.useRealTimers();
    });
  });

  // ──────────────────────────────────────────────
  // Parameter Validation
  // ──────────────────────────────────────────────

  describe('parameter validation', () => {
    it('should reject empty fromChatId', async () => {
      const router = new A2ARouter({ enqueue: async () => {} });
      const result = await router.enqueueTask({
        fromChatId: '',
        projectKey: PROJECT_KEY,
        payload: 'Test',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('fromChatId');
    });

    it('should reject empty projectKey', async () => {
      const router = new A2ARouter({ enqueue: async () => {} });
      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: '',
        payload: 'Test',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('projectKey');
    });

    it('should reject empty payload', async () => {
      const router = new A2ARouter({ enqueue: async () => {} });
      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: '',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('payload');
    });
  });

  // ──────────────────────────────────────────────
  // Error Handling
  // ──────────────────────────────────────────────

  describe('error handling', () => {
    it('should return error when router not initialized', async () => {
      const router = new A2ARouter(); // No enqueue callback
      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not initialized');
    });

    it('should return error when enqueue callback throws', async () => {
      const router = new A2ARouter({
        enqueue: createFailingEnqueue(new Error('Project not found: bad/repo')),
      });

      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: 'bad/repo',
        payload: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Project not found');
    });

    it('should handle non-Error exceptions from enqueue callback', async () => {
      const router = new A2ARouter({
        enqueue: () => Promise.reject(new Error('string error')),
      });

      const result = await router.enqueueTask({
        fromChatId: SOURCE_CHAT_ID,
        projectKey: PROJECT_KEY,
        payload: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('string error');
    });
  });

  // ──────────────────────────────────────────────
  // Rate Limit Quota Tracking
  // ──────────────────────────────────────────────

  describe('getRemainingQuota', () => {
    it('should return full quota when no messages sent', () => {
      const router = new A2ARouter({ maxMessagesPerWindow: 5, windowMs: 60_000 });
      expect(router.getRemainingQuota(SOURCE_CHAT_ID)).toBe(5);
    });

    it('should decrease quota after messages', async () => {
      const { callback } = createMockEnqueue();
      const router = new A2ARouter({
        enqueue: callback,
        maxMessagesPerWindow: 5,
        windowMs: 60_000,
      });

      await router.enqueueTask({ fromChatId: SOURCE_CHAT_ID, projectKey: PROJECT_KEY, payload: '1' });
      expect(router.getRemainingQuota(SOURCE_CHAT_ID)).toBe(4);

      await router.enqueueTask({ fromChatId: SOURCE_CHAT_ID, projectKey: PROJECT_KEY, payload: '2' });
      expect(router.getRemainingQuota(SOURCE_CHAT_ID)).toBe(3);
    });

    it('should track quota per chatId independently', async () => {
      const { callback } = createMockEnqueue();
      const router = new A2ARouter({
        enqueue: callback,
        maxMessagesPerWindow: 5,
        windowMs: 60_000,
      });

      await router.enqueueTask({ fromChatId: 'chat_A', projectKey: PROJECT_KEY, payload: '1' });
      await router.enqueueTask({ fromChatId: 'chat_A', projectKey: PROJECT_KEY, payload: '2' });

      expect(router.getRemainingQuota('chat_A')).toBe(3);
      expect(router.getRemainingQuota('chat_B')).toBe(5);
    });
  });

  describe('clearRateLimits', () => {
    it('should reset all rate limits', async () => {
      const { callback } = createMockEnqueue();
      const router = new A2ARouter({
        enqueue: callback,
        maxMessagesPerWindow: 1,
        windowMs: 60_000,
      });

      await router.enqueueTask({ fromChatId: SOURCE_CHAT_ID, projectKey: PROJECT_KEY, payload: '1' });
      expect(router.getRemainingQuota(SOURCE_CHAT_ID)).toBe(0);

      router.clearRateLimits();
      expect(router.getRemainingQuota(SOURCE_CHAT_ID)).toBe(1);
    });
  });
});
