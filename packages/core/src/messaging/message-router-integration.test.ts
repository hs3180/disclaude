/**
 * Integration tests for Channel + Scheduler via MessageRouter.
 *
 * Verifies end-to-end message routing:
 * - UserMessage: Feishu event → UserMessage → MessageRouter → AgentPoolMessageHandler
 * - SystemMessage: schedule trigger → SystemMessage → MessageRouter → handler
 *
 * Issue #3582: Channel + Scheduler integration via MessageRouter (Phase 3)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MessageRouter,
  MessageRoutingError,
  type IAgentMessageHandler,
} from './message-router.js';
import type { UserMessage, SystemMessage } from '../types/message.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createUserMessage(overrides?: Partial<UserMessage>): UserMessage {
  return {
    id: 'msg-user-1',
    source: 'user',
    payload: 'Hello from Feishu!',
    chatId: 'oc_chat123',
    messageId: 'feishu-msg-1',
    senderOpenId: 'ou_sender1',
    createdAt: '2026-05-14T00:00:00Z',
    ...overrides,
  };
}

function createSystemMessage(overrides?: Partial<SystemMessage>): SystemMessage {
  return {
    id: 'msg-sys-1',
    source: 'system',
    payload: 'Run scheduled task: daily-maintenance',
    chatId: 'oc_chat456',
    trigger: 'scheduled',
    taskName: 'daily-maintenance',
    createdAt: '2026-05-14T00:00:00Z',
    ...overrides,
  };
}

function createMockHandler(): IAgentMessageHandler {
  return {
    handleUserMessage: vi.fn().mockResolvedValue(undefined),
    handleSystemMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Integration: UserMessage end-to-end
// ============================================================================

describe('Integration: UserMessage end-to-end (Feishu → MessageRouter → Agent)', () => {
  it('should route UserMessage through MessageRouter to handler', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    // Simulate Feishu channel constructing UserMessage
    const userMessage = createUserMessage({
      id: 'feishu-msg-001',
      chatId: 'oc_group_abc',
      payload: '请帮我分析一下最近的代码提交',
      messageId: 'feishu-msg-001',
      senderOpenId: 'ou_user_zhangsan',
      attachments: [
        {
          id: 'file-uuid-1',
          fileName: 'report.pdf',
          source: 'user' as const,
          createdAt: Date.now(),
          localPath: '/tmp/downloads/report.pdf',
        },
      ],
    });

    await router.route(userMessage);

    // Verify handler received the message correctly
    expect(handler.handleUserMessage).toHaveBeenCalledWith(
      'oc_group_abc',
      '请帮我分析一下最近的代码提交',
      'feishu-msg-001',
      'ou_user_zhangsan',
      [
        {
          id: 'file-uuid-1',
          fileName: 'report.pdf',
          source: 'user',
          createdAt: expect.any(Number),
          localPath: '/tmp/downloads/report.pdf',
        },
      ],
      undefined,
      undefined,
      undefined,
    );
  });

  it('should route UserMessage with chatHistoryContext', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    const userMessage = createUserMessage({
      chatHistoryContext: '## Previous conversation\nUser: Hello\nBot: Hi!',
    });

    await router.route(userMessage);

    expect(handler.handleUserMessage).toHaveBeenCalledWith(
      'oc_chat123',
      'Hello from Feishu!',
      'feishu-msg-1',
      'ou_sender1',
      undefined,
      '## Previous conversation\nUser: Hello\nBot: Hi!',
      undefined,
      undefined,
    );
  });

  it('should route multiple UserMessages to different chats', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    // Simulate messages from different Feishu chats
    const messages: UserMessage[] = [
      createUserMessage({ id: 'msg-1', chatId: 'oc_chatA', messageId: 'fm-1', payload: 'Message A' }),
      createUserMessage({ id: 'msg-2', chatId: 'oc_chatB', messageId: 'fm-2', payload: 'Message B' }),
      createUserMessage({ id: 'msg-3', chatId: 'oc_chatA', messageId: 'fm-3', payload: 'Follow-up A' }),
    ];

    for (const msg of messages) {
      await router.route(msg);
    }

    expect(handler.handleUserMessage).toHaveBeenCalledTimes(3);
    expect(handler.handleUserMessage).toHaveBeenNthCalledWith(1, 'oc_chatA', 'Message A', 'fm-1', 'ou_sender1', undefined, undefined, undefined, undefined);
    expect(handler.handleUserMessage).toHaveBeenNthCalledWith(2, 'oc_chatB', 'Message B', 'fm-2', 'ou_sender1', undefined, undefined, undefined, undefined);
    expect(handler.handleUserMessage).toHaveBeenNthCalledWith(3, 'oc_chatA', 'Follow-up A', 'fm-3', 'ou_sender1', undefined, undefined, undefined, undefined);
  });
});

// ============================================================================
// Integration: SystemMessage end-to-end (Scheduler → MessageRouter → Agent)
// ============================================================================

describe('Integration: SystemMessage end-to-end (Scheduler → MessageRouter → Agent)', () => {
  it('should route SystemMessage from scheduler to handler', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    // Simulate scheduler constructing SystemMessage
    const systemMessage = createSystemMessage({
      id: 'sched-daily-maint-1715644800000',
      chatId: 'oc_admin_chat',
      payload: '⚠️ **Scheduled Task Execution Context**\n\n**Task Prompt:**\nRun daily maintenance and cleanup',
      trigger: 'scheduled',
      taskName: 'daily-maintenance',
    });

    await router.route(systemMessage);

    expect(handler.handleSystemMessage).toHaveBeenCalledWith(
      'oc_admin_chat',
      expect.stringContaining('Scheduled Task Execution Context'),
      'sched-daily-maint-1715644800000',
    );
  });

  it('should route SystemMessage with different triggers', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    const triggers: Array<'scheduled' | 'signal' | 'command'> = ['scheduled', 'signal', 'command'];
    for (const trigger of triggers) {
      const msg = createSystemMessage({ trigger, id: `msg-${trigger}` });
      await router.route(msg);
    }

    expect(handler.handleSystemMessage).toHaveBeenCalledTimes(3);
  });

  it('should route SystemMessage to the correct chatId', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    // Different tasks target different chats
    await router.route(createSystemMessage({ chatId: 'oc_chat_project1', taskName: 'task-a', id: 's-1' }));
    await router.route(createSystemMessage({ chatId: 'oc_chat_project2', taskName: 'task-b', id: 's-2' }));

    expect(handler.handleSystemMessage).toHaveBeenNthCalledWith(1, 'oc_chat_project1', expect.any(String), 's-1');
    expect(handler.handleSystemMessage).toHaveBeenNthCalledWith(2, 'oc_chat_project2', expect.any(String), 's-2');
  });
});

// ============================================================================
// Integration: Mixed UserMessage + SystemMessage
// ============================================================================

describe('Integration: Mixed message routing', () => {
  it('should route both user and system messages correctly', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    // Simulate concurrent user message and scheduler trigger
    const userMsg = createUserMessage({ chatId: 'oc_chat_x', id: 'u-1' });
    const sysMsg = createSystemMessage({ chatId: 'oc_chat_x', id: 's-1' });

    await Promise.all([
      router.route(userMsg),
      router.route(sysMsg),
    ]);

    expect(handler.handleUserMessage).toHaveBeenCalledTimes(1);
    expect(handler.handleSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('should handle errors in user message routing without affecting system messages', async () => {
    const handler = createMockHandler();
    handler.handleUserMessage = vi.fn().mockRejectedValue(new Error('Agent unavailable'));
    const router = new MessageRouter({ handler });

    // User message should fail
    await expect(router.route(createUserMessage())).rejects.toThrow(MessageRoutingError);

    // System message should still work
    handler.handleSystemMessage = vi.fn().mockResolvedValue(undefined);
    await router.route(createSystemMessage());
    expect(handler.handleSystemMessage).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Integration: Error handling
// ============================================================================

describe('Integration: Error handling in routing', () => {
  it('should throw MessageRoutingError for missing chatId in UserMessage', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    const userMessage = createUserMessage({ chatId: '' });

    await expect(router.route(userMessage)).rejects.toThrow(MessageRoutingError);
    await expect(router.route(userMessage)).rejects.toThrow('missing chatId');
  });

  it('should throw MessageRoutingError for missing chatId in SystemMessage', async () => {
    const handler = createMockHandler();
    const router = new MessageRouter({ handler });

    const systemMessage = createSystemMessage({ chatId: '' });

    await expect(router.route(systemMessage)).rejects.toThrow(MessageRoutingError);
  });

  it('should wrap handler errors in MessageRoutingError', async () => {
    const handler = createMockHandler();
    handler.handleUserMessage = vi.fn().mockRejectedValue(new Error('Pool exhausted'));
    const router = new MessageRouter({ handler });

    await expect(router.route(createUserMessage())).rejects.toThrow(MessageRoutingError);
    await expect(router.route(createUserMessage())).rejects.toThrow('Failed to route message');
  });
});
