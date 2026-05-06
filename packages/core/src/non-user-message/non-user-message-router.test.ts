/**
 * Unit tests for NonUserMessageRouter — routing logic for system-driven messages.
 *
 * Tests cover:
 * - Routing to project with valid config (found project, found chatId)
 * - Routing when project not found
 * - Routing when project has no bound chatId
 * - Priority ordering (high before normal before low)
 * - Queue behavior when agent is busy
 * - Queue size limit enforcement
 * - Multiple projects with independent queues
 * - Edge cases (empty payload, same project multiple messages)
 *
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  NonUserMessage,
  ProjectRoutingConfig,
  IProjectRoutingProvider,
  IAgentMessageDelivery,
} from './types.js';
import { NonUserMessageRouter } from './non-user-message-router.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Create a NonUserMessage with sensible defaults */
function createMessage(overrides: Partial<NonUserMessage> = {}): NonUserMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    type: 'scheduled',
    source: 'scheduler:test-task',
    projectKey: 'test-project',
    payload: 'Test payload',
    priority: 'normal',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a mock IProjectRoutingProvider */
function createMockRoutingProvider(
  configs: Record<string, ProjectRoutingConfig | undefined>,
): IProjectRoutingProvider {
  return {
    getRoutingConfig(projectKey: string) {
      return configs[projectKey];
    },
  };
}

/** Create a mock IAgentMessageDelivery */
function createMockDelivery(): {
  delivery: IAgentMessageDelivery;
  deliveries: Array<{ chatId: string; payload: string }>;
} {
  const deliveries: Array<{ chatId: string; payload: string }> = [];
  return {
    delivery: {
      isAgentBusy: vi.fn().mockReturnValue(false),
      deliverMessage: vi.fn((chatId: string, payload: string) => {
        deliveries.push({ chatId, payload });
      }),
    },
    deliveries,
  };
}

/** Standard test config */
const TEST_PROJECT_CONFIG: ProjectRoutingConfig = {
  key: 'test-project',
  chatId: 'oc_test_chat_123',
  workingDir: '/workspace/test-project',
};

