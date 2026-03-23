/**
 * Tests for DiscussionManager (Issue #631)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiscussionManager, resetDiscussionManager } from './discussion-manager.js';
import type { DiscussionTopic, DiscussionResult } from './types.js';

describe('DiscussionManager', () => {
  let manager: DiscussionManager;

  const sampleTopic: DiscussionTopic = {
    title: '是否应该自动化代码格式化？',
    description: '团队需要讨论是否引入自动化代码格式化工具',
    context: '最近多次手动格式化导致代码风格不一致',
    participants: ['ou_user1', 'ou_user2'],
  };

  const sampleResult: DiscussionResult = {
    outcome: 'action_taken',
    summary: '团队一致同意引入 Prettier 进行代码格式化',
    actions: [
      {
        type: 'execute_task',
        description: '配置 Prettier 并添加到项目中',
      },
    ],
  };

  beforeEach(() => {
    resetDiscussionManager();
    // Create manager without persistence for testing
    manager = new DiscussionManager();
  });

  afterEach(() => {
    manager.dispose();
    resetDiscussionManager();
  });

  describe('createDiscussion', () => {
    it('should create a discussion record with correct initial state', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source123',
        creatorOpenId: 'ou_creator',
      });

      expect(record.id).toBeDefined();
      expect(record.chatId).toBe('');
      expect(record.sourceChatId).toBe('oc_source123');
      expect(record.creatorOpenId).toBe('ou_creator');
      expect(record.topic).toEqual(sampleTopic);
      expect(record.status).toBe('creating');
      expect(record.createdAt).toBeGreaterThan(0);
      expect(record.updatedAt).toBeGreaterThan(0);
    });

    it('should generate unique IDs for each discussion', () => {
      const record1 = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      const record2 = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });

      expect(record1.id).not.toBe(record2.id);
    });
  });

  describe('activateDiscussion', () => {
    it('should activate a creating discussion with a chat ID', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });

      const activated = manager.activateDiscussion(record.id, 'oc_discussion123');

      expect(activated).toBeDefined();
      expect(activated!.chatId).toBe('oc_discussion123');
      expect(activated!.status).toBe('active');
    });

    it('should return undefined for non-existent discussion', () => {
      const result = manager.activateDiscussion('non-existent-id', 'oc_chat');
      expect(result).toBeUndefined();
    });

    it('should return undefined if discussion is not in creating status', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      manager.activateDiscussion(record.id, 'oc_chat');

      // Try to activate again (now it's active, not creating)
      const result = manager.activateDiscussion(record.id, 'oc_chat2');
      expect(result).toBeUndefined();
    });
  });

  describe('concludeDiscussion', () => {
    it('should conclude an active discussion with results', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      manager.activateDiscussion(record.id, 'oc_discussion');

      const concluded = manager.concludeDiscussion({
        chatId: 'oc_discussion',
        result: sampleResult,
      });

      expect(concluded).toBeDefined();
      expect(concluded!.status).toBe('concluded');
      expect(concluded!.result).toEqual(sampleResult);
      expect(concluded!.concludedAt).toBeGreaterThan(0);
    });

    it('should return undefined for non-existent chat ID', () => {
      const result = manager.concludeDiscussion({
        chatId: 'oc_nonexistent',
        result: sampleResult,
      });
      expect(result).toBeUndefined();
    });

    it('should return undefined if discussion is not active', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      manager.activateDiscussion(record.id, 'oc_discussion');
      manager.concludeDiscussion({
        chatId: 'oc_discussion',
        result: sampleResult,
      });

      // Try to conclude again
      const result = manager.concludeDiscussion({
        chatId: 'oc_discussion',
        result: sampleResult,
      });
      expect(result).toBeUndefined();
    });
  });

  describe('expireDiscussion', () => {
    it('should expire an active discussion', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      manager.activateDiscussion(record.id, 'oc_discussion');

      const expired = manager.expireDiscussion(record.id);
      expect(expired).toBeDefined();
      expect(expired!.status).toBe('expired');
    });

    it('should not expire a non-active discussion', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });

      const expired = manager.expireDiscussion(record.id);
      expect(expired).toBeUndefined();
    });
  });

  describe('getDiscussion', () => {
    it('should find a discussion by ID', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });

      const found = manager.getDiscussion(record.id);
      expect(found).toEqual(record);
    });

    it('should return undefined for non-existent ID', () => {
      const found = manager.getDiscussion('non-existent');
      expect(found).toBeUndefined();
    });
  });

  describe('findByChatId', () => {
    it('should find a discussion by chat ID', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      manager.activateDiscussion(record.id, 'oc_discussion');

      const found = manager.findByChatId('oc_discussion');
      expect(found).toBeDefined();
      expect(found!.id).toBe(record.id);
    });

    it('should return undefined for non-existent chat ID', () => {
      const found = manager.findByChatId('oc_nonexistent');
      expect(found).toBeUndefined();
    });
  });

  describe('listDiscussions', () => {
    it('should list all discussions when no filter', () => {
      manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_1' });
      manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_2' });
      manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_3' });

      expect(manager.listDiscussions()).toHaveLength(3);
    });

    it('should filter by status', () => {
      const r1 = manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_1' });
      manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_2' });
      manager.activateDiscussion(r1.id, 'oc_d1');
      // second discussion stays in 'creating' status

      expect(manager.listDiscussions('creating')).toHaveLength(1);
      expect(manager.listDiscussions('active')).toHaveLength(1);
    });
  });

  describe('listActiveDiscussions', () => {
    it('should only return active discussions', () => {
      const r1 = manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_1' });
      const r2 = manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_2' });
      manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_3' });

      manager.activateDiscussion(r1.id, 'oc_d1');
      manager.activateDiscussion(r2.id, 'oc_d2');
      // third stays in creating

      expect(manager.listActiveDiscussions()).toHaveLength(2);
    });
  });

  describe('isDiscussionChat', () => {
    it('should return true for active discussion chats', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      manager.activateDiscussion(record.id, 'oc_discussion');

      expect(manager.isDiscussionChat('oc_discussion')).toBe(true);
    });

    it('should return false for non-discussion chats', () => {
      expect(manager.isDiscussionChat('oc_random')).toBe(false);
    });

    it('should return false for concluded discussions', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      manager.activateDiscussion(record.id, 'oc_discussion');
      manager.concludeDiscussion({
        chatId: 'oc_discussion',
        result: sampleResult,
      });

      expect(manager.isDiscussionChat('oc_discussion')).toBe(false);
    });
  });

  describe('expireStaleDiscussions', () => {
    it('should expire discussions older than max duration', () => {
      // Create manager with very short max duration for testing
      const shortLivedManager = new DiscussionManager({
        defaultMaxDurationMinutes: 0, // Instant expiry
      });

      const record = shortLivedManager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      shortLivedManager.activateDiscussion(record.id, 'oc_discussion');

      // Small delay to ensure time has passed
      const expired = shortLivedManager.expireStaleDiscussions();

      expect(expired).toBe(1);
      expect(shortLivedManager.getDiscussion(record.id)!.status).toBe('expired');

      shortLivedManager.dispose();
    });

    it('should not expire recent discussions', () => {
      const longLivedManager = new DiscussionManager({
        defaultMaxDurationMinutes: 999999,
      });

      const record = longLivedManager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });
      longLivedManager.activateDiscussion(record.id, 'oc_discussion');

      const expired = longLivedManager.expireStaleDiscussions();
      expect(expired).toBe(0);

      longLivedManager.dispose();
    });
  });

  describe('getStatusCounts', () => {
    it('should count discussions by status', () => {
      const r1 = manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_1' });
      const r2 = manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_2' });
      manager.createDiscussion({ topic: sampleTopic, sourceChatId: 'oc_3' });

      manager.activateDiscussion(r1.id, 'oc_d1');
      manager.activateDiscussion(r2.id, 'oc_d2');
      manager.concludeDiscussion({
        chatId: 'oc_d1',
        result: sampleResult,
      });

      const counts = manager.getStatusCounts();
      expect(counts.creating).toBe(1); // r3
      expect(counts.active).toBe(1);    // r2
      expect(counts.concluded).toBe(1); // r1
      expect(counts.expired).toBe(0);
    });
  });

  describe('removeDiscussion', () => {
    it('should remove a discussion record', () => {
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
      });

      expect(manager.removeDiscussion(record.id)).toBe(true);
      expect(manager.getDiscussion(record.id)).toBeUndefined();
    });

    it('should return false for non-existent discussion', () => {
      expect(manager.removeDiscussion('non-existent')).toBe(false);
    });
  });

  describe('full lifecycle', () => {
    it('should handle complete discussion lifecycle', () => {
      // 1. Create
      const record = manager.createDiscussion({
        topic: sampleTopic,
        sourceChatId: 'oc_source',
        creatorOpenId: 'ou_creator',
      });
      expect(record.status).toBe('creating');

      // 2. Activate
      const activated = manager.activateDiscussion(record.id, 'oc_discussion');
      expect(activated!.status).toBe('active');
      expect(activated!.chatId).toBe('oc_discussion');

      // 3. Query
      expect(manager.isDiscussionChat('oc_discussion')).toBe(true);
      expect(manager.findByChatId('oc_discussion')!.sourceChatId).toBe('oc_source');

      // 4. Conclude
      const concluded = manager.concludeDiscussion({
        chatId: 'oc_discussion',
        result: sampleResult,
      });
      expect(concluded!.status).toBe('concluded');
      expect(concluded!.result!.outcome).toBe('action_taken');

      // 5. Verify post-conclusion state
      expect(manager.isDiscussionChat('oc_discussion')).toBe(false);
      expect(manager.listActiveDiscussions()).toHaveLength(0);
    });
  });
});
