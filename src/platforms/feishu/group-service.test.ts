/**
 * Tests for GroupService.
 *
 * @see Issue #486 - Group management commands
 * @see Issue #692 - GroupService.createGroup() method
 */

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
        createdAt: 1700000000000,
        createdBy: 'ou_creator',
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
        chatId: 'oc_test123',
        name: 'Test',
        createdAt: Date.now(),
        initialMembers: [],
      });

      expect(service.isManaged('oc_test123')).toBe(true);
    });

    it('should return false for unmanaged group', () => {
      expect(service.isManaged('oc_nonexistent')).toBe(false);
    });
  });

  describe('listGroups', () => {
    it('should return empty array when no groups', () => {
      expect(service.listGroups()).toEqual([]);
    });

    it('should return all registered groups', () => {
      const groups: GroupInfo[] = [
        { chatId: 'oc_1', name: 'Group 1', createdAt: 1700000000000, initialMembers: [] },
        { chatId: 'oc_2', name: 'Group 2', createdAt: 1700000001000, initialMembers: [] },
        { chatId: 'oc_3', name: 'Group 3', createdAt: 1700000002000, initialMembers: [] },
      ];

      groups.forEach(g => service.registerGroup(g));

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
        creatorId: 'ou_creator',
      });

      expect(result.name).toBe('自动命名');
    });

    it('should propagate errors from createDiscussionChat', async () => {
      const service = new GroupService({ filePath: testFilePath });
      const mockCreateDiscussionChat = vi.mocked(chatOps.createDiscussionChat);
      mockCreateDiscussionChat.mockRejectedValue(new Error('API Error'));

      await expect(service.createGroup(mockClient, {
        topic: 'Test Group',
      })).rejects.toThrow('API Error');
    });
  });

  // Issue #721: Topic group tests
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

  // Issue #1229: Discussion status tests
  describe('startDiscussion', () => {
    it('should start a discussion in a group', () => {
      const info: GroupInfo = {
        chatId: 'oc_discussion_test',
        name: 'Discussion Group',
        createdAt: Date.now(),
        initialMembers: [],
      };

      service.registerGroup(info);
      const result = service.startDiscussion('oc_discussion_test', 'Test Topic', 'Test Context');

      expect(result).toBe(true);
      const discussion = service.getDiscussion('oc_discussion_test');
      expect(discussion).toBeDefined();
      expect(discussion?.topic).toBe('Test Topic');
      expect(discussion?.context).toBe('Test Context');
      expect(discussion?.status).toBe('active');
      expect(discussion?.startedAt).toBeDefined();
    });

    it('should return false for non-existent group', () => {
      const result = service.startDiscussion('oc_nonexistent', 'Topic');
      expect(result).toBe(false);
    });

    it('should work without context', () => {
      service.registerGroup({
        chatId: 'oc_no_context',
        name: 'No Context Group',
        createdAt: Date.now(),
        initialMembers: [],
      });

      const result = service.startDiscussion('oc_no_context', 'Topic Only');
      expect(result).toBe(true);

      const discussion = service.getDiscussion('oc_no_context');
      expect(discussion?.context).toBeUndefined();
    });
  });

  describe('getDiscussion', () => {
    it('should return undefined for group without discussion', () => {
      service.registerGroup({
        chatId: 'oc_no_discussion',
        name: 'No Discussion',
        createdAt: Date.now(),
        initialMembers: [],
      });

      expect(service.getDiscussion('oc_no_discussion')).toBeUndefined();
    });

    it('should return undefined for non-existent group', () => {
      expect(service.getDiscussion('oc_nonexistent')).toBeUndefined();
    });
  });

  describe('hasActiveDiscussion', () => {
    it('should return true for active discussion', () => {
      service.registerGroup({
        chatId: 'oc_active',
        name: 'Active Discussion',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_active', 'Active Topic');

      expect(service.hasActiveDiscussion('oc_active')).toBe(true);
    });

    it('should return false for concluded discussion', () => {
      service.registerGroup({
        chatId: 'oc_concluded',
        name: 'Concluded Discussion',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_concluded', 'Topic');
      service.concludeDiscussion('oc_concluded', 'Done');

      expect(service.hasActiveDiscussion('oc_concluded')).toBe(false);
    });

    it('should return false for group without discussion', () => {
      service.registerGroup({
        chatId: 'oc_no_disc',
        name: 'No Discussion',
        createdAt: Date.now(),
        initialMembers: [],
      });

      expect(service.hasActiveDiscussion('oc_no_disc')).toBe(false);
    });
  });

  describe('concludeDiscussion', () => {
    it('should conclude an active discussion', () => {
      service.registerGroup({
        chatId: 'oc_conclude',
        name: 'To Conclude',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_conclude', 'Topic');

      const result = service.concludeDiscussion('oc_conclude', 'Final conclusion');

      expect(result).toBe(true);
      const discussion = service.getDiscussion('oc_conclude');
      expect(discussion?.status).toBe('concluded');
      expect(discussion?.conclusion).toBe('Final conclusion');
      expect(discussion?.concludedAt).toBeDefined();
    });

    it('should include follow-up actions', () => {
      service.registerGroup({
        chatId: 'oc_followup',
        name: 'With Follow-up',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_followup', 'Topic');

      const result = service.concludeDiscussion(
        'oc_followup',
        'Done',
        ['Action 1', 'Action 2']
      );

      expect(result).toBe(true);
      const discussion = service.getDiscussion('oc_followup');
      expect(discussion?.followUpActions).toEqual(['Action 1', 'Action 2']);
    });

    it('should return false for group without discussion', () => {
      service.registerGroup({
        chatId: 'oc_no_disc',
        name: 'No Discussion',
        createdAt: Date.now(),
        initialMembers: [],
      });

      const result = service.concludeDiscussion('oc_no_disc', 'Conclusion');
      expect(result).toBe(false);
    });

    it('should return false for non-existent group', () => {
      const result = service.concludeDiscussion('oc_nonexistent', 'Conclusion');
      expect(result).toBe(false);
    });
  });

  describe('abandonDiscussion', () => {
    it('should abandon an active discussion', () => {
      service.registerGroup({
        chatId: 'oc_abandon',
        name: 'To Abandon',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_abandon', 'Topic');

      const result = service.abandonDiscussion('oc_abandon', 'No longer needed');

      expect(result).toBe(true);
      const discussion = service.getDiscussion('oc_abandon');
      expect(discussion?.status).toBe('abandoned');
      expect(discussion?.conclusion).toBe('已放弃: No longer needed');
    });

    it('should work without reason', () => {
      service.registerGroup({
        chatId: 'oc_abandon_no_reason',
        name: 'Abandon No Reason',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_abandon_no_reason', 'Topic');

      const result = service.abandonDiscussion('oc_abandon_no_reason');

      expect(result).toBe(true);
      const discussion = service.getDiscussion('oc_abandon_no_reason');
      expect(discussion?.status).toBe('abandoned');
      expect(discussion?.conclusion).toBeUndefined();
    });

    it('should return false for group without discussion', () => {
      service.registerGroup({
        chatId: 'oc_no_disc_abandon',
        name: 'No Discussion',
        createdAt: Date.now(),
        initialMembers: [],
      });

      const result = service.abandonDiscussion('oc_no_disc_abandon');
      expect(result).toBe(false);
    });
  });

  describe('listActiveDiscussions', () => {
    it('should return only groups with active discussions', () => {
      // Register groups with different discussion states
      service.registerGroup({
        chatId: 'oc_active1',
        name: 'Active 1',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_active1', 'Topic 1');

      service.registerGroup({
        chatId: 'oc_concluded1',
        name: 'Concluded 1',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_concluded1', 'Topic 2');
      service.concludeDiscussion('oc_concluded1', 'Done');

      service.registerGroup({
        chatId: 'oc_active2',
        name: 'Active 2',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_active2', 'Topic 3');

      service.registerGroup({
        chatId: 'oc_no_disc',
        name: 'No Discussion',
        createdAt: Date.now(),
        initialMembers: [],
      });

      const activeDiscussions = service.listActiveDiscussions();
      expect(activeDiscussions.length).toBe(2);
      expect(activeDiscussions.map(g => g.chatId).sort()).toEqual(['oc_active1', 'oc_active2']);
    });

    it('should return empty array when no active discussions', () => {
      service.registerGroup({
        chatId: 'oc_only_concluded',
        name: 'Only Concluded',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_only_concluded', 'Topic');
      service.concludeDiscussion('oc_only_concluded', 'Done');

      expect(service.listActiveDiscussions()).toEqual([]);
    });
  });

  describe('discussion persistence', () => {
    it('should persist discussion status', () => {
      service.registerGroup({
        chatId: 'oc_persist_disc',
        name: 'Persist Discussion',
        createdAt: Date.now(),
        initialMembers: [],
      });
      service.startDiscussion('oc_persist_disc', 'Persistent Topic', 'Context');
      service.concludeDiscussion('oc_persist_disc', 'Final Conclusion', ['Action 1']);

      // Create a new service instance to verify persistence
      const newService = new GroupService({ filePath: testFilePath });
      const discussion = newService.getDiscussion('oc_persist_disc');

      expect(discussion).toBeDefined();
      expect(discussion?.topic).toBe('Persistent Topic');
      expect(discussion?.context).toBe('Context');
      expect(discussion?.status).toBe('concluded');
      expect(discussion?.conclusion).toBe('Final Conclusion');
      expect(discussion?.followUpActions).toEqual(['Action 1']);
    });
  });
});
