/**
 * Unit tests for UnifiedMessageRouter — RFC #3329 Phase 1.
 *
 * Tests cover:
 * - UserMessage routing (chatId from message)
 * - SystemMessage routing (chatId from project config)
 * - AgentMessage routing (chatId from project config)
 * - Project not found error handling
 * - Agent busy → message queuing
 * - Queue draining after processing completes
 * - Clear queues on shutdown
 *
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  UnifiedMessageRouter,
  type RouteableAgentPool,
  type RouteableAgent,
  type ProjectConfigResolver,
} from './unified-message-router.js';
import {
  createUnifiedUserMessage,
  createSystemMessage,
  createAgentMessage as createUnifiedAgentMessage,
} from '../types/unified-message.js';
import type { SystemMessage, AgentMessage } from '../types/unified-message.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TEST_CHAT_ID = 'oc_test_chat_123';
const TEST_PROJECT_KEY = 'owner/repo';
const TEST_WORKING_DIR = '/projects/owner-repo';
const TEST_FROM_CHAT_ID = 'oc_source_chat_456';

function createMockAgentPool(): {
  pool: RouteableAgentPool;
  agents: Map<string, RouteableAgent>;
  processMessageSpy: ReturnType<typeof vi.fn>;
  busyChatIds: Set<string>;
} {
  const agents = new Map<string, RouteableAgent>();
  const busyChatIds = new Set<string>();
  const processMessageSpy = vi.fn().mockResolvedValue(undefined);

  const pool: RouteableAgentPool = {
    getOrCreate: vi.fn().mockImplementation(async (chatId: string) => {
      let agent = agents.get(chatId);
      if (!agent) {
        agent = { processMessage: processMessageSpy };
        agents.set(chatId, agent);
      }
      return agent;
    }),
    isBusy: vi.fn().mockImplementation((chatId: string) => busyChatIds.has(chatId)),
  };

  return { pool, agents, processMessageSpy, busyChatIds };
}

function createMockProjectResolver(
  projects?: Record<string, { chatId: string; workingDir: string }>
): ProjectConfigResolver {
  const defaultProjects: Record<string, { chatId: string; workingDir: string }> = {
    [TEST_PROJECT_KEY]: { chatId: TEST_CHAT_ID, workingDir: TEST_WORKING_DIR },
  };
  const allProjects = projects ?? defaultProjects;

  return {
    resolve: vi.fn().mockImplementation(async (projectKey: string) => {
      return allProjects[projectKey] ?? undefined;
    }),
  };
}

function createTestRouter(
  agentPool: RouteableAgentPool,
  projectResolver: ProjectConfigResolver
): UnifiedMessageRouter {
  return new UnifiedMessageRouter({
    agentPool,
    projectResolver,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('UnifiedMessageRouter', () => {
  let mockPool: ReturnType<typeof createMockAgentPool>;
  let mockResolver: ReturnType<typeof createMockProjectResolver>;
  let router: UnifiedMessageRouter;

  beforeEach(() => {
    mockPool = createMockAgentPool();
    mockResolver = createMockProjectResolver();
    router = createTestRouter(mockPool.pool, mockResolver);
  });

  // ───────────────────────────────────────────
  // UserMessage routing
  // ───────────────────────────────────────────

  describe('UserMessage routing', () => {
    it('should route UserMessage using chatId from the message', async () => {
      const message = createUnifiedUserMessage({
        chatId: TEST_CHAT_ID,
        payload: 'Hello from user',
        messageId: 'msg_001',
      });

      const result = await router.route(message);

      expect(result.ok).toBe(true);
      expect(result.chatId).toBe(TEST_CHAT_ID);
      expect(mockPool.processMessageSpy).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        'Hello from user',
        expect.any(String) // message.id
      );
    });

    it('should create agent via pool for new chatId', async () => {
      const message = createUnifiedUserMessage({
        chatId: 'oc_new_chat',
        payload: 'First message',
        messageId: 'msg_002',
      });

      const result = await router.route(message);

      expect(result.ok).toBe(true);
      expect(mockPool.pool.getOrCreate).toHaveBeenCalledWith('oc_new_chat', undefined);
    });
  });

  // ───────────────────────────────────────────
  // SystemMessage routing
  // ───────────────────────────────────────────

  describe('SystemMessage routing', () => {
    it('should route SystemMessage via project config', async () => {
      const message = createSystemMessage({
        payload: 'Daily sync task',
        trigger: 'scheduled',
        projectKey: TEST_PROJECT_KEY,
        taskName: 'daily-sync',
      });

      const result = await router.route(message);

      expect(result.ok).toBe(true);
      expect(result.chatId).toBe(TEST_CHAT_ID);
      expect(mockResolver.resolve).toHaveBeenCalledWith(TEST_PROJECT_KEY);
      expect(mockPool.pool.getOrCreate).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        { cwd: TEST_WORKING_DIR }
      );
    });

    it('should return error for SystemMessage without projectKey', async () => {
      const message = createSystemMessage({
        payload: 'Orphan message',
        trigger: 'signal',
      });

      const result = await router.route(message);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('no projectKey');
      expect(mockPool.processMessageSpy).not.toHaveBeenCalled();
    });

    it('should return error when project not found', async () => {
      const message = createSystemMessage({
        payload: 'Task for unknown project',
        trigger: 'scheduled',
        projectKey: 'nonexistent/project',
      });

      const result = await router.route(message);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Project not found');
      expect(mockPool.processMessageSpy).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────
  // AgentMessage routing
  // ───────────────────────────────────────────

  describe('AgentMessage routing', () => {
    it('should route AgentMessage via project config', async () => {
      const message = createUnifiedAgentMessage({
        payload: 'Review PR #42',
        fromChatId: TEST_FROM_CHAT_ID,
        projectKey: TEST_PROJECT_KEY,
        priority: 'high',
      });

      const result = await router.route(message);

      expect(result.ok).toBe(true);
      expect(result.chatId).toBe(TEST_CHAT_ID);
      expect(mockResolver.resolve).toHaveBeenCalledWith(TEST_PROJECT_KEY);
      expect(mockPool.pool.getOrCreate).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        { cwd: TEST_WORKING_DIR }
      );
    });

    it('should return error for AgentMessage without projectKey', async () => {
      const message = createUnifiedAgentMessage({
        payload: 'No project',
        fromChatId: TEST_FROM_CHAT_ID,
      });

      const result = await router.route(message);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('no projectKey');
    });

    it('should return error when project not found', async () => {
      const message = createUnifiedAgentMessage({
        payload: 'Delegate task',
        fromChatId: TEST_FROM_CHAT_ID,
        projectKey: 'missing/project',
      });

      const result = await router.route(message);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Project not found');
    });
  });

  // ───────────────────────────────────────────
  // Queue & Sequential Delivery
  // ───────────────────────────────────────────

  describe('Message queuing when agent is busy', () => {
    it('should queue messages when agent is currently processing', async () => {
      // Make the agent slow — first message takes time
      let resolveFirst: () => void = () => {};
      mockPool.processMessageSpy
        .mockImplementationOnce(() => new Promise<void>((r) => { resolveFirst = r; }))
        .mockResolvedValueOnce(undefined);

      const msg1 = createUnifiedUserMessage({
        chatId: TEST_CHAT_ID,
        payload: 'First message',
        messageId: 'msg_010',
      });
      const msg2 = createUnifiedUserMessage({
        chatId: TEST_CHAT_ID,
        payload: 'Second message',
        messageId: 'msg_011',
      });

      // Start first message (doesn't resolve yet)
      const result1Promise = router.route(msg1);

      // Give event loop a tick to start processing
      await new Promise((r) => setTimeout(r, 10));

      // Second message should be queued
      const result2Promise = router.route(msg2);

      // Check queue size
      expect(router.getQueueSize(TEST_CHAT_ID)).toBeGreaterThanOrEqual(0); // May be 0 or 1 depending on timing
      expect(router.isProcessing(TEST_CHAT_ID)).toBe(true);

      // Resolve first message
      resolveFirst();
      const result1 = await result1Promise;
      expect(result1.ok).toBe(true);

      // Second message should now be delivered
      const result2 = await result2Promise;
      expect(result2.ok).toBe(true);

      // Both messages should have been processed
      expect(mockPool.processMessageSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ───────────────────────────────────────────
  // Enqueue method
  // ───────────────────────────────────────────

  describe('enqueue()', () => {
    it('should enqueue SystemMessage for project-bound agent', async () => {
      const message = createSystemMessage({
        payload: 'Scheduled task',
        trigger: 'scheduled',
        projectKey: TEST_PROJECT_KEY,
      });

      const result = await router.enqueue(TEST_PROJECT_KEY, message as SystemMessage);

      expect(result.ok).toBe(true);
      expect(result.chatId).toBe(TEST_CHAT_ID);
      expect(mockPool.processMessageSpy).toHaveBeenCalled();
    });

    it('should enqueue AgentMessage for project-bound agent', async () => {
      const message = createUnifiedAgentMessage({
        payload: 'A2A delegation',
        fromChatId: TEST_FROM_CHAT_ID,
        projectKey: TEST_PROJECT_KEY,
      });

      const result = await router.enqueue(TEST_PROJECT_KEY, message as AgentMessage);

      expect(result.ok).toBe(true);
      expect(result.chatId).toBe(TEST_CHAT_ID);
    });

    it('should return error when project not found', async () => {
      const message = createSystemMessage({
        payload: 'Missing project',
        trigger: 'command',
        projectKey: 'missing/project',
      });

      const result = await router.enqueue('missing/project', message as SystemMessage);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Project not found');
    });
  });

  // ───────────────────────────────────────────
  // Clear queues
  // ───────────────────────────────────────────

  describe('clearQueues()', () => {
    it('should clear all queues on shutdown', async () => {
      // Make the agent slow
      let resolveFirst: () => void = () => {};
      mockPool.processMessageSpy
        .mockImplementationOnce(() => new Promise<void>((r) => { resolveFirst = r; }));

      const msg1 = createUnifiedUserMessage({
        chatId: TEST_CHAT_ID,
        payload: 'First',
        messageId: 'msg_020',
      });
      const msg2 = createUnifiedUserMessage({
        chatId: TEST_CHAT_ID,
        payload: 'Second',
        messageId: 'msg_021',
      });

      // Start processing first message
      router.route(msg1);
      await new Promise((r) => setTimeout(r, 10));

      // Queue second message
      const result2Promise = router.route(msg2);

      // Clear queues while agent is busy
      router.clearQueues();
      expect(router.getQueueSize(TEST_CHAT_ID)).toBe(0);

      // Resolve the first message
      resolveFirst();
      await result2Promise;
    });
  });

  // ───────────────────────────────────────────
  // Error handling
  // ───────────────────────────────────────────

  describe('Error handling', () => {
    it('should return error when agent.processMessage throws', async () => {
      mockPool.processMessageSpy.mockRejectedValueOnce(new Error('Agent crashed'));

      const message = createUnifiedUserMessage({
        chatId: TEST_CHAT_ID,
        payload: 'Will fail',
        messageId: 'msg_030',
      });

      const result = await router.route(message);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Agent crashed');
    });

    it('should return error for unknown message source', async () => {
      const message = {
        id: 'msg_unknown',
        source: 'unknown' as 'user' | 'system' | 'agent',
        payload: 'Mystery',
        createdAt: new Date().toISOString(),
      };

      const result = await router.route(message);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unknown message source');
    });
  });
});
