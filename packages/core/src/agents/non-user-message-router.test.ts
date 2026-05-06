/**
 * Tests for NonUserMessageRouter.
 *
 * Verifies routing logic, project registration, message queuing,
 * priority ordering, and error handling.
 *
 * Issue #3329 Phase 1 — System-Driven Task Pipeline for ChatAgent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NonUserMessageRouter } from './non-user-message-router.js';
import type {
  NonUserMessage,
  NonUserProjectConfig,
} from '../types/non-user-message.js';

/** Type for a mocked handler that exposes vitest mock properties. */
type MockedHandler = ReturnType<typeof vi.fn<(chatId: string, message: NonUserMessage) => Promise<void>>>;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createMessage(overrides: Partial<NonUserMessage> = {}): NonUserMessage {
  return {
    id: 'msg_test_001',
    type: 'scheduled',
    source: 'scheduler:daily-sync',
    projectKey: 'hs3180/disclaude',
    payload: 'Run daily sync',
    priority: 'normal',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createProjectConfig(overrides: Partial<NonUserProjectConfig> = {}): NonUserProjectConfig {
  return {
    key: 'hs3180/disclaude',
    workingDir: '/tmp/test-project',
    chatId: 'oc_test_chat',
    ...overrides,
  };
}

describe('NonUserMessageRouter', () => {
  let router: NonUserMessageRouter;
  let handler: MockedHandler;
  let handledMessages: Array<{ chatId: string; message: NonUserMessage }>;

  beforeEach(() => {
    handledMessages = [];
    handler = vi.fn(async (chatId: string, message: NonUserMessage) => {
      await Promise.resolve();
      handledMessages.push({ chatId, message });
    });

    router = new NonUserMessageRouter({ handler });
  });

  // ───────────────────────────────────────────
  // Project Registration
  // ───────────────────────────────────────────

  describe('registerProject', () => {
    it('should register a project configuration', () => {
      const config = createProjectConfig();
      router.registerProject(config);

      expect(router.getProject('hs3180/disclaude')).toEqual(config);
      expect(router.listProjects()).toEqual(['hs3180/disclaude']);
    });

    it('should throw if projectKey is empty', () => {
      expect(() => router.registerProject(createProjectConfig({ key: '' })))
        .toThrow('projectKey cannot be empty');
    });

    it('should throw if chatId is empty', () => {
      expect(() => router.registerProject(createProjectConfig({ chatId: '' })))
        .toThrow('chatId cannot be empty');
    });

    it('should allow registering multiple projects', () => {
      router.registerProject(createProjectConfig({ key: 'owner/repo1', chatId: 'oc_chat1' }));
      router.registerProject(createProjectConfig({ key: 'owner/repo2', chatId: 'oc_chat2' }));

      expect(router.listProjects()).toHaveLength(2);
    });
  });

  describe('unregisterProject', () => {
    it('should unregister a registered project', () => {
      router.registerProject(createProjectConfig());
      expect(router.unregisterProject('hs3180/disclaude')).toBe(true);
      expect(router.getProject('hs3180/disclaude')).toBeUndefined();
    });

    it('should return false for unregistered project', () => {
      expect(router.unregisterProject('nonexistent')).toBe(false);
    });
  });

  // ───────────────────────────────────────────
  // Message Routing
  // ───────────────────────────────────────────

  describe('route', () => {
    beforeEach(() => {
      router.registerProject(createProjectConfig());
    });

    it('should route message to handler with correct chatId', async () => {
      const message = createMessage();
      const result = await router.route(message);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.chatId).toBe('oc_test_chat');
      }
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith('oc_test_chat', message);
    });

    it('should fail for unregistered project', async () => {
      const message = createMessage({ projectKey: 'nonexistent/repo' });
      const result = await router.route(message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not registered');
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it('should fail for invalid message (missing id)', async () => {
      const message = createMessage({ id: '' });
      const result = await router.route(message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('id is required');
      }
    });

    it('should fail for invalid message (missing projectKey)', async () => {
      const message = createMessage({ projectKey: '' });
      const result = await router.route(message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('projectKey is required');
      }
    });

    it('should fail for invalid message (missing payload)', async () => {
      const message = createMessage({ payload: '' });
      const result = await router.route(message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('payload is required');
      }
    });

    it('should fail for invalid message (missing createdAt)', async () => {
      const message = createMessage({ createdAt: '' });
      const result = await router.route(message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('createdAt is required');
      }
    });

    it('should fail for invalid message type', async () => {
      const message = createMessage({ type: 'invalid' as any });
      const result = await router.route(message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid message type');
      }
    });

    it('should fail for invalid priority', async () => {
      const message = createMessage({ priority: 'urgent' as any });
      const result = await router.route(message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid priority');
      }
    });

    it('should handle different source types', async () => {
      const sources: Array<NonUserMessage['type']> = ['scheduled', 'a2a', 'webhook', 'system'];

      for (const type of sources) {
        const message = createMessage({ id: `msg_${type}`, type });
        const result = await router.route(message);
        expect(result.ok).toBe(true);
      }

      expect(handler).toHaveBeenCalledTimes(4);
    });

    it('should enqueue message when project is busy', async () => {
      // Create a handler that takes a long time (simulates busy agent)
      let resolveHandler: () => void;
      const slowHandler: MockedHandler = vi.fn(async () => {
        await new Promise<void>(resolve => { resolveHandler = resolve; });
      });

      const slowRouter = new NonUserMessageRouter({ handler: slowHandler });
      slowRouter.registerProject(createProjectConfig());

      // First message starts processing (blocks)
      const firstPromise = slowRouter.route(createMessage({ id: 'msg_1' }));

      // Wait a tick for the first route to start
      await new Promise(resolve => setTimeout(resolve, 0));

      // Second message should be enqueued
      const secondResult = await slowRouter.route(createMessage({ id: 'msg_2' }));
      expect(secondResult.ok).toBe(true);

      // Queue should have the second message
      expect(slowRouter.getQueueSize('hs3180/disclaude')).toBe(1);

      // Unblock the first handler
      resolveHandler!();
      await firstPromise;

      // After first completes, queue should be processed
      // Give processNext a tick to execute
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(slowHandler).toHaveBeenCalledTimes(2);
      expect(slowRouter.getQueueSize('hs3180/disclaude')).toBe(0);
    });
  });

  // ───────────────────────────────────────────
  // Message Queue
  // ───────────────────────────────────────────

  describe('enqueue', () => {
    it('should add message to queue', () => {
      router.registerProject(createProjectConfig());
      const message = createMessage();
      router.enqueue(message);

      expect(router.getQueueSize('hs3180/disclaude')).toBe(1);
    });

    it('should skip invalid messages', () => {
      router.registerProject(createProjectConfig());
      router.enqueue(createMessage({ id: '' }));

      expect(router.getQueueSize('hs3180/disclaude')).toBe(0);
    });

    it('should queue messages for different projects separately', () => {
      router.registerProject(createProjectConfig({ key: 'owner/repo1' }));
      router.registerProject(createProjectConfig({ key: 'owner/repo2' }));

      router.enqueue(createMessage({ projectKey: 'owner/repo1' }));
      router.enqueue(createMessage({ projectKey: 'owner/repo2' }));
      router.enqueue(createMessage({ projectKey: 'owner/repo1' }));

      expect(router.getQueueSize('owner/repo1')).toBe(2);
      expect(router.getQueueSize('owner/repo2')).toBe(1);
    });
  });

  describe('clearQueue', () => {
    it('should clear all queued messages for a project', () => {
      router.registerProject(createProjectConfig());
      router.enqueue(createMessage());
      router.enqueue(createMessage({ id: 'msg_2' }));

      const cleared = router.clearQueue('hs3180/disclaude');
      expect(cleared).toBe(2);
      expect(router.getQueueSize('hs3180/disclaude')).toBe(0);
    });

    it('should return 0 for empty queue', () => {
      expect(router.clearQueue('nonexistent')).toBe(0);
    });
  });

  describe('processNext', () => {
    it('should process next message in priority order', async () => {
      router.registerProject(createProjectConfig());

      const now = new Date();
      router.enqueue(createMessage({
        id: 'msg_low',
        priority: 'low',
        createdAt: now.toISOString(),
      }));
      router.enqueue(createMessage({
        id: 'msg_high',
        priority: 'high',
        createdAt: now.toISOString(),
      }));
      router.enqueue(createMessage({
        id: 'msg_normal',
        priority: 'normal',
        createdAt: now.toISOString(),
      }));

      // processNext auto-chains: first call processes all 3 in priority order
      await router.processNext('hs3180/disclaude');
      // Wait for auto-chained processNext calls to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify all 3 were processed in priority order
      expect(handler).toHaveBeenCalledTimes(3);
      const [, firstMessage] = handler.mock.calls[0] as [string, NonUserMessage];
      expect(firstMessage.id).toBe('msg_high');
      const [, secondMessage] = handler.mock.calls[1] as [string, NonUserMessage];
      expect(secondMessage.id).toBe('msg_normal');
      const [, thirdMessage] = handler.mock.calls[2] as [string, NonUserMessage];
      expect(thirdMessage.id).toBe('msg_low');

      // Queue should be empty
      expect(router.getQueueSize('hs3180/disclaude')).toBe(0);
    });

    it('should return false for empty queue', async () => {
      const result = await router.processNext('nonexistent');
      expect(result).toBe(false);
    });

    it('should order same-priority messages by createdAt', async () => {
      router.registerProject(createProjectConfig());

      router.enqueue(createMessage({
        id: 'msg_earlier',
        priority: 'normal',
        createdAt: '2026-01-01T00:00:00Z',
      }));
      router.enqueue(createMessage({
        id: 'msg_later',
        priority: 'normal',
        createdAt: '2026-01-02T00:00:00Z',
      }));

      await router.processNext('hs3180/disclaude');
      const [, firstMessage] = handler.mock.calls[0] as [string, NonUserMessage];
      expect(firstMessage.id).toBe('msg_earlier');
    });
  });

  // ───────────────────────────────────────────
  // Error Handling
  // ───────────────────────────────────────────

  describe('error handling', () => {
    it('should return error when handler throws', async () => {
      router.registerProject(createProjectConfig());

      const errorHandler: MockedHandler = vi.fn(async () => {
        await Promise.reject(new Error('Agent processing failed'));
      });

      const errorRouter = new NonUserMessageRouter({ handler: errorHandler });
      errorRouter.registerProject(createProjectConfig());

      const result = await errorRouter.route(createMessage());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Handler failed');
        expect(result.error).toContain('Agent processing failed');
      }
    });

    it('should continue processing queue after handler failure', async () => {
      router.registerProject(createProjectConfig());

      let callCount = 0;
      const failingHandler: MockedHandler = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          await Promise.reject(new Error('First call fails'));
        }
        await Promise.resolve();
      });

      const errorRouter = new NonUserMessageRouter({ handler: failingHandler });
      errorRouter.registerProject(createProjectConfig());

      // Enqueue two messages
      errorRouter.enqueue(createMessage({ id: 'msg_fail' }));
      errorRouter.enqueue(createMessage({ id: 'msg_ok' }));

      // First call fails, but second should still be attempted
      await errorRouter.processNext('hs3180/disclaude');

      // Wait for processNext to fire after failure
      await new Promise(resolve => setTimeout(resolve, 50));

      // Both messages should have been attempted
      expect(failingHandler).toHaveBeenCalledTimes(2);
    });
  });

  // ───────────────────────────────────────────
  // Edge Cases
  // ───────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle multiple project registrations with same key (overwrite)', () => {
      router.registerProject(createProjectConfig({ chatId: 'oc_chat1' }));
      router.registerProject(createProjectConfig({ chatId: 'oc_chat2' }));

      expect(router.getProject('hs3180/disclaude')!.chatId).toBe('oc_chat2');
      expect(router.listProjects()).toHaveLength(1);
    });

    it('should handle a2a source type with chat reference', async () => {
      router.registerProject(createProjectConfig());

      const a2aMessage = createMessage({
        type: 'a2a',
        source: 'chat:oc_sender_chat',
        payload: 'User requested immediate issue triage',
        priority: 'high',
      });

      const result = await router.route(a2aMessage);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.chatId).toBe('oc_test_chat');
      }
      expect(handler).toHaveBeenCalledWith('oc_test_chat', a2aMessage);
    });

    it('should handle webhook source type', async () => {
      router.registerProject(createProjectConfig());

      const webhookMessage = createMessage({
        type: 'webhook',
        source: 'webhook:github/issues',
        payload: 'New issue opened: Bug in login (#42)',
        priority: 'normal',
      });

      const result = await router.route(webhookMessage);
      expect(result.ok).toBe(true);
    });
  });
});
