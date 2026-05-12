/**
 * Tests for A2ARouter - Agent-to-Agent task delegation.
 *
 * Issue #3334: Unit tests covering all safety mechanisms:
 * - Basic enqueue success
 * - Anti-recursion (self-delegation blocked)
 * - Rate limiting (per chatId sliding window)
 * - Parameter validation
 * - Error handling
 * - Rate limit usage tracking
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { A2ARouter, type A2AMessage, type A2ARouterConfig } from './a2a-router.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockConfig(overrides?: Partial<A2ARouterConfig>): A2ARouterConfig {
  return {
    projectLookup: vi.fn().mockResolvedValue({ chatId: 'oc_target', workingDir: '/project' }),
    messageRouter: vi.fn().mockResolvedValue(true),
    maxMessagesPerWindow: 3,
    rateLimitWindowMs: 1000,
    ...overrides,
  };
}

describe('A2ARouter', () => {
  let router: A2ARouter;
  let config: A2ARouterConfig;

  beforeEach(() => {
    config = createMockConfig();
    router = new A2ARouter(config);
  });

  // ==========================================================================
  // Basic enqueue success
  // ==========================================================================

  describe('enqueueTask', () => {
    it('should successfully enqueue a task', async () => {
      const result = await router.enqueueTask('oc_source', 'test-project', 'Do something');

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(result.message).toContain('test-project');
      expect(config.messageRouter).toHaveBeenCalledWith(
        'test-project',
        expect.objectContaining({
          type: 'a2a',
          fromChatId: 'oc_source',
          projectKey: 'test-project',
          payload: 'Do something',
          priority: 'normal',
        }),
      );
    });

    it('should use custom priority when provided', async () => {
      const result = await router.enqueueTask('oc_source', 'test-project', 'Urgent task', 'high');

      expect(result.success).toBe(true);
      expect(config.messageRouter).toHaveBeenCalledWith(
        'test-project',
        expect.objectContaining({ priority: 'high' }),
      );
    });

    it('should generate unique message IDs', async () => {
      const result1 = await router.enqueueTask('oc_source', 'project-a', 'Task 1');
      const result2 = await router.enqueueTask('oc_source', 'project-b', 'Task 2');

      expect(result1.messageId).not.toBe(result2.messageId);
    });

    it('should include ISO timestamp in message', async () => {
      await router.enqueueTask('oc_source', 'test-project', 'Do something');

      const a2aMessage = (config.messageRouter as ReturnType<typeof vi.fn>).mock.calls[0][1] as A2AMessage;
      expect(a2aMessage.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ==========================================================================
  // Parameter validation
  // ==========================================================================

  describe('parameter validation', () => {
    it('should reject empty fromChatId', async () => {
      const result = await router.enqueueTask('', 'test-project', 'Do something');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required parameters');
    });

    it('should reject empty projectKey', async () => {
      const result = await router.enqueueTask('oc_source', '', 'Do something');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required parameters');
    });

    it('should reject empty payload', async () => {
      const result = await router.enqueueTask('oc_source', 'test-project', '');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required parameters');
    });
  });

  // ==========================================================================
  // Anti-recursion
  // ==========================================================================

  describe('anti-recursion', () => {
    it('should block self-delegation (same chatId as target)', async () => {
      const result = await router.enqueueTask('oc_target', 'test-project', 'Do something');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Cannot enqueue task to own project');
      expect(config.messageRouter).not.toHaveBeenCalled();
    });

    it('should allow delegation to different project', async () => {
      const result = await router.enqueueTask('oc_source', 'test-project', 'Do something');

      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Rate limiting
  // ==========================================================================

  describe('rate limiting', () => {
    it('should allow messages within the limit', async () => {
      const results = await Promise.all([
        router.enqueueTask('oc_source', 'test-project', 'Task 1'),
        router.enqueueTask('oc_source', 'test-project', 'Task 2'),
        router.enqueueTask('oc_source', 'test-project', 'Task 3'),
      ]);

      expect(results.every(r => r.success)).toBe(true);
    });

    it('should reject messages exceeding the limit', async () => {
      // Send 3 messages (the limit)
      await router.enqueueTask('oc_source', 'test-project', 'Task 1');
      await router.enqueueTask('oc_source', 'test-project', 'Task 2');
      await router.enqueueTask('oc_source', 'test-project', 'Task 3');

      // 4th should be rejected
      const result = await router.enqueueTask('oc_source', 'test-project', 'Task 4');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Rate limit exceeded');
    });

    it('should track rate limits per source chatId independently', async () => {
      // Fill limit for oc_source
      await router.enqueueTask('oc_source', 'test-project', 'Task 1');
      await router.enqueueTask('oc_source', 'test-project', 'Task 2');
      await router.enqueueTask('oc_source', 'test-project', 'Task 3');

      // oc_other should still be able to send
      const otherConfig = createMockConfig();
      otherConfig.projectLookup = vi.fn().mockResolvedValue({ chatId: 'oc_target', workingDir: '/project' });
      const otherRouter = new A2ARouter(otherConfig);

      const result = await otherRouter.enqueueTask('oc_other', 'test-project', 'Other task');
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Project lookup failures
  // ==========================================================================

  describe('project lookup', () => {
    it('should fail if project is not found', async () => {
      config = createMockConfig({
        projectLookup: vi.fn().mockResolvedValue(undefined),
      });
      router = new A2ARouter(config);

      const result = await router.enqueueTask('oc_source', 'nonexistent', 'Do something');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Project not found');
    });
  });

  // ==========================================================================
  // Message router failures
  // ==========================================================================

  describe('message router errors', () => {
    it('should handle router returning false', async () => {
      config = createMockConfig({
        messageRouter: vi.fn().mockResolvedValue(false),
      });
      router = new A2ARouter(config);

      const result = await router.enqueueTask('oc_source', 'test-project', 'Do something');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to route message');
    });

    it('should handle router throwing an error', async () => {
      config = createMockConfig({
        messageRouter: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      router = new A2ARouter(config);

      const result = await router.enqueueTask('oc_source', 'test-project', 'Do something');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to enqueue task');
      expect(result.message).toContain('Connection refused');
    });
  });

  // ==========================================================================
  // Rate limit usage
  // ==========================================================================

  describe('getRateLimitUsage', () => {
    it('should return current usage', async () => {
      await router.enqueueTask('oc_source', 'test-project', 'Task 1');

      const usage = router.getRateLimitUsage('oc_source');
      expect(usage.count).toBe(1);
      expect(usage.limit).toBe(3);
    });

    it('should return zero for unknown chatId', () => {
      const usage = router.getRateLimitUsage('oc_unknown');
      expect(usage.count).toBe(0);
    });
  });
});
