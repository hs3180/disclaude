/**
 * Tests for InputMessageRouter (Issue #3329 Phase 1 / Issue #3580).
 *
 * @see Issue #3580 — Unit Tests scope:
 * - 路由逻辑：每种 source 类型的解析和分发
 * - chatId 解析：UserMessage 自带、SystemMessage 从 project config 获取
 * - 边界情况：未知 projectKey、缺失 chatId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatAgent } from '../agents/types.js';
import { AgentPool } from '../agents/agent-pool.js';
import {
  InputMessageRouter,
  type UserMessage,
  type SystemMessage,
  type ProjectChatIdResolver,
} from './input-message-router.js';

// ============================================================================
// Mock Helpers
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
    stop: vi.fn().mockReturnValue(false),
    dispose: vi.fn(),
  };
}

function createUserMessage(overrides?: Partial<UserMessage>): UserMessage {
  return {
    id: 'msg-user-001',
    source: 'user',
    payload: 'Hello from user',
    createdAt: '2026-05-13T00:00:00.000Z',
    chatId: 'oc_test_chat',
    messageId: 'feishu-msg-001',
    senderOpenId: 'ou_sender001',
    ...overrides,
  };
}

function createSystemMessage(overrides?: Partial<SystemMessage>): SystemMessage {
  return {
    id: 'msg-sys-001',
    source: 'system',
    payload: 'Run scheduled task',
    createdAt: '2026-05-13T00:00:00.000Z',
    trigger: 'scheduled',
    taskName: 'daily-maintenance',
    ...overrides,
  };
}

function createResolver(mapping: Record<string, string>): ProjectChatIdResolver {
  return {
    resolve(projectKey: string): string | undefined {
      return mapping[projectKey];
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('InputMessageRouter', () => {
  let pool: AgentPool;
  let router: InputMessageRouter;

  beforeEach(() => {
    pool = new AgentPool({
      chatAgentFactory: vi.fn(createMockChatAgent),
    });
  });

  // ==========================================================================
  // UserMessage Routing
  // ==========================================================================

  describe('route — UserMessage', () => {
    it('should route UserMessage by direct chatId', () => {
      router = new InputMessageRouter({ agentPool: pool });
      const message = createUserMessage();

      const result = router.route(message);

      expect(result.routed).toBe(true);
      if (!result.routed) {return;}
      expect(result.chatId).toBe('oc_test_chat');
      expect(result.method).toBe('user-direct');
      expect(result.agent).toBeDefined();
    });

    it('should call processMessage on the resolved agent', () => {
      router = new InputMessageRouter({ agentPool: pool });
      const message = createUserMessage();

      router.route(message);

      const agent = pool.get('oc_test_chat');
      expect(agent).toBeDefined();
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_test_chat',
        'Hello from user',
        'feishu-msg-001',
        'ou_sender001',
        undefined,
        undefined
      );
    });

    it('should reuse existing agent for same chatId', () => {
      router = new InputMessageRouter({ agentPool: pool });
      const msg1 = createUserMessage({ id: 'msg-1' });
      const msg2 = createUserMessage({ id: 'msg-2', payload: 'Second message' });

      const result1 = router.route(msg1);
      const result2 = router.route(msg2);

      expect(result1.routed).toBe(true);
      expect(result2.routed).toBe(true);
      if (!result1.routed || !result2.routed) {return;}
      expect(result1.agent).toBe(result2.agent);
    });

    it('should create different agents for different chatIds', () => {
      router = new InputMessageRouter({ agentPool: pool });
      const msg1 = createUserMessage({ chatId: 'oc_chat_A' });
      const msg2 = createUserMessage({ chatId: 'oc_chat_B' });

      const result1 = router.route(msg1);
      const result2 = router.route(msg2);

      expect(result1.routed).toBe(true);
      expect(result2.routed).toBe(true);
      if (!result1.routed || !result2.routed) {return;}
      expect(result1.agent).not.toBe(result2.agent);
    });

    it('should pass chatHistoryContext to processMessage', () => {
      router = new InputMessageRouter({ agentPool: pool });
      const message = createUserMessage({
        chatHistoryContext: '[recent chat history]',
      });

      router.route(message);

      const agent = pool.get('oc_test_chat');
      expect(agent!.processMessage).toHaveBeenCalledWith(
        'oc_test_chat',
        'Hello from user',
        'feishu-msg-001',
        'ou_sender001',
        undefined,
        '[recent chat history]'
      );
    });
  });

  // ==========================================================================
  // SystemMessage Routing
  // ==========================================================================

  describe('route — SystemMessage', () => {
    it('should route SystemMessage via projectKey resolution', () => {
      const resolver = createResolver({
        'hs3180/disclaude': 'oc_project_chat',
      });
      router = new InputMessageRouter({ agentPool: pool, projectChatIdResolver: resolver });

      const message = createSystemMessage({
        projectKey: 'hs3180/disclaude',
      });

      const result = router.route(message);

      expect(result.routed).toBe(true);
      if (!result.routed) {return;}
      expect(result.chatId).toBe('oc_project_chat');
      expect(result.method).toBe('project-resolved');
      expect(result.agent).toBeDefined();
    });

    it('should call runOnce on the resolved agent for SystemMessage', () => {
      const resolver = createResolver({
        'hs3180/disclaude': 'oc_project_chat',
      });
      router = new InputMessageRouter({ agentPool: pool, projectChatIdResolver: resolver });

      const message = createSystemMessage({
        projectKey: 'hs3180/disclaude',
      });

      router.route(message);

      const agent = pool.get('oc_project_chat');
      expect(agent).toBeDefined();
      expect(agent!.runOnce).toHaveBeenCalledWith(
        'oc_project_chat',
        'Run scheduled task',
        'msg-sys-001'
      );
    });

    it('should support different trigger types', () => {
      const resolver = createResolver({
        'my-project': 'oc_chat_1',
      });
      router = new InputMessageRouter({ agentPool: pool, projectChatIdResolver: resolver });

      for (const trigger of ['scheduled', 'signal', 'command'] as const) {
        const message = createSystemMessage({
          projectKey: 'my-project',
          trigger,
        });
        const result = router.route(message);
        expect(result.routed).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('route — edge cases', () => {
    it('should return fallback for SystemMessage without projectKey', () => {
      router = new InputMessageRouter({ agentPool: pool });
      const message = createSystemMessage(); // no projectKey

      const result = router.route(message);

      expect(result.routed).toBe(false);
      if (result.routed) {return;}
      expect(result.reason).toBe('no-project-key');
    });

    it('should return fallback for unknown projectKey', () => {
      const resolver = createResolver({}); // empty mapping
      router = new InputMessageRouter({ agentPool: pool, projectChatIdResolver: resolver });

      const message = createSystemMessage({
        projectKey: 'unknown/project',
      });

      const result = router.route(message);

      expect(result.routed).toBe(false);
      if (result.routed) {return;}
      expect(result.reason).toBe('unknown-project');
    });

    it('should return fallback when no resolver configured and projectKey is set', () => {
      router = new InputMessageRouter({ agentPool: pool }); // no resolver

      const message = createSystemMessage({
        projectKey: 'hs3180/disclaude',
      });

      const result = router.route(message);

      expect(result.routed).toBe(false);
      if (result.routed) {return;}
      expect(result.reason).toBe('unknown-project');
    });
  });
});
