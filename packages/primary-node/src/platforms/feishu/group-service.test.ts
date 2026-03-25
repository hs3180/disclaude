/**
 * Tests for GroupService.
 *
 * @see Issue #486 - Group management commands
 * @see Issue #692 - GroupService.createGroup() method
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GroupService, type GroupInfo } from './group-service.js';
import * as chatOps from './chat-ops.js';

vi.mock('./chat-ops.js', () => ({
  createDiscussionChat: vi.fn(),
}));

describe('GroupService', () => {
  let tempDir: string;
  let testFilePath: string;
  let service: GroupService;

  beforeEach(() => {
    // Create a temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-service-test-'));
    testFilePath = path.join(tempDir, 'groups.json');
    service = new GroupService({ filePath: testFilePath });
  });

  afterEach(() => {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('registerGroup', () => {
    it('should register a new group', () => {
        const info: GroupInfo = {
          chatId: 'oc_test123',
          name: 'Test Group',
          createdAt: Date.now(),
          initialMembers: ['ou_user1', 'ou_user2'],
        };

        service.registerGroup(info);

        expect(service.isManaged('oc_test123')).toBe(true);
        expect(service.getGroup('oc_test123')).toEqual(info);
    });

    it('should persist group to file', () => {
      const info: GroupInfo = {
        chatId: 'oc_test123',
        name: 'Test Group',
        createdAt: Date.now(),
        initialMembers: ['ou_user1'],
      };

      service.registerGroup(info);

      // Create a new service instance to verify persistence
      const newService = new GroupService({ filePath: testFilePath });
      expect(newService.getGroup('oc_test123')).toEqual(info);
    });

    it('should update existing group', () => {
      const info1: GroupInfo = {
        chatId: 'oc_test123',
        name: 'Original Name',
        createdAt: Date.now(),
        initialMembers: ['ou_user1'],
      };

      service.registerGroup(info1);

      const info2: GroupInfo = {
        chatId: 'oc_test123',
        name: 'Updated Name',
        createdAt: Date.now(),
        initialMembers: ['ou_user1', 'ou_user2'],
      };

      service.registerGroup(info2);

      expect(service.getGroup('oc_test123')?.name).toBe('Updated Name');
      expect(service.listGroups().length).toBe(1);
    });
  });

  describe('unregisterGroup', () => {
    it('should unregister an existing group', () => {
      const info: GroupInfo = {
        chatId: 'oc_test123',
        name: 'Test Group',
        createdAt: Date.now(),
        initialMembers: [],
      };

      service.registerGroup(info);
      expect(service.isManaged('oc_test123')).toBe(true);

      const result = service.unregisterGroup('oc_test123');

      expect(result).toBe(true);
      expect(service.isManaged('oc_test123')).toBe(false);
    });

    it('should return false for non-existent group', () => {
      const result = service.unregisterGroup('oc_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getGroup', () => {
    it('should return group info for existing group', () => {
      const info: GroupInfo = {
        chatId: 'oc_test123',
        name: 'Test Group',
        createdAt: Date.now(),
        initialMembers: ['ou_user1'],
      };

      service.registerGroup(info);

      expect(service.getGroup('oc_test123')).toEqual(info);
    });

    it('should return undefined for non-existent group', () => {
      expect(service.getGroup('oc_nonexistent')).toBeUndefined();
    });
  });

  describe('isManaged', () => {
    it('should return true for managed group', () => {
      service.registerGroup({
        chatId: 'oc_test',
        name: 'Test',
        createdAt: Date.now(),
        initialMembers: [],
      });

      expect(service.isManaged('oc_test')).toBe(true);
    });

    it('should return false for unmanaged group', () => {
      expect(service.isManaged('oc_unmanaged')).toBe(false);
    });
  });

  describe('listGroups', () => {
    it('should return empty array when no groups', () => {
      expect(service.listGroups()).toEqual([]);
    });

    it('should return all registered groups', () => {
      service.registerGroup({
        chatId: 'oc_1',
        name: 'Group 1',
        createdAt: Date.now(),
        initialMembers: [],
      });

      service.registerGroup({
        chatId: 'oc_2',
        name: 'Group 2',
        createdAt: Date.now(),
        initialMembers: [],
      });

      service.registerGroup({
        chatId: 'oc_3',
        name: 'Group 3',
        createdAt: Date.now(),
        initialMembers: [],
      });

      const listed = service.listGroups();

      expect(listed.length).toBe(3);
      expect(listed.map(g => g.chatId).sort()).toEqual(['oc_1', 'oc_2', 'oc_3']);
    });
  });


  describe('persistence', () => {
    it('should handle corrupted file gracefully', () => {
      // Write invalid JSON
      fs.writeFileSync(testFilePath, 'not valid json');

      // Should not throw and start with empty registry
      const newService = new GroupService({ filePath: testFilePath });
      expect(newService.listGroups()).toEqual([]);
    });

    it('should handle missing file gracefully', () => {
      const missingPath = path.join(tempDir, 'nonexistent', 'groups.json');
      const newService = new GroupService({ filePath: missingPath });

      // Should start with empty registry
      expect(newService.listGroups()).toEqual([]);
    });

    it('should create directory if not exists', () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'groups.json');
      const newService = new GroupService({ filePath: nestedPath });

      newService.registerGroup({
        chatId: 'oc_test',
        name: 'Test',
        createdAt: Date.now(),
        initialMembers: [],
      });

      expect(fs.existsSync(nestedPath)).toBe(true);
    });
  });

  describe('getFilePath', () => {
    it('should return the configured file path', () => {
      expect(service.getFilePath()).toBe(testFilePath);
    });
  });

  describe('createGroup', () => {
    const mockClient = {} as any;

    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('should create group and register it', async () => {
      const service = new GroupService({ filePath: testFilePath });
      const mockCreateDiscussionChat = vi.mocked(chatOps.createDiscussionChat);
      mockCreateDiscussionChat.mockResolvedValue('oc_created_123');

      const result = await service.createGroup(mockClient, {
        topic: 'Test Group',
        members: ['ou_user1', 'ou_user2'],
        creatorId: 'ou_creator',
      });

      expect(mockCreateDiscussionChat).toHaveBeenCalledWith(
        mockClient,
        { topic: 'Test Group', members: ['ou_user1', 'ou_user2'] },
        'ou_creator'
      );

      expect(result).toEqual({
        chatId: 'oc_created_123',
        name: 'Test Group',
        createdAt: expect.any(Number),
        createdBy: 'ou_creator',
        initialMembers: ['ou_user1', 'ou_user2'],
      });

      // Verify group is registered
      expect(service.getGroup('oc_created_123')).toEqual({
        chatId: 'oc_created_123',
        name: 'Test Group',
        createdAt: expect.any(Number),
        createdBy: 'ou_creator',
        initialMembers: ['ou_user1', 'ou_user2'],
      });
    });

    it('should auto-add creator if no members specified', async () => {
      const service = new GroupService({ filePath: testFilePath });
      const mockCreateDiscussionChat = vi.mocked(chatOps.createDiscussionChat);
      mockCreateDiscussionChat.mockResolvedValue('oc_created_456');

      const result = await service.createGroup(mockClient, {
        topic: 'Auto Add Test',
        creatorId: 'ou_creator',
      });

      expect(mockCreateDiscussionChat).toHaveBeenCalledWith(
        mockClient,
        { topic: 'Auto Add Test', members: undefined },
        'ou_creator'
      );

      expect(result.initialMembers).toEqual(['ou_creator']);
    });

    it('should use default name if topic not provided', async () => {
      const service = new GroupService({ filePath: testFilePath });
      const mockCreateDiscussionChat = vi.mocked(chatOps.createDiscussionChat);
      mockCreateDiscussionChat.mockResolvedValue('oc_created_789');

      const result = await service.createGroup(mockClient, {
        members: ['ou_user1'],
      });

      expect(result.name).toBe('自动命名');
    });
  });

  describe('markAsTopicGroup', () => {
    it('should mark a group as topic group', () => {
      const info: GroupInfo = {
        chatId: 'oc_topic_test',
        name: 'Topic Group',
        createdAt: Date.now(),
        initialMembers: [],
      };

      service.registerGroup(info);
      const result = service.markAsTopicGroup('oc_topic_test', true);

      expect(result).toBe(true);
      expect(service.getGroup('oc_topic_test')?.isTopicGroup).toBe(true);
    });

    it('should unmark a topic group', () => {
      const info: GroupInfo = {
        chatId: 'oc_topic_test',
        name: 'Topic Group',
        createdAt: Date.now(),
        initialMembers: [],
        isTopicGroup: true,
      };

      service.registerGroup(info);
      const result = service.markAsTopicGroup('oc_topic_test', false);

      expect(result).toBe(true);
      expect(service.getGroup('oc_topic_test')?.isTopicGroup).toBeUndefined();
    });

    it('should return false for non-existent group', () => {
      const result = service.markAsTopicGroup('oc_nonexistent', true);
      expect(result).toBe(false);
    });

    it('should default to marking as topic group', () => {
      const info: GroupInfo = {
        chatId: 'oc_topic_default',
        name: 'Topic Group Default',
        createdAt: Date.now(),
        initialMembers: [],
      };

      service.registerGroup(info);
      const result = service.markAsTopicGroup('oc_topic_default');

      expect(result).toBe(true);
      expect(service.getGroup('oc_topic_default')?.isTopicGroup).toBe(true);
    });

    it('should persist topic group status', () => {
      const info: GroupInfo = {
        chatId: 'oc_topic_persist',
        name: 'Topic Group Persist',
        createdAt: Date.now(),
        initialMembers: [],
      };

      service.registerGroup(info);
      service.markAsTopicGroup('oc_topic_persist', true);

      // Create a new service instance to verify persistence
      const newService = new GroupService({ filePath: testFilePath });
      expect(newService.getGroup('oc_topic_persist')?.isTopicGroup).toBe(true);
    });
  });

  describe('isTopicGroup', () => {
    it('should return true for topic group', () => {
      service.registerGroup({
        chatId: 'oc_topic_true',
        name: 'Topic Group',
        createdAt: Date.now(),
        initialMembers: [],
        isTopicGroup: true,
      });

      expect(service.isTopicGroup('oc_topic_true')).toBe(true);
    });

    it('should return false for non-topic group', () => {
      service.registerGroup({
        chatId: 'oc_topic_false',
        name: 'Regular Group',
        createdAt: Date.now(),
        initialMembers: [],
      });

      expect(service.isTopicGroup('oc_topic_false')).toBe(false);
    });

    it('should return false for non-existent group', () => {
      expect(service.isTopicGroup('oc_nonexistent')).toBe(false);
    });
  });

  describe('listTopicGroups', () => {
    it('should return empty array when no topic groups', () => {
      service.registerGroup({
        chatId: 'oc_regular',
        name: 'Regular Group',
        createdAt: Date.now(),
        initialMembers: [],
      });

      expect(service.listTopicGroups()).toEqual([]);
    });

    it('should return only topic groups', () => {
      service.registerGroup({
        chatId: 'oc_regular1',
        name: 'Regular Group 1',
        createdAt: Date.now(),
        initialMembers: [],
      });

      service.registerGroup({
        chatId: 'oc_topic1',
        name: 'Topic Group 1',
        createdAt: Date.now(),
        initialMembers: [],
        isTopicGroup: true,
      });

      service.registerGroup({
        chatId: 'oc_regular2',
        name: 'Regular Group 2',
        createdAt: Date.now(),
        initialMembers: [],
      });

      service.registerGroup({
        chatId: 'oc_topic2',
        name: 'Topic Group 2',
        createdAt: Date.now(),
        initialMembers: [],
        isTopicGroup: true,
      });

      const topicGroups = service.listTopicGroups();
      expect(topicGroups.length).toBe(2);
      expect(topicGroups.map(g => g.chatId).sort()).toEqual(['oc_topic1', 'oc_topic2']);
    });
  });

  describe('soulPath management (Issue #1228)', () => {
    it('should set soulPath on a group', () => {
      service.registerGroup({
        chatId: 'oc_soul_test',
        name: 'Soul Group',
        createdAt: Date.now(),
        initialMembers: [],
      });

      const result = service.setSoulPath('oc_soul_test', '/path/to/soul.md');
      expect(result).toBe(true);
      expect(service.getGroup('oc_soul_test')?.soulPath).toBe('/path/to/soul.md');
    });

    it('should get soulPath from a group', () => {
      service.registerGroup({
        chatId: 'oc_soul_get',
        name: 'Soul Get Group',
        createdAt: Date.now(),
        initialMembers: [],
        soulPath: '/existing/soul.md',
      });

      expect(service.getSoulPath('oc_soul_get')).toBe('/existing/soul.md');
    });

    it('should return undefined for group without soulPath', () => {
      service.registerGroup({
        chatId: 'oc_no_soul',
        name: 'No Soul Group',
        createdAt: Date.now(),
        initialMembers: [],
      });

      expect(service.getSoulPath('oc_no_soul')).toBeUndefined();
    });

    it('should return undefined for non-existent group', () => {
      expect(service.getSoulPath('oc_nonexistent')).toBeUndefined();
    });

    it('should return false when setting soulPath on non-existent group', () => {
      const result = service.setSoulPath('oc_nonexistent', '/path/to/soul.md');
      expect(result).toBe(false);
    });

    it('should persist soulPath to file', () => {
      service.registerGroup({
        chatId: 'oc_soul_persist',
        name: 'Soul Persist Group',
        createdAt: Date.now(),
        initialMembers: [],
      });

      service.setSoulPath('oc_soul_persist', '/persisted/soul.md');

      // Create a new service instance to verify persistence
      const newService = new GroupService({ filePath: testFilePath });
      expect(newService.getSoulPath('oc_soul_persist')).toBe('/persisted/soul.md');
    });

    it('should update soulPath when set multiple times', () => {
      service.registerGroup({
        chatId: 'oc_soul_update',
        name: 'Soul Update Group',
        createdAt: Date.now(),
        initialMembers: [],
      });

      service.setSoulPath('oc_soul_update', '/first/soul.md');
      service.setSoulPath('oc_soul_update', '/second/soul.md');

      expect(service.getSoulPath('oc_soul_update')).toBe('/second/soul.md');
    });
  });

  describe('createGroup with soulPath (Issue #1228)', () => {
    const mockClient = {} as any;

    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('should include soulPath when provided', async () => {
      const service = new GroupService({ filePath: testFilePath });
      const mockCreateDiscussionChat = vi.mocked(chatOps.createDiscussionChat);
      mockCreateDiscussionChat.mockResolvedValue('oc_soul_created');

      const result = await service.createGroup(mockClient, {
        topic: 'Discussion Group',
        soulPath: '/path/to/discussion/soul.md',
      });

      expect(result.soulPath).toBe('/path/to/discussion/soul.md');
      expect(service.getSoulPath('oc_soul_created')).toBe('/path/to/discussion/soul.md');
    });

    it('should not include soulPath when not provided', async () => {
      const service = new GroupService({ filePath: testFilePath });
      const mockCreateDiscussionChat = vi.mocked(chatOps.createDiscussionChat);
      mockCreateDiscussionChat.mockResolvedValue('oc_no_soul_created');

      const result = await service.createGroup(mockClient, {
        topic: 'Regular Group',
      });

      expect(result.soulPath).toBeUndefined();
      expect(service.getSoulPath('oc_no_soul_created')).toBeUndefined();
    });
  });
});
