/**
 * Integration tests for ProjectConfig → InputMessageRouter → AgentPool flow
 * (Issue #3329 Phase 2 / Issue #3581).
 *
 * Tests the complete routing chain:
 * - UserMessage → direct chatId routing
 * - SystemMessage → projectKey → ProjectConfigStore.resolve → chatId → AgentPool
 * - CwdProvider integration with project-scoped agents
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatAgent } from '../agents/types.js';
import { AgentPool } from '../agents/agent-pool.js';
import { InputMessageRouter, type UserMessage, type SystemMessage } from './input-message-router.js';
import { ProjectConfigStore } from '../project/project-config-store.js';
import type { ProjectConfig } from '../project/types.js';

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
    chatId: 'oc_user_chat',
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

// ============================================================================
// Integration Tests
// ============================================================================

describe('Phase 2 Integration: ProjectConfig → Router → AgentPool', () => {
  let pool: AgentPool;
  let store: ProjectConfigStore;
  let router: InputMessageRouter;

  beforeEach(() => {
    store = new ProjectConfigStore();
    pool = new AgentPool({
      chatAgentFactory: vi.fn(createMockChatAgent),
      projectConfigStore: store,
    });
  });

  describe('SystemMessage → project-resolved routing', () => {
    it('should route SystemMessage through ProjectConfigStore', () => {
      store.register({
        key: 'hs3180/disclaude',
        workingDir: '/workspace/disclaude',
        chatId: 'oc_project_chat',
      });

      router = new InputMessageRouter({
        agentPool: pool,
        projectChatIdResolver: store,
      });

      const message = createSystemMessage({
        projectKey: 'hs3180/disclaude',
      });

      const result = router.route(message);

      expect(result.routed).toBe(true);
      if (!result.routed) { return; }
      expect(result.chatId).toBe('oc_project_chat');
      expect(result.method).toBe('project-resolved');
    });

    it('should create project-scoped agent with correct chatId', () => {
      store.register({
        key: 'my-project',
        workingDir: '/workspace/my-project',
        chatId: 'oc_project_chat',
      });

      router = new InputMessageRouter({
        agentPool: pool,
        projectChatIdResolver: store,
      });

      const message = createSystemMessage({
        projectKey: 'my-project',
      });

      router.route(message);

      const agent = pool.get('oc_project_chat');
      expect(agent).toBeDefined();
    });

    it('should reuse agent for same project across multiple messages', () => {
      store.register({
        key: 'my-project',
        workingDir: '/workspace/my-project',
        chatId: 'oc_project_chat',
      });

      router = new InputMessageRouter({
        agentPool: pool,
        projectChatIdResolver: store,
      });

      const msg1 = createSystemMessage({ id: 'sys-1', projectKey: 'my-project' });
      const msg2 = createSystemMessage({ id: 'sys-2', projectKey: 'my-project' });

      const result1 = router.route(msg1);
      const result2 = router.route(msg2);

      expect(result1.routed).toBe(true);
      expect(result2.routed).toBe(true);
      if (!result1.routed || !result2.routed) { return; }
      expect(result1.agent).toBe(result2.agent);
      expect(pool.size()).toBe(1);
    });

    it('should create separate agents for different projects', () => {
      store.register({
        key: 'project-a',
        workingDir: '/workspace/a',
        chatId: 'oc_chat_a',
      });
      store.register({
        key: 'project-b',
        workingDir: '/workspace/b',
        chatId: 'oc_chat_b',
      });

      router = new InputMessageRouter({
        agentPool: pool,
        projectChatIdResolver: store,
      });

      const msgA = createSystemMessage({ projectKey: 'project-a' });
      const msgB = createSystemMessage({ projectKey: 'project-b' });

      const resultA = router.route(msgA);
      const resultB = router.route(msgB);

      expect(resultA.routed).toBe(true);
      expect(resultB.routed).toBe(true);
      if (!resultA.routed || !resultB.routed) { return; }
      expect(resultA.agent).not.toBe(resultB.agent);
      expect(pool.size()).toBe(2);
    });
  });

  describe('CwdProvider integration', () => {
    it('should provide workingDir via CwdProvider for project chatId', () => {
      store.register({
        key: 'hs3180/disclaude',
        workingDir: '/workspace/disclaude',
        chatId: 'oc_project_chat',
      });

      const cwdProvider = store.createCwdProvider();

      expect(cwdProvider('oc_project_chat')).toBe('/workspace/disclaude');
    });

    it('should return undefined for non-project chatId', () => {
      const cwdProvider = store.createCwdProvider();

      expect(cwdProvider('oc_user_chat')).toBeUndefined();
    });
  });

  describe('AgentPool.getOrCreateProjectAgent', () => {
    it('should create agent via projectKey lookup', () => {
      store.register({
        key: 'my-project',
        workingDir: '/workspace/my-project',
        chatId: 'oc_project_chat',
      });

      const agent = pool.getOrCreateProjectAgent('my-project');

      expect(agent).toBeDefined();
      expect(pool.has('oc_project_chat')).toBe(true);
    });

    it('should return undefined for unknown projectKey', () => {
      const agent = pool.getOrCreateProjectAgent('unknown');

      expect(agent).toBeUndefined();
    });

    it('should return undefined when no store configured', () => {
      const poolWithoutStore = new AgentPool({
        chatAgentFactory: vi.fn(createMockChatAgent),
      });

      const agent = poolWithoutStore.getOrCreateProjectAgent('any-project');

      expect(agent).toBeUndefined();
    });

    it('should reuse existing agent for same project', () => {
      store.register({
        key: 'my-project',
        workingDir: '/workspace/my-project',
        chatId: 'oc_project_chat',
      });

      const agent1 = pool.getOrCreateProjectAgent('my-project');
      const agent2 = pool.getOrCreateProjectAgent('my-project');

      expect(agent1).toBe(agent2);
      expect(pool.size()).toBe(1);
    });
  });

  describe('Mixed UserMessage + SystemMessage routing', () => {
    it('should handle both user and system messages through same pool', () => {
      store.register({
        key: 'my-project',
        workingDir: '/workspace/my-project',
        chatId: 'oc_project_chat',
      });

      router = new InputMessageRouter({
        agentPool: pool,
        projectChatIdResolver: store,
      });

      // User message to a different chat
      const userMsg = createUserMessage({ chatId: 'oc_user_chat' });
      const userResult = router.route(userMsg);

      // System message to project chat
      const sysMsg = createSystemMessage({ projectKey: 'my-project' });
      const sysResult = router.route(sysMsg);

      expect(userResult.routed).toBe(true);
      expect(sysResult.routed).toBe(true);
      if (!userResult.routed || !sysResult.routed) { return; }
      expect(userResult.method).toBe('user-direct');
      expect(sysResult.method).toBe('project-resolved');
      expect(userResult.agent).not.toBe(sysResult.agent);
      expect(pool.size()).toBe(2);
    });
  });

  describe('Dynamic project registration', () => {
    it('should route to newly registered project after registration', () => {
      router = new InputMessageRouter({
        agentPool: pool,
        projectChatIdResolver: store,
      });

      const msg = createSystemMessage({ projectKey: 'new-project' });
      const before = router.route(msg);
      expect(before.routed).toBe(false);

      // Register the project
      store.register({
        key: 'new-project',
        workingDir: '/workspace/new',
        chatId: 'oc_new_chat',
      });

      const after = router.route(msg);
      expect(after.routed).toBe(true);
      if (!after.routed) { return; }
      expect(after.chatId).toBe('oc_new_chat');
    });
  });

  describe('ProjectConfig with modelTier', () => {
    it('should store modelTier in config', () => {
      const config: ProjectConfig = {
        key: 'my-project',
        workingDir: '/workspace/my-project',
        chatId: 'oc_project_chat',
        modelTier: 'high',
      };

      store.register(config);

      const retrieved = store.get('my-project');
      expect(retrieved?.modelTier).toBe('high');
    });
  });
});
