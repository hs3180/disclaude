/**
 * Tests for GroupService.
 *
 * @see Issue #486 - Group management commands
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
});
