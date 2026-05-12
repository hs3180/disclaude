/**
 * Tests for NonUserMessageRouter.
 *
 * Verifies:
 * - Routing with project binding found/not found
 * - Message queuing when agent is busy
 * - Priority ordering in queue processing
 * - Error handling (delivery failure, notifier callback)
 * - Queue management (size, clear, chatId listing)
 * - Multi-project independent routing
 *
 * Issue #3331: NonUserMessage type definition and routing layer.
 * Issue #3333: Scheduler integration with NonUserMessage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NonUserMessageRouter, type AgentFactoryFn } from './non-user-message-router.js';
import type {
  NonUserMessage,
  ProjectLookupFn,
} from '../types/non-user-message.js';
import type { ChatAgent } from '../agents/types.js';
import type { SchedulerCallbacks } from '../scheduling/scheduler.js';

function createMockMessage(overrides?: Partial<NonUserMessage>): NonUserMessage {
  return {
    id: 'msg-1',
    type: 'scheduled',
    source: 'scheduler:Test Task',
    projectKey: 'test/project',
    payload: 'Test prompt',
    priority: 'normal',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('NonUserMessageRouter', () => {
  let mockAgent: ChatAgent;
  let mockAgentFactory: AgentFactoryFn;
  let mockProjectLookup: ProjectLookupFn;
  let mockCallbacks: SchedulerCallbacks;

  beforeEach(() => {
    mockAgent = {
      type: 'chat',
      name: 'test-agent',
      start: vi.fn().mockResolvedValue(undefined),
      handleInput: vi.fn(),
      processMessage: vi.fn().mockResolvedValue(undefined),
      taskComplete: Promise.resolve(),
      runOnce: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
      stop: vi.fn().mockReturnValue(false),
      dispose: vi.fn(),
    } as unknown as ChatAgent;

    mockAgentFactory = vi.fn().mockReturnValue(mockAgent);
    mockProjectLookup = vi.fn().mockResolvedValue({
      chatId: 'chat-1',
      workingDir: '/tmp/test-project',
    });
    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  function createRouter(overrides?: { onError?: any }) {
    return new NonUserMessageRouter({
      projectLookup: mockProjectLookup,
      agentFactory: mockAgentFactory,
      callbacks: mockCallbacks,
      ...overrides,
    });
  }

  describe('basic routing', () => {
    it('should route message when project binding is found', async () => {
      const router = createRouter();
      const result = await router.route(createMockMessage());

      expect(result.routed).toBe(true);
      expect(result.chatId).toBe('chat-1');
    });

    it('should return error when project binding is not found', async () => {
      vi.mocked(mockProjectLookup).mockResolvedValue(undefined);
      const router = createRouter();
      const result = await router.route(createMockMessage());

      expect(result.routed).toBe(false);
      expect(result.error).toContain('No project binding found');
    });

    it('should return error when project lookup throws', async () => {
      vi.mocked(mockProjectLookup).mockRejectedValue(new Error('DB error'));
      const router = createRouter();
      const result = await router.route(createMockMessage());

      expect(result.routed).toBe(false);
      expect(result.error).toBe('DB error');
    });

    it('should deliver message to agent via runOnce', async () => {
      const router = createRouter();
      await router.route(createMockMessage());

      // Wait for async delivery
      await vi.waitFor(() => {
        expect(mockAgentFactory).toHaveBeenCalledWith('chat-1', mockCallbacks);
        expect(mockAgent.runOnce).toHaveBeenCalledTimes(1);
      });

      const [[chatId, payload, messageId]] = vi.mocked(mockAgent.runOnce).mock.calls;
      expect(chatId).toBe('chat-1');
      expect(payload).toBe('Test prompt');
      expect(messageId).toBe('system:msg-1');
    });

    it('should support async project lookup', async () => {
      vi.mocked(mockProjectLookup).mockImplementation(async (_key) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { chatId: 'chat-async', workingDir: '/tmp/async' };
      });

      const router = createRouter();
      const result = await router.route(createMockMessage());

      expect(result.routed).toBe(true);
      expect(result.chatId).toBe('chat-async');
    });
  });

  describe('message queuing', () => {
    it('should enqueue message when agent is busy', async () => {
      // Make runOnce take time
      const resolvers: Array<() => void> = [];
      vi.mocked(mockAgent.runOnce).mockImplementation(
        () => new Promise<void>(resolve => { resolvers.push(resolve); })
      );

      const router = createRouter();

      // First message starts delivery
      const result1 = await router.route(createMockMessage({ id: 'msg-1' }));
      expect(result1.routed).toBe(true);

      // Second message should be enqueued (agent busy)
      const result2 = await router.route(createMockMessage({ id: 'msg-2' }));
      expect(result2.routed).toBe(true);
      expect(router.getQueueSize('chat-1')).toBe(1);

      // Complete first delivery
      resolvers[0]!();

      // Wait for second delivery to start, then resolve it
      await vi.waitFor(() => { expect(resolvers.length).toBeGreaterThanOrEqual(2); });
      resolvers[1]!();

      // Wait for queue to drain
      await vi.waitFor(() => {
        expect(router.getQueueSize('chat-1')).toBe(0);
      });
    });

    it('should process queued messages in priority order', async () => {
      const resolvers: Array<() => void> = [];
      vi.mocked(mockAgent.runOnce).mockImplementation(
        () => new Promise<void>(resolve => { resolvers.push(resolve); })
      );

      const router = createRouter();

      // Start with a blocking message
      await router.route(createMockMessage({ id: 'blocker' }));

      // Enqueue low, then high priority messages
      await router.route(createMockMessage({ id: 'low-1', priority: 'low' }));
      await router.route(createMockMessage({ id: 'high-1', priority: 'high' }));

      expect(router.getQueueSize('chat-1')).toBe(2);

      // Release the blocker
      resolvers[0]!();

      // Wait for high-priority to start, then resolve it
      await vi.waitFor(() => { expect(resolvers.length).toBeGreaterThanOrEqual(2); });
      resolvers[1]!();

      // Wait for low-priority to start, then resolve it
      await vi.waitFor(() => { expect(resolvers.length).toBeGreaterThanOrEqual(3); });
      resolvers[2]!();

      // Wait for queue to drain
      await vi.waitFor(() => {
        expect(router.getQueueSize('chat-1')).toBe(0);
      });

      // Check order: blocker, then high-1, then low-1
      const { calls } = vi.mocked(mockAgent.runOnce).mock;
      expect(calls.length).toBe(3);

      const call1 = calls[1] as [string, string, string];
      expect(call1[2]).toBe('system:high-1');

      const call2 = calls[2] as [string, string, string];
      expect(call2[2]).toBe('system:low-1');
    });
  });

  describe('error handling', () => {
    it('should call onError notifier when delivery fails', async () => {
      vi.mocked(mockAgent.runOnce).mockRejectedValue(new Error('Agent crashed'));
      const onError = vi.fn().mockResolvedValue(undefined);

      const router = createRouter({ onError });
      await router.route(createMockMessage());

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
      });

      const [msg, error] = onError.mock.calls[0] as [NonUserMessage, string];
      expect(msg.id).toBe('msg-1');
      expect(error).toBe('Agent crashed');
    });

    it('should call onError when project lookup fails', async () => {
      vi.mocked(mockProjectLookup).mockRejectedValue(new Error('Lookup failed'));
      const onError = vi.fn().mockResolvedValue(undefined);

      const router = createRouter({ onError });
      await router.route(createMockMessage());

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'msg-1' }),
        'Lookup failed',
      );
    });

    it('should not crash when onError itself fails', async () => {
      vi.mocked(mockProjectLookup).mockRejectedValue(new Error('Lookup failed'));
      const onError = vi.fn().mockRejectedValue(new Error('Notifier broken'));

      const router = createRouter({ onError });
      const result = await router.route(createMockMessage());

      expect(result.routed).toBe(false);
      // Should not throw
    });
  });

  describe('queue management', () => {
    it('should report queue size correctly', async () => {
      const resolvers: Array<() => void> = [];
      vi.mocked(mockAgent.runOnce).mockImplementation(
        () => new Promise<void>(resolve => { resolvers.push(resolve); })
      );

      const router = createRouter();
      await router.route(createMockMessage({ id: 'blocker' }));
      await router.route(createMockMessage({ id: 'queued-1' }));
      await router.route(createMockMessage({ id: 'queued-2' }));

      expect(router.getQueueSize('chat-1')).toBe(2);
      expect(router.getQueueSize('chat-unknown')).toBe(0);

      // Resolve all deliveries sequentially
      resolvers[0]!();
      await vi.waitFor(() => { expect(resolvers.length).toBeGreaterThanOrEqual(2); });
      resolvers[1]!();
      await vi.waitFor(() => { expect(resolvers.length).toBeGreaterThanOrEqual(3); });
      resolvers[2]!();
      await vi.waitFor(() => {
        expect(router.getQueueSize('chat-1')).toBe(0);
      });
    });

    it('should clear queue for a chatId', async () => {
      let resolveRunOnce: () => void;
      vi.mocked(mockAgent.runOnce).mockImplementation(
        () => new Promise<void>(resolve => { resolveRunOnce = resolve; })
      );

      const router = createRouter();
      await router.route(createMockMessage({ id: 'blocker' }));
      await router.route(createMockMessage({ id: 'queued-1' }));

      expect(router.getQueueSize('chat-1')).toBe(1);
      router.clearQueue('chat-1');
      expect(router.getQueueSize('chat-1')).toBe(0);

      resolveRunOnce!();
    });

    it('should list chatIds with active queues', async () => {
      let resolveRunOnce: () => void;
      vi.mocked(mockAgent.runOnce).mockImplementation(
        () => new Promise<void>(resolve => { resolveRunOnce = resolve; })
      );

      const router = createRouter();
      await router.route(createMockMessage({ id: 'blocker' }));
      await router.route(createMockMessage({ id: 'queued-1' }));

      const queuedChatIds = router.getQueuedChatIds();
      expect(queuedChatIds).toContain('chat-1');

      resolveRunOnce!();
    });
  });

  describe('multi-project routing', () => {
    it('should route messages to different projects independently', async () => {
      let resolveProject1: () => void;
      vi.mocked(mockAgent.runOnce).mockImplementation(
        (chatId) => {
          if (chatId === 'chat-1') {
            return new Promise<void>(resolve => { resolveProject1 = resolve; });
          }
          return Promise.resolve();
        }
      );

      vi.mocked(mockProjectLookup).mockImplementation(async (key) => {
        await Promise.resolve();
        if (key === 'project-1') { return { chatId: 'chat-1', workingDir: '/tmp/p1' }; }
        if (key === 'project-2') { return { chatId: 'chat-2', workingDir: '/tmp/p2' }; }
        return undefined;
      });

      const router = createRouter();

      // Route to project-1 (will be busy)
      await router.route(createMockMessage({ id: 'p1-msg1', projectKey: 'project-1' }));

      // Route to project-2 (should not be blocked by project-1)
      const result2 = await router.route(createMockMessage({ id: 'p2-msg1', projectKey: 'project-2' }));
      expect(result2.routed).toBe(true);
      expect(result2.chatId).toBe('chat-2');

      // Enqueue another for project-1
      await router.route(createMockMessage({ id: 'p1-msg2', projectKey: 'project-1' }));
      expect(router.getQueueSize('chat-1')).toBe(1);

      // Release project-1
      resolveProject1!();
      await vi.waitFor(() => {
        expect(router.getQueueSize('chat-1')).toBe(0);
      });
    });
  });
});
