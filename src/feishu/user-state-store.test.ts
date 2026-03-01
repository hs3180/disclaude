/**
 * Tests for UserStateStore.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { UserStateStore } from './user-state-store.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace-user-state',
  },
}));

describe('UserStateStore', () => {
  let store: UserStateStore;
  const testDir = '/tmp/test-workspace-user-state';

  beforeEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    await fs.mkdir(testDir, { recursive: true });

    store = new UserStateStore();
    await store.init();
  });

  afterEach(async () => {
    store.clear();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('get', () => {
    it('should return undefined for non-existent user', () => {
      const state = store.get('non-existent-user');
      expect(state).toBeUndefined();
    });
  });

  describe('getOrCreate', () => {
    it('should create new state for non-existent user', () => {
      const state = store.getOrCreate('user-1', 'chat-1');
      expect(state).toBeDefined();
      expect(state.userId).toBe('user-1');
      expect(state.chatId).toBe('chat-1');
      expect(state.adminModeEnabled).toBe(false);
    });

    it('should return existing state for existing user', async () => {
      await store.setAdminMode('user-1', true);
      const state = store.getOrCreate('user-1', 'chat-1');
      expect(state.adminModeEnabled).toBe(true);
    });
  });

  describe('setAdminMode', () => {
    it('should enable admin mode', async () => {
      const state = await store.setAdminMode('user-1', true);
      expect(state.adminModeEnabled).toBe(true);
    });

    it('should disable admin mode', async () => {
      await store.setAdminMode('user-1', true);
      const state = await store.setAdminMode('user-1', false);
      expect(state.adminModeEnabled).toBe(false);
    });

    it('should store log chat ID', async () => {
      const state = await store.setAdminMode('user-1', true, 'log-chat-1');
      expect(state.logChatId).toBe('log-chat-1');
    });

    it('should persist state to file', async () => {
      await store.setAdminMode('user-1', true);

      // Create new store to verify persistence
      const newStore = new UserStateStore();
      await newStore.init();
      expect(newStore.isAdminModeEnabled('user-1')).toBe(true);
    });
  });

  describe('isAdminModeEnabled', () => {
    it('should return false for non-existent user', () => {
      expect(store.isAdminModeEnabled('non-existent')).toBe(false);
    });

    it('should return true when admin mode is enabled', async () => {
      await store.setAdminMode('user-1', true);
      expect(store.isAdminModeEnabled('user-1')).toBe(true);
    });
  });

  describe('getLogChatId', () => {
    it('should return undefined when admin mode is disabled', async () => {
      await store.setAdminMode('user-1', false, 'log-chat-1');
      expect(store.getLogChatId('user-1')).toBeUndefined();
    });

    it('should return log chat ID when admin mode is enabled', async () => {
      await store.setAdminMode('user-1', true, 'log-chat-1');
      expect(store.getLogChatId('user-1')).toBe('log-chat-1');
    });
  });

  describe('getAdminUsers', () => {
    it('should return empty array when no admin users', () => {
      expect(store.getAdminUsers()).toHaveLength(0);
    });

    it('should return all admin users', async () => {
      await store.setAdminMode('user-1', true);
      await store.setAdminMode('user-2', true);
      await store.setAdminMode('user-3', false);

      const adminUsers = store.getAdminUsers();
      expect(adminUsers).toHaveLength(2);
      expect(adminUsers.map((u) => u.userId)).toContain('user-1');
      expect(adminUsers.map((u) => u.userId)).toContain('user-2');
    });
  });

  describe('update', () => {
    it('should update user state', async () => {
      await store.setAdminMode('user-1', true);
      const state = await store.update('user-1', { metadata: { foo: 'bar' } });
      expect(state.metadata?.foo).toBe('bar');
    });

    it('should throw error for non-existent user', async () => {
      await expect(store.update('non-existent', { adminModeEnabled: true })).rejects.toThrow();
    });
  });

  describe('remove', () => {
    it('should remove user state', async () => {
      await store.setAdminMode('user-1', true);
      await store.remove('user-1');
      expect(store.get('user-1')).toBeUndefined();
    });
  });
});
