/**
 * Tests for AdminStatusManager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  AdminStatusManager,
  getAdminStatusManager,
  resetAdminStatusManager,
} from './admin-status-manager.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('AdminStatusManager', () => {
  let manager: AdminStatusManager;
  const testStoragePath = '/tmp/test-admin-status.json';

  beforeEach(() => {
    // Reset singleton
    resetAdminStatusManager();

    // Create manager with test storage path
    manager = new AdminStatusManager({ storagePath: testStoragePath });

    // Clean up test file if exists
    if (fs.existsSync(testStoragePath)) {
      fs.unlinkSync(testStoragePath);
    }
  });

  afterEach(() => {
    // Clean up test file
    if (fs.existsSync(testStoragePath)) {
      fs.unlinkSync(testStoragePath);
    }
  });

  describe('initialize', () => {
    it('should initialize with empty storage when no file exists', async () => {
      await manager.initialize();

      const status = manager.getAdminStatus('user_123');
      expect(status).toBeUndefined();
    });

    it('should load existing storage from file', async () => {
      // Create a test storage file
      const testData = {
        version: 1,
        users: {
          user_123: {
            userId: 'user_123',
            enabled: true,
            logChatId: 'chat_456',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };

      fs.writeFileSync(testStoragePath, JSON.stringify(testData));

      await manager.initialize();

      const status = manager.getAdminStatus('user_123');
      expect(status).toBeDefined();
      expect(status?.enabled).toBe(true);
      expect(status?.logChatId).toBe('chat_456');
    });
  });

  describe('enableAdmin', () => {
    it('should enable admin mode for a user', async () => {
      const status = await manager.enableAdmin('user_123', 'chat_456');

      expect(status.userId).toBe('user_123');
      expect(status.enabled).toBe(true);
      expect(status.logChatId).toBe('chat_456');
      expect(status.createdAt).toBeDefined();
      expect(status.updatedAt).toBeDefined();
    });

    it('should persist admin status to file', async () => {
      await manager.enableAdmin('user_123', 'chat_456');

      // Read file and verify
      const content = fs.readFileSync(testStoragePath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.users['user_123']).toBeDefined();
      expect(data.users['user_123'].enabled).toBe(true);
    });

    it('should preserve existing logChatId if not provided', async () => {
      await manager.enableAdmin('user_123', 'chat_456');
      await manager.disableAdmin('user_123');

      const status = await manager.enableAdmin('user_123');

      expect(status.logChatId).toBe('chat_456');
    });
  });

  describe('disableAdmin', () => {
    it('should disable admin mode for a user', async () => {
      await manager.enableAdmin('user_123', 'chat_456');
      const status = await manager.disableAdmin('user_123');

      expect(status?.enabled).toBe(false);
    });

    it('should return undefined if user was not admin', async () => {
      const status = await manager.disableAdmin('nonexistent');

      expect(status).toBeUndefined();
    });
  });

  describe('getAdminStatus', () => {
    it('should return undefined for non-existent user', () => {
      const status = manager.getAdminStatus('nonexistent');
      expect(status).toBeUndefined();
    });

    it('should return status for existing user', async () => {
      await manager.enableAdmin('user_123', 'chat_456');

      const status = manager.getAdminStatus('user_123');

      expect(status).toBeDefined();
      expect(status?.userId).toBe('user_123');
    });
  });

  describe('isAdminEnabled', () => {
    it('should return false for non-existent user', () => {
      expect(manager.isAdminEnabled('nonexistent')).toBe(false);
    });

    it('should return true for enabled user', async () => {
      await manager.enableAdmin('user_123');

      expect(manager.isAdminEnabled('user_123')).toBe(true);
    });

    it('should return false for disabled user', async () => {
      await manager.enableAdmin('user_123');
      await manager.disableAdmin('user_123');

      expect(manager.isAdminEnabled('user_123')).toBe(false);
    });
  });

  describe('getLogChatId', () => {
    it('should return undefined for non-existent user', () => {
      expect(manager.getLogChatId('nonexistent')).toBeUndefined();
    });

    it('should return log chat ID for user', async () => {
      await manager.enableAdmin('user_123', 'chat_456');

      expect(manager.getLogChatId('user_123')).toBe('chat_456');
    });
  });

  describe('setLogChatId', () => {
    it('should set log chat ID for user', async () => {
      const status = await manager.setLogChatId('user_123', 'chat_789');

      expect(status.logChatId).toBe('chat_789');
      expect(status.enabled).toBe(false); // Should not enable admin
    });

    it('should update existing log chat ID', async () => {
      await manager.enableAdmin('user_123', 'chat_456');
      const status = await manager.setLogChatId('user_123', 'chat_789');

      expect(status.logChatId).toBe('chat_789');
      expect(status.enabled).toBe(true); // Should preserve enabled status
    });
  });

  describe('getAllAdmins', () => {
    it('should return empty array when no admins', () => {
      const admins = manager.getAllAdmins();
      expect(admins).toEqual([]);
    });

    it('should return all enabled admins', async () => {
      await manager.enableAdmin('user_1');
      await manager.enableAdmin('user_2');
      await manager.enableAdmin('user_3');
      await manager.disableAdmin('user_2');

      const admins = manager.getAllAdmins();

      expect(admins.length).toBe(2);
      expect(admins.map((a) => a.userId).sort()).toEqual(['user_1', 'user_3']);
    });
  });

  describe('removeAdmin', () => {
    it('should remove admin status entirely', async () => {
      await manager.enableAdmin('user_123', 'chat_456');
      await manager.removeAdmin('user_123');

      expect(manager.getAdminStatus('user_123')).toBeUndefined();
    });
  });

  describe('clearAll', () => {
    it('should clear all admin statuses', async () => {
      await manager.enableAdmin('user_1');
      await manager.enableAdmin('user_2');
      await manager.clearAll();

      expect(manager.getAllAdmins()).toEqual([]);
    });
  });
});

describe('getAdminStatusManager', () => {
  beforeEach(() => {
    resetAdminStatusManager();
  });

  it('should return singleton instance', () => {
    const instance1 = getAdminStatusManager();
    const instance2 = getAdminStatusManager();

    expect(instance1).toBe(instance2);
  });

  it('should reset singleton', () => {
    const instance1 = getAdminStatusManager();
    resetAdminStatusManager();
    const instance2 = getAdminStatusManager();

    expect(instance1).not.toBe(instance2);
  });
});