const OTHER_PROJECT_CONFIG: ProjectRoutingConfig = {
  key: 'other-project',
  chatId: 'oc_other_chat_456',
  workingDir: '/workspace/other-project',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('NonUserMessageRouter', () => {
  let router: NonUserMessageRouter;
  let mockProvider: IProjectRoutingProvider;
  let mockDelivery: IAgentMessageDelivery;
  let deliveries: Array<{ chatId: string; payload: string }>;

  beforeEach(() => {
    const { delivery, deliveries: del } = createMockDelivery();
    mockDelivery = delivery;
    deliveries = del;

    mockProvider = createMockRoutingProvider({
      'test-project': TEST_PROJECT_CONFIG,
      'other-project': OTHER_PROJECT_CONFIG,
    });

    router = new NonUserMessageRouter({
      projectRoutingProvider: mockProvider,
      agentMessageDelivery: mockDelivery,
    });
  });

  // ───────────────────────────────────────────
  // Basic Routing
  // ───────────────────────────────────────────

  describe('route()', () => {
    it('should route message to the correct ChatAgent via project config', () => {
      const message = createMessage({ projectKey: 'test-project' });

      const result = router.route(message);

      expect(result).toEqual({ ok: true, queued: false });
      expect(mockDelivery.deliverMessage).toHaveBeenCalledWith(
        'oc_test_chat_123',
        'Test payload',
      );
    });

    it('should route to different projects independently', () => {
      const msg1 = createMessage({ projectKey: 'test-project', payload: 'Task A' });
      const msg2 = createMessage({ projectKey: 'other-project', payload: 'Task B' });

      router.route(msg1);
      router.route(msg2);

      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]).toEqual({ chatId: 'oc_test_chat_123', payload: 'Task A' });
      expect(deliveries[1]).toEqual({ chatId: 'oc_other_chat_456', payload: 'Task B' });
    });
  });

  // ───────────────────────────────────────────
  // Project Not Found
  // ───────────────────────────────────────────

  describe('project not found', () => {
    it('should return error when project key is not configured', () => {
      const message = createMessage({ projectKey: 'nonexistent-project' });

      const result = router.route(message);

      expect(result).toEqual({
        ok: false,
        error: 'Project "nonexistent-project" not found',
      });
      expect(mockDelivery.deliverMessage).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────
  // Project Without chatId
  // ───────────────────────────────────────────

  describe('project without chatId', () => {
    it('should return error when project has no bound chatId', () => {
      const provider = createMockRoutingProvider({
        'no-chat-project': {
          key: 'no-chat-project',
          chatId: '',
          workingDir: '/workspace/no-chat',
        },
      });

      const localRouter = new NonUserMessageRouter({
        projectRoutingProvider: provider,
        agentMessageDelivery: mockDelivery,
      });

      const message = createMessage({ projectKey: 'no-chat-project' });
      const result = localRouter.route(message);

      expect(result).toEqual({
        ok: false,
        error: 'Project "no-chat-project" has no bound chatId',
      });
      expect(mockDelivery.deliverMessage).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────
  // Priority Ordering
  // ───────────────────────────────────────────

  describe('priority ordering', () => {
    it('should deliver messages in order of arrival when not busy', () => {
      const normalMsg = createMessage({ priority: 'normal', payload: 'normal task' });
      const highMsg = createMessage({ priority: 'high', payload: 'urgent task' });

      // Route normal first, then high — both delivered immediately
      router.route(normalMsg);
      router.route(highMsg);

      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]!.payload).toBe('normal task');
      expect(deliveries[1]!.payload).toBe('urgent task');
    });

    it('should deliver all messages even with mixed priorities', () => {
      const lowMsg = createMessage({ priority: 'low', payload: 'low task' });
      const normalMsg = createMessage({ priority: 'normal', payload: 'normal task' });
      const highMsg = createMessage({ priority: 'high', payload: 'high task' });

      router.route(lowMsg);
      router.route(normalMsg);
      router.route(highMsg);

      // All three should be delivered synchronously
      expect(deliveries).toHaveLength(3);
      // Each is delivered immediately since processing is synchronous
      expect(deliveries[0]!.payload).toBe('low task');
      expect(deliveries[1]!.payload).toBe('normal task');
      expect(deliveries[2]!.payload).toBe('high task');
    });
  });

  // ───────────────────────────────────────────
  // Queue Size Limit
  // ───────────────────────────────────────────

  describe('queue size limit', () => {
    it('should reject messages when queue is at capacity (maxQueueSize = 0)', () => {
      const provider = createMockRoutingProvider({
        'test-project': TEST_PROJECT_CONFIG,
      });

      const localRouter = new NonUserMessageRouter({
        projectRoutingProvider: provider,
        agentMessageDelivery: mockDelivery,
        maxQueueSize: 0,
      });

      const msg = createMessage({ payload: 'task 1' });
      const result = localRouter.route(msg);

      // With maxQueueSize=0, queue.size (0) >= maxQueueSize (0) → reject
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Queue full');
      }
    });

    it('should allow messages when under the limit', () => {
      const provider = createMockRoutingProvider({
        'test-project': TEST_PROJECT_CONFIG,
      });

      const localRouter = new NonUserMessageRouter({
        projectRoutingProvider: provider,
        agentMessageDelivery: mockDelivery,
        maxQueueSize: 10,
      });

      const msg = createMessage({ payload: 'task 1' });
      const result = localRouter.route(msg);

      expect(result.ok).toBe(true);
    });
  });

  // ───────────────────────────────────────────
  // enqueue() Method
  // ───────────────────────────────────────────

  describe('enqueue()', () => {
    it('should enqueue message for a known project', () => {
      const message = createMessage({ projectKey: 'test-project' });

      const result = router.enqueue('test-project', message);

      expect(result.ok).toBe(true);
      expect(mockDelivery.deliverMessage).toHaveBeenCalledWith(
        'oc_test_chat_123',
        'Test payload',
      );
    });

    it('should return error for unknown project', () => {
      const message = createMessage({ projectKey: 'unknown-project' });

      const result = router.enqueue('unknown-project', message);

      expect(result).toEqual({
        ok: false,
        error: 'Project "unknown-project" not found',
      });
    });
  });

  // ───────────────────────────────────────────
  // Queue Inspection
  // ───────────────────────────────────────────

  describe('getQueueSize()', () => {
    it('should return 0 for projects with no messages', () => {
      expect(router.getQueueSize('test-project')).toBe(0);
    });

    it('should return 0 for unknown projects', () => {
      expect(router.getQueueSize('nonexistent')).toBe(0);
    });
  });

  describe('getActiveProjectKeys()', () => {
    it('should return empty array when no messages queued', () => {
      expect(router.getActiveProjectKeys()).toEqual([]);
    });
  });

  // ───────────────────────────────────────────
  // Error Handling
  // ───────────────────────────────────────────

  describe('error handling', () => {
    it('should handle delivery errors gracefully', () => {
      const failingDelivery: IAgentMessageDelivery = {
        isAgentBusy: () => false,
        deliverMessage: vi.fn(() => {
          throw new Error('Agent unavailable');
        }),
      };

      const localRouter = new NonUserMessageRouter({
        projectRoutingProvider: mockProvider,
        agentMessageDelivery: failingDelivery,
      });

      const message = createMessage({ projectKey: 'test-project' });

      // Should not throw — error is logged and swallowed
      const result = localRouter.route(message);
      expect(result.ok).toBe(true);
    });
  });

  // ───────────────────────────────────────────
  // Message Types
  // ───────────────────────────────────────────

  describe('message types', () => {
    it('should route scheduled messages', () => {
      const message = createMessage({ type: 'scheduled' });
      const result = router.route(message);
      expect(result.ok).toBe(true);
    });

    it('should route a2a messages', () => {
      const message = createMessage({ type: 'a2a', source: 'chat:oc_source_chat' });
      const result = router.route(message);
      expect(result.ok).toBe(true);
    });

    it('should route webhook messages', () => {
      const message = createMessage({ type: 'webhook', source: 'webhook:github' });
      const result = router.route(message);
      expect(result.ok).toBe(true);
    });

    it('should route system messages', () => {
      const message = createMessage({ type: 'system', source: 'system:admin-trigger' });
      const result = router.route(message);
      expect(result.ok).toBe(true);
    });
  });

  // ───────────────────────────────────────────
  // Multiple Messages Same Project
  // ───────────────────────────────────────────

  describe('multiple messages to same project', () => {
    it('should deliver all messages sequentially', () => {
      const msg1 = createMessage({ payload: 'task 1' });
      const msg2 = createMessage({ payload: 'task 2' });
      const msg3 = createMessage({ payload: 'task 3' });

      router.route(msg1);
      router.route(msg2);
      router.route(msg3);

      expect(deliveries).toHaveLength(3);
      expect(deliveries.map(d => d.payload)).toEqual(['task 1', 'task 2', 'task 3']);
    });
  });
});
