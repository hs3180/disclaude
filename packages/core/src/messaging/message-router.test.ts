/**
 * Tests for MessageRouter — Unified routing for all Message types.
 *
 * Verifies routing logic for UserMessage, SystemMessage, and AgentMessage,
 * including project resolution, message queuing, and priority ordering.
 *
 * @see Issue #3331 (Phase 1: Type definition and routing layer)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageRouter,
  type ProjectResolver,
  type RoutableAgentPool,
  type ProjectResolution,
} from './message-router.js';
import {
  type UserMessage,
  type SystemMessage,
  type AgentMessage,
  isUserMessage,
  isSystemMessage,
  isAgentMessage,
  generateMessageId,
  createUserMessage,
  createSystemMessage,
  createAgentMessage,
} from './message-types.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock agent that tracks processMessage calls.
 * Returns an object with processMessage (as vi.fn), taskComplete getter,
 * and a _resolveTask helper for test control.
 */
function createMockAgent() {
  let taskCompleteResolve: (() => void) | undefined;
  let _taskComplete: Promise<void> | undefined;

  const processMessage = vi.fn((_chatId: string, _text: string, _messageId: string) => {
    _taskComplete = new Promise<void>((resolve) => {
      taskCompleteResolve = resolve;
    });
  });

  return {
    processMessage,
    get taskComplete() {
      return _taskComplete;
    },
    _resolveTask() {
      taskCompleteResolve?.();
      taskCompleteResolve = undefined;
    },
  };
}

type MockAgent = ReturnType<typeof createMockAgent>;

/**
 * Create a mock agent pool.
 */
function createMockAgentPool() {
  const agents = new Map<string, MockAgent>();

  const pool: RoutableAgentPool = {
    getOrCreate: vi.fn((chatId: string) => {
      let agent = agents.get(chatId);
      if (!agent) {
        agent = createMockAgent();
        agents.set(chatId, agent);
      }
      return agent;
    }),
    has: vi.fn((chatId: string) => agents.has(chatId)),
  };

  return { pool, agents };
}

/**
 * Create a mock project resolver.
 */
function createMockProjectResolver(
  projects: Record<string, ProjectResolution>
): ProjectResolver {
  return {
    resolve: vi.fn((projectKey: string) => projects[projectKey] ?? null),
  };
}

// ============================================================================
// Message Type Tests
// ============================================================================

