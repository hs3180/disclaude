/**
 * Tests for OfflineMessageManager.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OfflineMessageManager, setOfflineMessageManager, getOfflineMessageManager } from './offline-message-manager.js';
import type { OfflineMessageContext, OfflineMessageCallback } from './types.js';

// Mock AgentPool
const mockPilot = {
  executeOnce: vi.fn().mockResolvedValue(undefined),
};

const mockAgentPool = {
  getOrCreate: vi.fn().mockReturnValue(mockPilot),
};

describe('OfflineMessageManager', () => {
  let manager: OfflineMessageManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    manager = new OfflineMessageManager({
      defaultTimeoutMs: 60000, // 1 minute for tests
      cleanupIntervalMs: 10000,
      maxPerChat: 5,
    });
    manager.setAgentPool(mockAgentPool as unknown as ReturnType<typeof import('../agents/agent-pool.js').AgentPool>);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
    setOfflineMessageManager(null);
  });

  describe('register', () => {
    it('should register an offline message entry', () => {
      const context: OfflineMessageContext = {
        topic: 'Test topic',
        question: 'Test question?',
        sourceChatId: 'oc_test',
        createdAt: Date.now(),
      };

      const callback: OfflineMessageCallback = {
        type: 'new_task',
        promptTemplate: 'User replied: {{reply}}',
      };

      const entry = manager.register({
        messageId: 'msg_123',
        chatId: 'oc_test',
        context,
        callback,
      });

      expect(entry.id).toBeDefined();
      expect(entry.messageId).toBe('msg_123');
      expect(entry.chatId).toBe('oc_test');
      expect(entry.context.topic).toBe('Test topic');
      expect(entry.callback.type).toBe('new_task');
      expect(entry.createdAt).toBeGreaterThan(0);
      expect(entry.expiresAt).toBeGreaterThan(entry.createdAt);
    });

    it('should use custom timeout if provided', () => {
      const context: OfflineMessageContext = {
        topic: 'Test',
        question: 'Question?',
        sourceChatId: 'oc_test',
        createdAt: Date.now(),
      };

      const callback: OfflineMessageCallback = {
        type: 'new_task',
        promptTemplate: 'Reply: {{reply}}',
        timeoutMs: 120000, // 2 minutes
      };

      const entry = manager.register({
        messageId: 'msg_123',
        chatId: 'oc_test',
        context,
        callback,
      });

      expect(entry.expiresAt - entry.createdAt).toBe(120000);
    });

    it('should remove oldest entry when max per chat is exceeded', () => {
      // Register maxPerChat (5) entries
      for (let i = 0; i < 5; i++) {
        manager.register({
          messageId: `msg_${i}`,
          chatId: 'oc_test',
          context: {
            topic: `Topic ${i}`,
            question: `Question ${i}?`,
            sourceChatId: 'oc_test',
            createdAt: Date.now(),
          },
          callback: {
            type: 'new_task',
            promptTemplate: 'Reply: {{reply}}',
          },
        });
      }

      expect(manager.count).toBe(5);

      // Register one more - should remove the oldest
      manager.register({
        messageId: 'msg_5',
        chatId: 'oc_test',
        context: {
          topic: 'Topic 5',
          question: 'Question 5?',
          sourceChatId: 'oc_test',
          createdAt: Date.now(),
        },
        callback: {
          type: 'new_task',
          promptTemplate: 'Reply: {{reply}}',
        },
      });

      expect(manager.count).toBe(5);
      expect(manager.findByMessageId('msg_0')).toBeUndefined();
      expect(manager.findByMessageId('msg_5')).toBeDefined();
    });
  });

  describe('findByMessageId', () => {
    it('should find entry by message ID', () => {
      manager.register({
        messageId: 'msg_123',
        chatId: 'oc_test',
        context: {
          topic: 'Test',
          question: 'Question?',
          sourceChatId: 'oc_test',
          createdAt: Date.now(),
        },
        callback: {
          type: 'new_task',
          promptTemplate: 'Reply: {{reply}}',
        },
      });

      const entry = manager.findByMessageId('msg_123');
      expect(entry).toBeDefined();
      expect(entry?.messageId).toBe('msg_123');
    });

    it('should return undefined for non-existent message ID', () => {
      const entry = manager.findByMessageId('nonexistent');
      expect(entry).toBeUndefined();
    });
  });

  describe('findByChatId', () => {
    it('should find all entries for a chat', () => {
      manager.register({
        messageId: 'msg_1',
        chatId: 'oc_chat1',
        context: {
          topic: 'Topic 1',
          question: 'Q1?',
          sourceChatId: 'oc_chat1',
          createdAt: Date.now(),
        },
        callback: { type: 'new_task', promptTemplate: 'Reply: {{reply}}' },
      });

      manager.register({
        messageId: 'msg_2',
        chatId: 'oc_chat1',
        context: {
          topic: 'Topic 2',
          question: 'Q2?',
          sourceChatId: 'oc_chat1',
          createdAt: Date.now(),
        },
        callback: { type: 'new_task', promptTemplate: 'Reply: {{reply}}' },
      });

      manager.register({
        messageId: 'msg_3',
        chatId: 'oc_chat2',
        context: {
          topic: 'Topic 3',
          question: 'Q3?',
          sourceChatId: 'oc_chat2',
          createdAt: Date.now(),
        },
        callback: { type: 'new_task', promptTemplate: 'Reply: {{reply}}' },
      });

      const chat1Entries = manager.findByChatId('oc_chat1');
      expect(chat1Entries).toHaveLength(2);

      const chat2Entries = manager.findByChatId('oc_chat2');
      expect(chat2Entries).toHaveLength(1);
    });
  });

  describe('handleReply', () => {
    it('should trigger follow-up task when reply matches', async () => {
      const context: OfflineMessageContext = {
        topic: 'Daily review',
        question: 'Should we automate this?',
        sourceChatId: 'oc_test',
        createdAt: Date.now(),
      };

      const callback: OfflineMessageCallback = {
        type: 'new_task',
        promptTemplate: 'User replied: {{reply}}. Original question: {{context.question}}',
      };

      manager.register({
        messageId: 'msg_123',
        chatId: 'oc_test',
        context,
        callback,
      });

      const result = await manager.handleReply({
        chatId: 'oc_test',
        parentMessageId: 'msg_123',
        replyContent: 'Yes, please automate it',
        userId: 'user_456',
      });

      expect(result.success).toBe(true);
      expect(result.matched).toBe(true);
      expect(result.triggeredTaskId).toBeDefined();

      // Verify the follow-up task was triggered
      expect(mockAgentPool.getOrCreate).toHaveBeenCalledWith('oc_test');
      expect(mockPilot.executeOnce).toHaveBeenCalledWith(
        'oc_test',
        'User replied: Yes, please automate it. Original question: Should we automate this?',
        undefined
      );
    });

    it('should return matched=false when no matching entry exists', async () => {
      const result = await manager.handleReply({
        chatId: 'oc_test',
        parentMessageId: 'nonexistent',
        replyContent: 'Test reply',
      });

      expect(result.success).toBe(true);
      expect(result.matched).toBe(false);
    });

    it('should return matched=false when entry has expired', async () => {
      manager.register({
        messageId: 'msg_123',
        chatId: 'oc_test',
        context: {
          topic: 'Test',
          question: 'Question?',
          sourceChatId: 'oc_test',
          createdAt: Date.now(),
        },
        callback: {
          type: 'new_task',
          promptTemplate: 'Reply: {{reply}}',
          timeoutMs: 1000, // 1 second
        },
      });

      // Advance time past expiration
      vi.advanceTimersByTime(2000);

      const result = await manager.handleReply({
        chatId: 'oc_test',
        parentMessageId: 'msg_123',
        replyContent: 'Test reply',
      });

      expect(result.success).toBe(true);
      expect(result.matched).toBe(false);
    });

    it('should replace placeholders in prompt template', async () => {
      const context: OfflineMessageContext = {
        topic: 'Code review',
        question: 'Should we refactor?',
        metadata: {
          file: 'pilot.ts',
          lines: 876,
        },
        sourceChatId: 'oc_test',
        createdAt: Date.now(),
      };

      const callback: OfflineMessageCallback = {
        type: 'new_task',
        promptTemplate: 'Reply: {{reply}}\nTopic: {{context.topic}}\nFile: {{context.metadata.file}}\nLines: {{context.metadata.lines}}',
      };

      manager.register({
        messageId: 'msg_123',
        chatId: 'oc_test',
        context,
        callback,
      });

      await manager.handleReply({
        chatId: 'oc_test',
        parentMessageId: 'msg_123',
        replyContent: 'Yes, split it',
      });

      expect(mockPilot.executeOnce).toHaveBeenCalledWith(
        'oc_test',
        'Reply: Yes, split it\nTopic: Code review\nFile: pilot.ts\nLines: 876',
        undefined
      );
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired entries', () => {
      manager.register({
        messageId: 'msg_1',
        chatId: 'oc_test',
        context: {
          topic: 'Test',
          question: 'Q?',
          sourceChatId: 'oc_test',
          createdAt: Date.now(),
        },
        callback: {
          type: 'new_task',
          promptTemplate: 'Reply: {{reply}}',
          timeoutMs: 1000,
        },
      });

      manager.register({
        messageId: 'msg_2',
        chatId: 'oc_test',
        context: {
          topic: 'Test',
          question: 'Q?',
          sourceChatId: 'oc_test',
          createdAt: Date.now(),
        },
        callback: {
          type: 'new_task',
          promptTemplate: 'Reply: {{reply}}',
          timeoutMs: 10000,
        },
      });

      expect(manager.count).toBe(2);

      // Advance time by 2 seconds
      vi.advanceTimersByTime(2000);

      manager.cleanupExpired();

      expect(manager.count).toBe(1);
      expect(manager.findByMessageId('msg_1')).toBeUndefined();
      expect(manager.findByMessageId('msg_2')).toBeDefined();
    });
  });

  describe('global instance', () => {
    it('should throw when getting uninitialized manager', () => {
      expect(() => getOfflineMessageManager()).toThrow('not initialized');
    });

    it('should return the set instance', () => {
      setOfflineMessageManager(manager);
      expect(getOfflineMessageManager()).toBe(manager);
    });
  });
});
