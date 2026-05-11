/**
 * Unit tests for A2A enqueue_task tool (Issue #3334).
 *
 * Covers:
 * - Successful task enqueue
 * - Anti-recursion protection
 * - Rate limiting
 * - Project not found
 * - Router busy (queued)
 * - Router disposed
 * - Source traceability
 * - Priority defaulting to 'normal'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createA2AEnqueueHandler } from './a2a-enqueue-tool.js';
import { A2ARateLimiter } from './a2a-rate-limiter.js';
import type { A2AConfig } from './a2a-types.js';
import { NonUserMessageRouter, StaticProjectResolver } from './non-user-message-router.js';
import { AgentPool, type ChatAgentFactory } from '../agents/agent-pool.js';
import type { ChatAgent } from '../agents/types.js';

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

function createTestConfig(overrides?: {
  projectMapping?: Record<string, string>;
  rateLimit?: Partial<{ maxMessagesPerWindow: number; windowMs: number }>;
}): { config: A2AConfig; pool: AgentPool } {
  const mockFactory: ChatAgentFactory = vi.fn(createMockChatAgent);
  const pool = new AgentPool({ chatAgentFactory: mockFactory });

  const resolver = new StaticProjectResolver(
    overrides?.projectMapping ?? {
      'target/project': 'oc_target_chat',
      'source/project': 'oc_source_chat',
    },
  );

  const router = new NonUserMessageRouter({
    projectResolver: resolver,
    agentPool: pool,
  });

  const config: A2AConfig = {
    projectResolver: resolver,
    router,
    rateLimit: overrides?.rateLimit,
  };

  return { config, pool };
}

// ============================================================================
// A2ARateLimiter Tests
// ============================================================================

describe('A2ARateLimiter', () => {
  it('should allow messages within the limit', () => {
    const limiter = new A2ARateLimiter({ maxMessagesPerWindow: 3, windowMs: 60_000 });
    expect(limiter.check('source-1')).toBe(true);
    expect(limiter.check('source-1')).toBe(true);
    expect(limiter.check('source-1')).toBe(true);
  });

  it('should reject messages exceeding the limit', () => {
    const limiter = new A2ARateLimiter({ maxMessagesPerWindow: 2, windowMs: 60_000 });
    expect(limiter.check('source-1')).toBe(true);
    expect(limiter.check('source-1')).toBe(true);
    expect(limiter.check('source-1')).toBe(false);
  });

  it('should track sources independently', () => {
    const limiter = new A2ARateLimiter({ maxMessagesPerWindow: 1, windowMs: 60_000 });
    expect(limiter.check('source-1')).toBe(true);
    expect(limiter.check('source-2')).toBe(true);
    expect(limiter.check('source-1')).toBe(false);
    expect(limiter.check('source-2')).toBe(false);
  });

  it('should reset state', () => {
    const limiter = new A2ARateLimiter({ maxMessagesPerWindow: 1, windowMs: 60_000 });
    limiter.check('source-1');
    limiter.reset();
    expect(limiter.check('source-1')).toBe(true);
  });

  it('should report count correctly', () => {
    const limiter = new A2ARateLimiter({ maxMessagesPerWindow: 5, windowMs: 60_000 });
    limiter.check('source-1');
    limiter.check('source-1');
    expect(limiter.getCount('source-1')).toBe(2);
    expect(limiter.getCount('source-2')).toBe(0);
  });
});

// ============================================================================
// createA2AEnqueueHandler Tests
// ============================================================================

describe('createA2AEnqueueHandler', () => {
  let config: A2AConfig;
  let pool: AgentPool;

  beforeEach(() => {
    ({ config, pool } = createTestConfig());
  });

  afterEach(() => {
    pool.disposeAll();
    config.router.dispose();
  });

  describe('successful enqueue', () => {
    it('should route A2A message successfully', async () => {
      const handler = createA2AEnqueueHandler(config, 'oc_source_chat');
      const result = await handler({
        projectKey: 'target/project',
        payload: 'Analyze all open issues',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.messageId).toMatch(/^a2a-/);
        expect(result.targetProject).toBe('target/project');
      }

      // Verify agent received the message
      const agent = pool.get('oc_target_chat');
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_target_chat',
        'Analyze all open issues',
        expect.stringMatching(/^a2a-/),
      );
    });

    it('should use normal priority by default', async () => {
      const routeSpy = vi.spyOn(config.router, 'route');

      const handler = createA2AEnqueueHandler(config, 'oc_source_chat');
      await handler({
        projectKey: 'target/project',
        payload: 'Test payload',
      });

      expect(routeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'a2a',
          priority: 'normal',
        }),
      );
    });

    it('should respect specified priority', async () => {
      const routeSpy = vi.spyOn(config.router, 'route');

      const handler = createA2AEnqueueHandler(config, 'oc_source_chat');
      await handler({
        projectKey: 'target/project',
        payload: 'Urgent task',
        priority: 'high',
      });

      expect(routeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'high',
        }),
      );
    });
  });

  describe('anti-recursion', () => {
    it('should reject tasks to own project', async () => {
      const handler = createA2AEnqueueHandler(config, 'oc_source_chat');
      const result = await handler({
        projectKey: 'source/project',
        payload: 'This would be recursion',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Anti-recursion');
      }
    });

    it('should allow tasks to different projects', async () => {
      const handler = createA2AEnqueueHandler(config, 'oc_source_chat');
      const result = await handler({
        projectKey: 'target/project',
        payload: 'Cross-project task',
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('should reject when rate limit exceeded', async () => {
      const limitedConfig = createTestConfig({
        rateLimit: { maxMessagesPerWindow: 2, windowMs: 60_000 },
      });

      const handler = createA2AEnqueueHandler(limitedConfig.config, 'oc_source_chat');

      // First two should succeed
      const r1 = await handler({ projectKey: 'target/project', payload: 'Task 1' });
      const r2 = await handler({ projectKey: 'target/project', payload: 'Task 2' });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      // Third should be rate limited
      const r3 = await handler({ projectKey: 'target/project', payload: 'Task 3' });
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.error).toContain('Rate limit');
      }

      limitedConfig.pool.disposeAll();
      limitedConfig.config.router.dispose();
    });
  });

  describe('source traceability', () => {
    it('should set source to chat:sourceChatId', async () => {
      const routeSpy = vi.spyOn(config.router, 'route');

      const handler = createA2AEnqueueHandler(config, 'oc_source_chat');
      await handler({
        projectKey: 'target/project',
        payload: 'Tracked task',
      });

      expect(routeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'chat:oc_source_chat',
          type: 'a2a',
        }),
      );
    });
  });

  describe('project not found', () => {
    it('should return error for unknown projectKey', async () => {
      const handler = createA2AEnqueueHandler(config, 'oc_source_chat');
      const result = await handler({
        projectKey: 'unknown/project',
        payload: 'Nobody home',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Project not found');
      }
    });
  });

  describe('non-blocking', () => {
    it('should return immediately even when target agent is busy', async () => {
      const handler = createA2AEnqueueHandler(config, 'oc_source_chat');

      // Make the target agent busy
      const agent = pool.getOrCreateChatAgent('oc_target_chat');
      let resolveTask!: () => void;
      const taskPromise = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      Object.defineProperty(agent, 'taskComplete', {
        value: taskPromise,
        writable: true,
        configurable: true,
      });

      // Handler should return immediately with ok=true (fire-and-forget)
      const start = Date.now();
      const result = await handler({
        projectKey: 'target/project',
        payload: 'Queued task',
      });
      const elapsed = Date.now() - start;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.messageId).toMatch(/^a2a-/);
      }
      // Should complete within 100ms (not waiting for agent to become idle)
      expect(elapsed).toBeLessThan(100);

      // Cleanup
      resolveTask();
    });
  });
});