describe('Message Types', () => {
  describe('Type Guards', () => {
    it('isUserMessage should return true for UserMessage', () => {
      const msg: UserMessage = {
        id: '1',
        source: 'user',
        payload: 'hello',
        chatId: 'oc_123',
        messageId: 'cli_456',
        createdAt: new Date().toISOString(),
      };
      expect(isUserMessage(msg)).toBe(true);
      expect(isSystemMessage(msg)).toBe(false);
      expect(isAgentMessage(msg)).toBe(false);
    });

    it('isSystemMessage should return true for SystemMessage', () => {
      const msg: SystemMessage = {
        id: '2',
        source: 'system',
        payload: 'scheduled task',
        trigger: 'scheduled',
        createdAt: new Date().toISOString(),
      };
      expect(isSystemMessage(msg)).toBe(true);
      expect(isUserMessage(msg)).toBe(false);
      expect(isAgentMessage(msg)).toBe(false);
    });

    it('isAgentMessage should return true for AgentMessage', () => {
      const msg: AgentMessage = {
        id: '3',
        source: 'agent',
        payload: 'delegated task',
        fromChatId: 'oc_from',
        priority: 'high',
        createdAt: new Date().toISOString(),
      };
      expect(isAgentMessage(msg)).toBe(true);
      expect(isUserMessage(msg)).toBe(false);
      expect(isSystemMessage(msg)).toBe(false);
    });
  });

  describe('Helper Functions', () => {
    it('generateMessageId should produce unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateMessageId());
      }
      expect(ids.size).toBe(100);
    });

    it('generateMessageId should have expected format', () => {
      const id = generateMessageId();
      expect(id).toMatch(/^msg-[a-z0-9]+-[a-z0-9]+$/);
    });

    it('createUserMessage should create a valid UserMessage', () => {
      const msg = createUserMessage({
        chatId: 'oc_123',
        payload: 'Hello world',
        messageId: 'cli_456',
        senderOpenId: 'ou_789',
      });

      expect(msg.source).toBe('user');
      expect(msg.chatId).toBe('oc_123');
      expect(msg.payload).toBe('Hello world');
      expect(msg.messageId).toBe('cli_456');
      expect(msg.senderOpenId).toBe('ou_789');
      expect(msg.id).toMatch(/^msg-/);
      expect(msg.createdAt).toBeTruthy();
    });

    it('createSystemMessage should create a valid SystemMessage', () => {
      const msg = createSystemMessage({
        trigger: 'scheduled',
        payload: 'Daily sync',
        projectKey: 'owner/repo',
        taskName: 'Daily Maintenance',
        modelTier: 'low',
      });

      expect(msg.source).toBe('system');
      expect(msg.trigger).toBe('scheduled');
      expect(msg.payload).toBe('Daily sync');
      expect(msg.projectKey).toBe('owner/repo');
      expect(msg.taskName).toBe('Daily Maintenance');
      expect(msg.modelTier).toBe('low');
    });

    it('createAgentMessage should create a valid AgentMessage', () => {
      const msg = createAgentMessage({
        fromChatId: 'oc_from',
        payload: 'Delegated task',
        projectKey: 'owner/repo',
        priority: 'high',
      });

      expect(msg.source).toBe('agent');
      expect(msg.fromChatId).toBe('oc_from');
      expect(msg.payload).toBe('Delegated task');
      expect(msg.projectKey).toBe('owner/repo');
      expect(msg.priority).toBe('high');
    });

    it('createAgentMessage should default to normal priority', () => {
      const msg = createAgentMessage({
        fromChatId: 'oc_from',
        payload: 'Task',
      });
      expect(msg.priority).toBe('normal');
    });
  });
});

// ============================================================================
// MessageRouter Tests
// ============================================================================

