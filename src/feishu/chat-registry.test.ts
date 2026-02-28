/**
 * Tests for ChatRegistry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { ChatRegistry } from './chat-registry.js';
import { Config } from '../config/index.js';

describe('ChatRegistry', () => {
  let registry: ChatRegistry;
  let testRegistryPath: string;

  beforeEach(async () => {
    // Create a fresh registry instance for each test
    registry = new ChatRegistry();
    testRegistryPath = path.join(Config.getWorkspaceDir(), 'chat-registry.json');

    // Clean up any existing registry file
    try {
      await fs.unlink(testRegistryPath);
    } catch {
      // File doesn't exist, that's fine
    }
  });

  afterEach(async () => {
    // Clean up after each test
    try {
      await fs.unlink(testRegistryPath);
    } catch {
      // File doesn't exist, that's fine
    }
  });

  describe('init', () => {
    it('should initialize with empty registry when no file exists', async () => {
      await registry.init();
      const chats = await registry.getAll();
      expect(chats).toEqual([]);
    });

    it('should load existing chats from file', async () => {
      // Create a registry file manually
      const existingChats = [
        {
          chatId: 'oc_test1',
          userId: 'ou_user1',
          chatName: 'Test Chat 1',
          firstSeenAt: '2024-01-01T00:00:00Z',
          lastSeenAt: '2024-01-02T00:00:00Z',
          enabled: true,
        },
      ];
      await fs.mkdir(path.dirname(testRegistryPath), { recursive: true });
      await fs.writeFile(testRegistryPath, JSON.stringify(existingChats, null, 2));

      await registry.init();
      const chats = await registry.getAll();

      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('oc_test1');
      expect(chats[0].userId).toBe('ou_user1');
    });
  });

  describe('register', () => {
    it('should register a new chat', async () => {
      const chatInfo = await registry.register('oc_new', {
        userId: 'ou_user',
        chatName: 'New Chat',
      });

      expect(chatInfo.chatId).toBe('oc_new');
      expect(chatInfo.userId).toBe('ou_user');
      expect(chatInfo.chatName).toBe('New Chat');
      expect(chatInfo.enabled).toBe(true);
      expect(chatInfo.firstSeenAt).toBeDefined();
      expect(chatInfo.lastSeenAt).toBeDefined();
    });

    it('should update existing chat while preserving firstSeenAt', async () => {
      // Register first time
      const first = await registry.register('oc_update', { chatName: 'Original' });

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update the chat
      const updated = await registry.register('oc_update', { chatName: 'Updated' });

      expect(updated.chatName).toBe('Updated');
      expect(updated.firstSeenAt).toBe(first.firstSeenAt);
      expect(updated.lastSeenAt).not.toBe(first.lastSeenAt);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent chat', async () => {
      const chat = await registry.get('oc_nonexistent');
      expect(chat).toBeUndefined();
    });

    it('should return chat info for existing chat', async () => {
      await registry.register('oc_exists', { chatName: 'Exists' });
      const chat = await registry.get('oc_exists');

      expect(chat).toBeDefined();
      expect(chat?.chatName).toBe('Exists');
    });
  });

  describe('getEnabledChats', () => {
    it('should return only enabled chats', async () => {
      await registry.register('oc_enabled1', { enabled: true });
      await registry.register('oc_enabled2', { enabled: true });
      await registry.register('oc_disabled', { enabled: false });

      const enabled = await registry.getEnabledChats();

      expect(enabled).toHaveLength(2);
      expect(enabled.map((c) => c.chatId).sort()).toEqual(['oc_enabled1', 'oc_enabled2']);
    });
  });

  describe('setEnabled', () => {
    it('should enable/disable a chat', async () => {
      await registry.register('oc_toggle', { enabled: true });

      const result = await registry.setEnabled('oc_toggle', false);
      expect(result).toBe(true);

      const chat = await registry.get('oc_toggle');
      expect(chat?.enabled).toBe(false);
    });

    it('should return false for non-existent chat', async () => {
      const result = await registry.setEnabled('oc_nonexistent', true);
      expect(result).toBe(false);
    });
  });

  describe('remove', () => {
    it('should remove an existing chat', async () => {
      await registry.register('oc_remove', {});
      const result = await registry.remove('oc_remove');

      expect(result).toBe(true);

      const chat = await registry.get('oc_remove');
      expect(chat).toBeUndefined();
    });

    it('should return false for non-existent chat', async () => {
      const result = await registry.remove('oc_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('has', () => {
    it('should return true for existing chat', async () => {
      await registry.register('oc_has', {});
      const result = await registry.has('oc_has');
      expect(result).toBe(true);
    });

    it('should return false for non-existent chat', async () => {
      const result = await registry.has('oc_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('persistence', () => {
    it('should persist data to file', async () => {
      await registry.register('oc_persist', { chatName: 'Persistent' });

      // Create a new registry instance to test persistence
      const newRegistry = new ChatRegistry();
      await newRegistry.init();

      const chat = await newRegistry.get('oc_persist');
      expect(chat?.chatName).toBe('Persistent');
    });
  });
});
