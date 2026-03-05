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
import type * as lark from '@larksuiteoapi/node-sdk';
import { GroupService, type GroupInfo } from './group-service.js';

// Mock lark Client
const createMockClient = (chatId: string = 'oc_new123'): lark.Client => {
  return {
    im: {
      chat: {
        create: vi.fn().mockResolvedValue({
          data: { chat_id: chatId },
        }),
      },
    },
  } as unknown as lark.Client;
};

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
    it('should create a group and auto-register', async () => {
      const mockClient = createMockClient('oc_created123');

      const groupInfo = await service.createGroup(mockClient, {
        topic: 'Test Discussion',
        members: ['ou_user1', 'ou_user2'],
      });

      expect(groupInfo.chatId).toBe('oc_created123');
      expect(groupInfo.name).toBe('Test Discussion');
      expect(groupInfo.initialMembers).toEqual(['ou_user1', 'ou_user2']);
      expect(groupInfo.createdAt).toBeDefined();

      // Verify auto-registration
      expect(service.isManaged('oc_created123')).toBe(true);
      expect(service.getGroup('oc_created123')).toEqual(groupInfo);
    });

    it('should use creatorId when no members provided', async () => {
      const mockClient = createMockClient('oc_created456');

      const groupInfo = await service.createGroup(mockClient, {
        topic: 'Creator Only',
        creatorId: 'ou_creator',
      });

      expect(groupInfo.initialMembers).toEqual(['ou_creator']);
      expect(groupInfo.createdBy).toBe('ou_creator');
    });

    it('should use members over creatorId', async () => {
      const mockClient = createMockClient('oc_created789');

      const groupInfo = await service.createGroup(mockClient, {
        topic: 'With Members',
        members: ['ou_member1'],
        creatorId: 'ou_creator',
      });

      expect(groupInfo.initialMembers).toEqual(['ou_member1']);
      expect(groupInfo.createdBy).toBe('ou_creator');
    });

    it('should use default name when topic not provided', async () => {
      const mockClient = createMockClient('oc_created000');

      const groupInfo = await service.createGroup(mockClient, {});

      expect(groupInfo.name).toBe('自动命名');
    });

    it('should throw error if chat creation fails', async () => {
      const mockClient = {
        im: {
          chat: {
            create: vi.fn().mockRejectedValue(new Error('API Error')),
          },
        },
      } as unknown as lark.Client;

      await expect(service.createGroup(mockClient, { topic: 'Test' })).rejects.toThrow('API Error');

      // Verify no registration happened
      expect(service.listGroups()).toEqual([]);
    });

    it('should throw error if response has no chat_id', async () => {
      const mockClient = {
        im: {
          chat: {
            create: vi.fn().mockResolvedValue({ data: {} }),
          },
        },
      } as unknown as lark.Client;

      await expect(service.createGroup(mockClient, { topic: 'Test' })).rejects.toThrow('Failed to get chat_id');
    });
  });
});