describe('MessageRouter', () => {
  let mockPool: ReturnType<typeof createMockAgentPool>;
  let mockResolver: ProjectResolver;

  beforeEach(() => {
    mockPool = createMockAgentPool();
    mockResolver = createMockProjectResolver({
      'owner/repo': { chatId: 'oc_project_chat', workingDir: '/projects/repo' },
    });
  });

  // ───────────────────────────────────────────
  // UserMessage Routing
  // ───────────────────────────────────────────

  describe('UserMessage routing', () => {
    it('should route UserMessage to agent via chatId from message', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createUserMessage({
        chatId: 'oc_user_chat',
        payload: 'Hello!',
        messageId: 'cli_msg1',
      });

      await router.route(msg);

      const agent = mockPool.agents.get('oc_user_chat');
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_user_chat',
        'Hello!',
        'cli_msg1',
        undefined
      );
    });

    it('should route UserMessage with senderOpenId', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createUserMessage({
        chatId: 'oc_chat',
        payload: 'Hi',
        messageId: 'cli_msg2',
        senderOpenId: 'ou_sender',
      });

      await router.route(msg);

      const agent = mockPool.agents.get('oc_chat');
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_chat',
        'Hi',
        'cli_msg2',
        'ou_sender'
      );
    });

    it('should reuse existing agent for same chatId', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg1 = createUserMessage({
        chatId: 'oc_chat',
        payload: 'First',
        messageId: 'cli_1',
      });
      const msg2 = createUserMessage({
        chatId: 'oc_chat',
        payload: 'Second',
        messageId: 'cli_2',
      });

      await router.route(msg1);
      await router.route(msg2);

      expect(mockPool.agents.size).toBe(1);
      expect(mockPool.pool.getOrCreate).toHaveBeenCalledWith('oc_chat');
    });
  });

  // ───────────────────────────────────────────
  // SystemMessage Routing
  // ───────────────────────────────────────────

  describe('SystemMessage routing', () => {
    it('should route SystemMessage to project-bound agent', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createSystemMessage({
        trigger: 'scheduled',
        payload: 'Daily sync',
        projectKey: 'owner/repo',
        taskName: 'Daily Maintenance',
      });

      await router.route(msg);

      // Should resolve projectKey → oc_project_chat
      const agent = mockPool.agents.get('oc_project_chat');
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_project_chat',
        'Daily sync',
        expect.any(String)
      );
    });

    it('should throw if projectKey not found and no fallback', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createSystemMessage({
        trigger: 'signal',
        payload: 'Webhook event',
        projectKey: 'nonexistent/project',
      });

      await expect(router.route(msg)).rejects.toThrow(
        'no projectKey specified and no fallbackChatId configured'
      );
    });

    it('should fall back to fallbackChatId when projectKey resolves to null', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
        fallbackChatId: 'oc_fallback',
      });

      const msg = createSystemMessage({
        trigger: 'signal',
        payload: 'Webhook event',
        projectKey: 'nonexistent/project',
      });

      await router.route(msg);

      const agent = mockPool.agents.get('oc_fallback');
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_fallback',
        'Webhook event',
        expect.any(String)
      );
    });

    it('should use fallbackChatId when SystemMessage has no projectKey', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
        fallbackChatId: 'oc_fallback',
      });

      const msg = createSystemMessage({
        trigger: 'command',
        payload: 'Admin command',
      });

      await router.route(msg);

      const agent = mockPool.agents.get('oc_fallback');
      expect(agent).toBeDefined();
    });

    it('should throw if no projectKey and no fallbackChatId', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createSystemMessage({
        trigger: 'command',
        payload: 'Admin command',
      });

      await expect(router.route(msg)).rejects.toThrow(
        'no projectKey specified and no fallbackChatId configured'
      );
    });
  });

  // ───────────────────────────────────────────
  // AgentMessage Routing
  // ───────────────────────────────────────────

  describe('AgentMessage routing', () => {
    it('should route AgentMessage to project-bound agent', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createAgentMessage({
        fromChatId: 'oc_requester',
        payload: 'Delegated task',
        projectKey: 'owner/repo',
        priority: 'high',
      });

      await router.route(msg);

      const agent = mockPool.agents.get('oc_project_chat');
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_project_chat',
        'Delegated task',
        expect.any(String)
      );
    });

    it('should throw if AgentMessage has no projectKey', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createAgentMessage({
        fromChatId: 'oc_requester',
        payload: 'Task',
      });

      await expect(router.route(msg)).rejects.toThrow('projectKey is required');
    });

    it('should throw if project not found', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createAgentMessage({
        fromChatId: 'oc_requester',
        payload: 'Task',
        projectKey: 'nonexistent/project',
      });

      await expect(router.route(msg)).rejects.toThrow(
        'project "nonexistent/project" not found'
      );
    });
  });

  // ───────────────────────────────────────────
  // Message Queuing
  // ───────────────────────────────────────────

  describe('Message queuing', () => {
    it('should enqueue when target agent is busy', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      // Create a busy agent with a pending taskComplete
      const mockAgent = createMockAgent();
      mockPool.agents.set('oc_project_chat', mockAgent);

      // Simulate agent being busy by triggering processMessage to create taskComplete
      mockAgent.processMessage('oc_project_chat', 'setup', 'setup-id');
      expect(mockAgent.taskComplete).toBeDefined();

      // First message — agent is already busy from setup
      const msg1 = createSystemMessage({
        trigger: 'scheduled',
        payload: 'First task',
        projectKey: 'owner/repo',
      });

      // Route first message (will enqueue since agent appears busy from setup)
      const routePromise = router.route(msg1);

      // Second message while agent is busy — should be enqueued
      const msg2 = createSystemMessage({
        trigger: 'scheduled',
        payload: 'Second task',
        projectKey: 'owner/repo',
      });

      await router.route(msg2);

      // Second message should be queued
      expect(router.getQueueSize('oc_project_chat')).toBeGreaterThanOrEqual(1);

      await routePromise;
    });

    it('should drain queue when agent finishes', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      // Create a busy agent
      const mockAgent = createMockAgent();
      mockPool.agents.set('oc_project_chat', mockAgent);

      // Simulate agent being busy
      mockAgent.processMessage('oc_project_chat', 'setup', 'setup-id');

      // First message
      const msg1 = createSystemMessage({
        trigger: 'scheduled',
        payload: 'First',
        projectKey: 'owner/repo',
      });

      const routePromise1 = router.route(msg1);

      // Enqueue second message
      const msg2 = createSystemMessage({
        trigger: 'scheduled',
        payload: 'Second',
        projectKey: 'owner/repo',
      });
      await router.route(msg2);

      expect(router.getQueueSize('oc_project_chat')).toBeGreaterThanOrEqual(1);

      // Resolve the first task — should trigger queue drain
      mockAgent._resolveTask();
      await routePromise1;

      // Give microtasks a chance to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Queue should be drained
      expect(router.getQueueSize('oc_project_chat')).toBe(0);
    });

    it('should order queued messages by priority', () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      // Use enqueue method to add messages with different priorities
      const lowMsg = createAgentMessage({
        fromChatId: 'oc_1',
        payload: 'Low priority',
        projectKey: 'owner/repo',
        priority: 'low',
      });

      const highMsg = createAgentMessage({
        fromChatId: 'oc_2',
        payload: 'High priority',
        projectKey: 'owner/repo',
        priority: 'high',
      });

      const normalMsg = createAgentMessage({
        fromChatId: 'oc_3',
        payload: 'Normal priority',
        projectKey: 'owner/repo',
        priority: 'normal',
      });

      // Enqueue in low → high → normal order
      router.enqueue('owner/repo', lowMsg);
      router.enqueue('owner/repo', highMsg);
      router.enqueue('owner/repo', normalMsg);

      // Verify queue has all 3 messages
      expect(router.getQueueSize('oc_project_chat')).toBe(3);

      // Verify ordering via getQueuedChatIds
      expect(router.getQueuedChatIds()).toContain('oc_project_chat');
    });

    it('enqueue should skip if project not found', () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createAgentMessage({
        fromChatId: 'oc_1',
        payload: 'Task',
        projectKey: 'nonexistent/project',
        priority: 'high',
      });

      // Should not throw — just skip silently
      router.enqueue('nonexistent/project', msg);

      expect(router.getQueueSize('oc_project_chat')).toBe(0);
    });
  });

  // ───────────────────────────────────────────
  // No ProjectResolver configured
  // ───────────────────────────────────────────

  describe('without ProjectResolver', () => {
    it('should still route UserMessage', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
      });

      const msg = createUserMessage({
        chatId: 'oc_chat',
        payload: 'Hello!',
        messageId: 'cli_1',
      });

      await router.route(msg);

      const agent = mockPool.agents.get('oc_chat');
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalled();
    });

    it('should fail to route SystemMessage with projectKey when no resolver', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
      });

      const msg = createSystemMessage({
        trigger: 'scheduled',
        payload: 'Task',
        projectKey: 'owner/repo',
      });

      // Should fall through to no-fallback error since resolver returns null
      await expect(router.route(msg)).rejects.toThrow();
    });
  });

  // ───────────────────────────────────────────
  // Edge Cases
  // ───────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty payload', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: mockResolver,
      });

      const msg = createUserMessage({
        chatId: 'oc_chat',
        payload: '',
        messageId: 'cli_1',
      });

      await router.route(msg);

      const agent = mockPool.agents.get('oc_chat');
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_chat',
        '',
        'cli_1',
        undefined
      );
    });

    it('should handle concurrent messages to different chatIds', async () => {
      const router = new MessageRouter({
        agentPool: mockPool.pool,
        projectResolver: createMockProjectResolver({
          'owner/repo1': { chatId: 'oc_chat1', workingDir: '/repo1' },
          'owner/repo2': { chatId: 'oc_chat2', workingDir: '/repo2' },
        }),
      });

      const msg1 = createSystemMessage({
        trigger: 'scheduled',
        payload: 'Task 1',
        projectKey: 'owner/repo1',
      });
      const msg2 = createSystemMessage({
        trigger: 'scheduled',
        payload: 'Task 2',
        projectKey: 'owner/repo2',
      });

      await Promise.all([router.route(msg1), router.route(msg2)]);

      expect(mockPool.agents.has('oc_chat1')).toBe(true);
      expect(mockPool.agents.has('oc_chat2')).toBe(true);
    });
  });
});
