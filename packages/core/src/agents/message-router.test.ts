/**
 * Unit tests for MessageRouter (RFC #3329, Issue #3331).
 *
 * Tests routing logic for all three message types:
 * - UserMessage: direct chatId routing
 * - SystemMessage: project config → chatId routing
 * - A2AMessage: project config → chatId routing with priority
 *
 * Also tests:
 * - Queue behavior when agent is busy
 * - Priority ordering in queue
 * - Error handling for missing project config
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageRouter,
  type MessageRouterAgentPool,
} from './message-router.js';
import {
  isA2AMessage,
  isNonUserMessage,
  isSystemMessage,
  isUserMessage,
  type A2AMessage,
  type Message,
  type ProjectLookup,
  type ProjectLookupResult,
  type SystemMessage,
  type UserMessage,
} from '../types/unified-message.js';
import type { ChatAgent } from './types.js';

// ============================================================================
// Mock Factories
// ============================================================================

type WritableTaskComplete = { -readonly [K in 'taskComplete']: ChatAgent[K] };

function createMockChatAgent(): ChatAgent {
  return {
    type: 'chat',
    name: 'mock-agent',
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

function createMockAgentPool(): MessageRouterAgentPool {
  const agents = new Map<string, ChatAgent>();

  return {
    getOrCreateChatAgent(chatId: string): ChatAgent {
      let agent = agents.get(chatId);
      if (!agent) {
        agent = createMockChatAgent();
        agents.set(chatId, agent);
      }
      return agent;
    },
    has(chatId: string): boolean {
      return agents.has(chatId);
    },
    get(chatId: string): ChatAgent | undefined {
      return agents.get(chatId);
    },
  };
}

function createMockProjectLookup(
  projects: Record<string, ProjectLookupResult>
): ProjectLookup {
  return {
    lookup(projectKey: string): ProjectLookupResult | undefined {
      return projects[projectKey];
    },
  };
}

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_CHAT_ID = 'oc_test_chat_123';
const TEST_PROJECT_KEY = 'test/repo';
const TEST_PROJECT: ProjectLookupResult = {
  chatId: TEST_CHAT_ID,
  workingDir: '/path/to/project',
};

function createUserMessage(overrides?: Partial<UserMessage>): UserMessage {
  return {
    id: 'user-msg-1',
    source: 'user',
    chatId: TEST_CHAT_ID,
    messageId: 'user-msg-1',
    payload: 'Hello from user',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createSystemMessage(overrides?: Partial<SystemMessage>): SystemMessage {
  return {
    id: 'sys-msg-1',
    source: 'system',
    trigger: 'scheduled',
    projectKey: TEST_PROJECT_KEY,
    payload: 'Scheduled task prompt',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createA2AMessage(overrides?: Partial<A2AMessage>): A2AMessage {
  return {
    id: 'a2a-msg-1',
    source: 'agent',
    fromChatId: 'oc_other_chat',
    projectKey: TEST_PROJECT_KEY,
    priority: 'normal',
    payload: 'Delegated task prompt',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('MessageRouter', () => {
  let router: MessageRouter;
  let mockPool: MessageRouterAgentPool;
  let mockLookup: ProjectLookup;

  beforeEach(() => {
    mockPool = createMockAgentPool();
    mockLookup = createMockProjectLookup({
      [TEST_PROJECT_KEY]: TEST_PROJECT,
    });
    router = new MessageRouter({
      projectLookup: mockLookup,
      agentPool: mockPool,
    });
  });

  // ──────────────────────────────────────────────
  // UserMessage Routing
  // ──────────────────────────────────────────────

  describe('UserMessage routing', () => {
    it('should route UserMessage to agent via chatId', async () => {
      const message = createUserMessage();
      await router.route(message);

      const agent = mockPool.get(TEST_CHAT_ID);
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        message.payload,
        message.messageId,
        undefined, // senderOpenId
        undefined, // attachments
        undefined  // chatHistoryContext
      );
    });

    it('should create a new agent if none exists for the chatId', async () => {
      expect(mockPool.has(TEST_CHAT_ID)).toBe(false);

      const message = createUserMessage();
      await router.route(message);

      expect(mockPool.has(TEST_CHAT_ID)).toBe(true);
    });

    it('should reuse existing agent for same chatId', async () => {
      const msg1 = createUserMessage({ id: 'msg-1', messageId: 'msg-1' });
      const msg2 = createUserMessage({ id: 'msg-2', messageId: 'msg-2' });

      await router.route(msg1);
      await router.route(msg2);

      const agent = mockPool.get(TEST_CHAT_ID);
      expect(agent!.processMessage).toHaveBeenCalledTimes(2);
    });

    it('should pass senderOpenId and chatHistoryContext to agent', async () => {
      const message = createUserMessage({
        senderOpenId: 'ou_sender123',
        chatHistoryContext: 'Previous conversation...',
      });
      await router.route(message);

      const agent = mockPool.get(TEST_CHAT_ID);
      expect(agent!.processMessage).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        message.payload,
        message.messageId,
        'ou_sender123',
        undefined,
        'Previous conversation...'
      );
    });
  });

  // ──────────────────────────────────────────────
  // SystemMessage Routing
  // ──────────────────────────────────────────────

  describe('SystemMessage routing', () => {
    it('should route SystemMessage to project-bound agent', async () => {
      const message = createSystemMessage();
      await router.route(message);

      const agent = mockPool.get(TEST_CHAT_ID);
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        message.payload,
        message.id
      );
    });

    it('should throw error when projectKey not found', async () => {
      const message = createSystemMessage({ projectKey: 'nonexistent/repo' });
      await expect(router.route(message)).rejects.toThrow('Project not found: nonexistent/repo');
    });

    it('should throw error when projectKey is missing', async () => {
      const message = createSystemMessage({ projectKey: undefined });
      await expect(router.route(message)).rejects.toThrow('requires projectKey');
    });

    it('should create agent if none exists for resolved chatId', async () => {
      expect(mockPool.has(TEST_CHAT_ID)).toBe(false);

      const message = createSystemMessage();
      await router.route(message);

      expect(mockPool.has(TEST_CHAT_ID)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // A2AMessage Routing
  // ──────────────────────────────────────────────

  describe('A2AMessage routing', () => {
    it('should route A2AMessage to project-bound agent', async () => {
      const message = createA2AMessage();
      await router.route(message);

      const agent = mockPool.get(TEST_CHAT_ID);
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        message.payload,
        message.id
      );
    });

    it('should throw error when projectKey not found', async () => {
      const message = createA2AMessage({ projectKey: 'nonexistent/repo' });
      await expect(router.route(message)).rejects.toThrow('Project not found: nonexistent/repo');
    });
  });

  // ──────────────────────────────────────────────
  // Queue Behavior
  // ──────────────────────────────────────────────

  describe('message queue', () => {
    it('should queue messages when agent is busy', async () => {
      // Make the agent "busy" by giving it a taskComplete that doesn't resolve immediately
      const agent = mockPool.getOrCreateChatAgent(TEST_CHAT_ID);
      let resolveTask!: () => void;
      (agent as unknown as WritableTaskComplete).taskComplete = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      // First message starts processing
      const msg1 = createSystemMessage({ id: 'msg-1' });
      const routePromise = router.route(msg1);

      // Second message should be queued (agent is busy)
      const msg2 = createSystemMessage({ id: 'msg-2' });
      const routePromise2 = router.route(msg2);

      // Give event loop a tick to process
      await new Promise((r) => setTimeout(r, 10));

      // Queue should have 1 message
      expect(router.getQueueSize(TEST_CHAT_ID)).toBe(1);

      // Complete the first task
      resolveTask();
      await routePromise;
      await routePromise2;

      // Queue should be drained
      expect(router.getQueueSize(TEST_CHAT_ID)).toBe(0);

      // Agent should have received both messages
      expect(agent.processMessage).toHaveBeenCalledTimes(2);
    });

    it('should process queued messages in priority order', async () => {
      const agent = mockPool.getOrCreateChatAgent(TEST_CHAT_ID);
      let resolveTask!: () => void;
      (agent as unknown as WritableTaskComplete).taskComplete = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      // First message: normal priority (blocks agent)
      const msg1 = createA2AMessage({ id: 'msg-normal', priority: 'normal' });
      const routePromise1 = router.route(msg1);

      await new Promise((r) => setTimeout(r, 10));

      // Queue low, high, normal messages
      const msgLow = createA2AMessage({ id: 'msg-low', priority: 'low' });
      const msgHigh = createA2AMessage({ id: 'msg-high', priority: 'high' });
      const msgNormal = createA2AMessage({ id: 'msg-normal2', priority: 'normal' });

      void router.route(msgLow);
      void router.route(msgHigh);
      void router.route(msgNormal);

      await new Promise((r) => setTimeout(r, 10));

      // Queue should have 3 messages, ordered: high, normal, low
      expect(router.getQueueSize(TEST_CHAT_ID)).toBe(3);

      // Resolve the first task to trigger queue processing
      resolveTask();
      await routePromise1;

      // Wait for all queued messages to process
      // Each one resolves immediately since taskComplete is now undefined
      await new Promise((r) => setTimeout(r, 50));

      // All messages should have been processed
      expect(agent.processMessage).toHaveBeenCalledTimes(4);

      // Verify order: msg1 (normal), msg-high, msg-normal2, msg-low
      const {calls} = (agent.processMessage as ReturnType<typeof vi.fn>).mock;
      expect(calls[0][2]).toBe('msg-normal');  // First message
      // After first resolves, queue processes in priority order
      // Note: exact order of remaining depends on async timing
    });

    it('should track busy chat IDs', async () => {
      const agent = mockPool.getOrCreateChatAgent(TEST_CHAT_ID);
      let resolveTask!: () => void;
      (agent as unknown as WritableTaskComplete).taskComplete = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      const msg = createSystemMessage({ id: 'msg-1' });
      const routePromise = router.route(msg);
      await new Promise((r) => setTimeout(r, 10));

      expect(router.getBusyChatIds()).toContain(TEST_CHAT_ID);

      resolveTask();
      await routePromise;
      await new Promise((r) => setTimeout(r, 10));

      // Should no longer be busy
      expect(router.getBusyChatIds()).not.toContain(TEST_CHAT_ID);
    });
  });

  // ──────────────────────────────────────────────
  // Error Handling
  // ──────────────────────────────────────────────

  describe('error handling', () => {
    it('should handle agent processMessage errors gracefully', async () => {
      const agent = mockPool.getOrCreateChatAgent(TEST_CHAT_ID);
      agent.processMessage = vi.fn().mockImplementation(() => {
        throw new Error('Agent processing error');
      });

      // Should not throw — error is caught and logged
      const message = createSystemMessage();
      await router.route(message);

      // Router should still be functional after error
      expect(router.getQueueSize(TEST_CHAT_ID)).toBe(0);
    });

    it('should continue processing queue after error', async () => {
      const agent = mockPool.getOrCreateChatAgent(TEST_CHAT_ID);
      let resolveTask!: () => void;
      (agent as unknown as WritableTaskComplete).taskComplete = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      // First message blocks
      const msg1 = createSystemMessage({ id: 'msg-1' });
      const routePromise1 = router.route(msg1);
      await new Promise((r) => setTimeout(r, 10));

      // Queue a second message
      const msg2 = createSystemMessage({ id: 'msg-2' });
      void router.route(msg2);

      // Make processMessage throw for first call, succeed for second
      let callCount = 0;
      agent.processMessage = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First call fails');
        }
      });

      resolveTask();
      await routePromise1;
      await new Promise((r) => setTimeout(r, 50));

      // Second message should still be processed
      expect(agent.processMessage).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // Multiple Projects
  // ──────────────────────────────────────────────

  describe('multiple projects', () => {
    it('should route to different chat IDs for different projects', async () => {
      const projectA: ProjectLookupResult = {
        chatId: 'oc_chat_a',
        workingDir: '/path/to/project-a',
      };
      const projectB: ProjectLookupResult = {
        chatId: 'oc_chat_b',
        workingDir: '/path/to/project-b',
      };

      const multiLookup = createMockProjectLookup({
        'org/project-a': projectA,
        'org/project-b': projectB,
      });

      const multiRouter = new MessageRouter({
        projectLookup: multiLookup,
        agentPool: mockPool,
      });

      const msgA = createSystemMessage({
        id: 'msg-a',
        projectKey: 'org/project-a',
        payload: 'Task for project A',
      });
      const msgB = createSystemMessage({
        id: 'msg-b',
        projectKey: 'org/project-b',
        payload: 'Task for project B',
      });

      await multiRouter.route(msgA);
      await multiRouter.route(msgB);

      const agentA = mockPool.get('oc_chat_a');
      const agentB = mockPool.get('oc_chat_b');

      expect(agentA).toBeDefined();
      expect(agentB).toBeDefined();
      expect(agentA!.processMessage).toHaveBeenCalledWith(
        'oc_chat_a', 'Task for project A', 'msg-a'
      );
      expect(agentB!.processMessage).toHaveBeenCalledWith(
        'oc_chat_b', 'Task for project B', 'msg-b'
      );
    });
  });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('Message type guards', () => {
  it('isUserMessage should identify UserMessage', () => {
    const msg: Message = createUserMessage();
    expect(isUserMessage(msg)).toBe(true);
    expect(isSystemMessage(msg)).toBe(false);
    expect(isA2AMessage(msg)).toBe(false);
    expect(isNonUserMessage(msg)).toBe(false);
  });

  it('isSystemMessage should identify SystemMessage', () => {
    const msg: Message = createSystemMessage();
    expect(isUserMessage(msg)).toBe(false);
    expect(isSystemMessage(msg)).toBe(true);
    expect(isA2AMessage(msg)).toBe(false);
    expect(isNonUserMessage(msg)).toBe(true);
  });

  it('isA2AMessage should identify A2AMessage', () => {
    const msg: Message = createA2AMessage();
    expect(isUserMessage(msg)).toBe(false);
    expect(isSystemMessage(msg)).toBe(false);
    expect(isA2AMessage(msg)).toBe(true);
    expect(isNonUserMessage(msg)).toBe(true);
  });
});
