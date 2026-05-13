/**
 * Integration tests for Channel + Scheduler integration via InputMessageRouter.
 *
 * Issue #3582: Tests the end-to-end routing of:
 * - UserMessage: Channel event → UserMessage → InputMessageRouter → ChatAgent
 * - SystemMessage: Schedule → SystemMessage(projectKey) → InputMessageRouter → ChatAgent
 *
 * These tests use real InputMessageRouter, AgentPool, and mock ChatAgent instances
 * to verify the integration layer without depending on platform-specific channels.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentPool, InputMessageRouter, type ProjectChatIdResolver } from '@disclaude/core';
import type { ChatAgent } from '../../../core/src/agents/types.js';
import type { UserMessage, SystemMessage } from '../../../core/src/types/message.js';

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

function createResolver(mapping: Record<string, string>): ProjectChatIdResolver {
  return {
    resolve(projectKey: string): string | undefined {
      return mapping[projectKey];
    },
  };
}

// ============================================================================
// UserMessage Integration Tests
// ============================================================================

describe('Issue #3582 — UserMessage Integration (Channel → Router → Agent)', () => {
  let pool: AgentPool;
  let router: InputMessageRouter;

  beforeEach(() => {
    pool = new AgentPool({
      chatAgentFactory: vi.fn(createMockChatAgent),
    });
    router = new InputMessageRouter({ agentPool: pool });
  });

  it('should route Feishu-like UserMessage to correct agent', async () => {
    const userMessage: UserMessage = {
      id: 'feishu-msg-001',
      source: 'user',
      payload: '你好，请帮我检查代码',
      createdAt: new Date().toISOString(),
      chatId: 'oc_feishu_chat_001',
      messageId: 'feishu-msg-001',
      senderOpenId: 'ou_user_001',
    };

    const result = await router.route(userMessage);

    expect(result.routed).toBe(true);
    if (!result.routed) { return; }
    expect(result.chatId).toBe('oc_feishu_chat_001');
    expect(result.method).toBe('user-direct');

    const agent = pool.get('oc_feishu_chat_001');
    expect(agent).toBeDefined();
    expect(agent!.processMessage).toHaveBeenCalledWith(
      'oc_feishu_chat_001',
      '你好，请帮我检查代码',
      'feishu-msg-001',
      'ou_user_001',
      undefined,
      undefined
    );
  });

  it('should route UserMessage with attachments to agent', async () => {
    const fileRefs = [{
      id: 'file-001',
      fileName: 'screenshot.png',
      source: 'user' as const,
      localPath: '/tmp/screenshot.png',
      mimeType: 'image/png',
      size: 1024,
      createdAt: Date.now(),
    }];

    const userMessage: UserMessage = {
      id: 'msg-with-file',
      source: 'user',
      payload: '请看这个截图',
      createdAt: new Date().toISOString(),
      chatId: 'oc_chat_files',
      messageId: 'msg-with-file',
      senderOpenId: 'ou_sender',
      fileRefs,
    };

    const result = await router.route(userMessage);
    expect(result.routed).toBe(true);

    const agent = pool.get('oc_chat_files');
    expect(agent!.processMessage).toHaveBeenCalledWith(
      'oc_chat_files',
      '请看这个截图',
      'msg-with-file',
      'ou_sender',
      fileRefs,
      undefined
    );
  });

  it('should reuse agent for multiple UserMessages from same chatId', async () => {
    const messages: UserMessage[] = [
      {
        id: 'msg-1', source: 'user', payload: '第一条消息',
        createdAt: new Date().toISOString(), chatId: 'oc_persistent',
        messageId: 'msg-1', senderOpenId: 'ou_user',
      },
      {
        id: 'msg-2', source: 'user', payload: '第二条消息',
        createdAt: new Date().toISOString(), chatId: 'oc_persistent',
        messageId: 'msg-2', senderOpenId: 'ou_user',
      },
    ];

    const results = await Promise.all(messages.map(m => router.route(m)));

    expect(results.every(r => r.routed)).toBe(true);
    const agents = results.map(r => r.routed ? r.agent : null);
    expect(agents[0]).toBe(agents[1]); // Same agent instance

    const agent = pool.get('oc_persistent');
    expect(agent!.processMessage).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// SystemMessage Integration Tests
// ============================================================================

describe('Issue #3582 — SystemMessage Integration (Schedule → Router → Agent)', () => {
  let pool: AgentPool;
  let router: InputMessageRouter;

  beforeEach(() => {
    pool = new AgentPool({
      chatAgentFactory: vi.fn(createMockChatAgent),
    });
  });

  it('should route SystemMessage with projectKey to resolved agent', async () => {
    const resolver = createResolver({
      '/workspace/my-project': 'oc_project_chat',
    });
    router = new InputMessageRouter({ agentPool: pool, projectChatIdResolver: resolver });

    const systemMessage: SystemMessage = {
      id: 'sched-001',
      source: 'system',
      payload: '执行每日代码检查任务...',
      createdAt: new Date().toISOString(),
      trigger: 'scheduled',
      projectKey: '/workspace/my-project',
      taskName: 'daily-code-review',
    };

    const result = await router.route(systemMessage);

    expect(result.routed).toBe(true);
    if (!result.routed) { return; }
    expect(result.chatId).toBe('oc_project_chat');
    expect(result.method).toBe('project-resolved');

    const agent = pool.get('oc_project_chat');
    expect(agent).toBeDefined();
    expect(agent!.runOnce).toHaveBeenCalledWith(
      'oc_project_chat',
      '执行每日代码检查任务...',
      'sched-001'
    );
  });

  it('should return fallback for SystemMessage without projectKey', async () => {
    router = new InputMessageRouter({ agentPool: pool });

    const systemMessage: SystemMessage = {
      id: 'sched-002',
      source: 'system',
      payload: 'Legacy task',
      createdAt: new Date().toISOString(),
      trigger: 'scheduled',
    };

    const result = await router.route(systemMessage);
    expect(result.routed).toBe(false);
    if (result.routed) { return; }
    expect(result.reason).toBe('no-project-key');
  });

  it('should return fallback for unknown projectKey', async () => {
    const resolver = createResolver({}); // empty mapping
    router = new InputMessageRouter({ agentPool: pool, projectChatIdResolver: resolver });

    const systemMessage: SystemMessage = {
      id: 'sched-003',
      source: 'system',
      payload: 'Unknown project task',
      createdAt: new Date().toISOString(),
      trigger: 'scheduled',
      projectKey: '/unknown/project',
    };

    const result = await router.route(systemMessage);
    expect(result.routed).toBe(false);
    if (result.routed) { return; }
    expect(result.reason).toBe('unknown-project');
  });

  it('should reuse agent for multiple SystemMessages to same project', async () => {
    const resolver = createResolver({
      '/workspace/proj': 'oc_proj_chat',
    });
    router = new InputMessageRouter({ agentPool: pool, projectChatIdResolver: resolver });

    const msg1: SystemMessage = {
      id: 'sched-1', source: 'system', payload: 'First task',
      createdAt: new Date().toISOString(), trigger: 'scheduled',
      projectKey: '/workspace/proj', taskName: 'task-1',
    };
    const msg2: SystemMessage = {
      id: 'sched-2', source: 'system', payload: 'Second task',
      createdAt: new Date().toISOString(), trigger: 'signal',
      projectKey: '/workspace/proj', taskName: 'task-2',
    };

    const result1 = await router.route(msg1);
    const result2 = await router.route(msg2);

    expect(result1.routed).toBe(true);
    expect(result2.routed).toBe(true);
    if (!result1.routed || !result2.routed) { return; }
    expect(result1.agent).toBe(result2.agent);
  });
});
