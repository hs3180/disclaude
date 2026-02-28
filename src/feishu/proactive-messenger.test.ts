/**
 * Tests for ProactiveMessenger.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import { ProactiveMessenger, createProactiveMessenger } from './proactive-messenger.js';
import { chatRegistry } from './chat-registry.js';
import fs from 'fs/promises';
import path from 'path';
import { Config } from '../config/index.js';

// Mock the lark client
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
}));

describe('ProactiveMessenger', () => {
  let messenger: ProactiveMessenger;
  let mockClient: { im: { message: { create: ReturnType<typeof vi.fn> } } };
  let testRegistryPath: string;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock client
    mockClient = {
      im: {
        message: {
          create: vi.fn().mockResolvedValue({ data: { message_id: 'msg_123' } }),
        },
      },
    };

    messenger = new ProactiveMessenger({
      client: mockClient as unknown as lark.Client,
    });

    // Clean up registry
    testRegistryPath = path.join(Config.getWorkspaceDir(), 'chat-registry.json');
    try {
      await fs.unlink(testRegistryPath);
    } catch {
      // File doesn't exist
    }

    // Clear the registry singleton
    await chatRegistry.clear();
  });

  afterEach(async () => {
    try {
      await fs.unlink(testRegistryPath);
    } catch {
      // File doesn't exist
    }
  });

  describe('sendMessage', () => {
    it('should send a text message to a chat', async () => {
      const result = await messenger.sendMessage('oc_test', 'Hello!');

      expect(result).toBe(true);
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test',
          msg_type: 'text',
          content: expect.stringContaining('Hello!'),
        },
      });
    });

    it('should return false when send fails', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('API error'));

      const result = await messenger.sendMessage('oc_test', 'Hello!');

      expect(result).toBe(false);
    });
  });

  describe('sendRecommendation', () => {
    it('should send a recommendation card', async () => {
      const recommendation = {
        taskType: 'GitHub Issues',
        pattern: 'User checks issues daily at 9am',
        suggestedCron: '0 9 * * *',
        confidence: 'High' as const,
        occurrenceCount: 5,
        suggestedPrompt: 'Check for new GitHub issues',
      };

      const result = await messenger.sendRecommendation('oc_test', recommendation);

      expect(result).toBe(true);
      expect(mockClient.im.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test',
          msg_type: 'interactive',
          content: expect.any(String),
        },
      });

      // Verify the card contains the task type
      const [call] = mockClient.im.message.create.mock.calls;
      const cardContent = JSON.stringify(call[0]);
      expect(JSON.stringify(cardContent)).toContain('GitHub Issues');
    });

    it('should return false when send fails', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('API error'));

      const recommendation = {
        taskType: 'Test',
        pattern: 'Test pattern',
        suggestedCron: '0 * * * *',
        confidence: 'Low' as const,
        occurrenceCount: 1,
        suggestedPrompt: 'Test prompt',
      };

      const result = await messenger.sendRecommendation('oc_test', recommendation);

      expect(result).toBe(false);
    });
  });

  describe('broadcast', () => {
    it('should send message to all enabled chats', async () => {
      // Register some chats
      await chatRegistry.register('oc_chat1', { enabled: true });
      await chatRegistry.register('oc_chat2', { enabled: true });
      await chatRegistry.register('oc_chat3', { enabled: false });

      const count = await messenger.broadcast('Broadcast message');

      expect(count).toBe(2);
      expect(mockClient.im.message.create).toHaveBeenCalledTimes(2);
    });

    it('should return 0 when no enabled chats', async () => {
      const count = await messenger.broadcast('No one to hear');

      expect(count).toBe(0);
      expect(mockClient.im.message.create).not.toHaveBeenCalled();
    });
  });

  describe('getEnabledChats', () => {
    it('should return enabled chats from registry', async () => {
      await chatRegistry.register('oc_enabled', { enabled: true, chatName: 'Enabled Chat' });

      const chats = await messenger.getEnabledChats();

      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('oc_enabled');
    });
  });

  describe('registerChat', () => {
    it('should register a chat for proactive messaging', async () => {
      await messenger.registerChat('oc_new', { userId: 'ou_user', chatName: 'New Chat' });

      const chat = await chatRegistry.get('oc_new');
      expect(chat).toBeDefined();
      expect(chat?.userId).toBe('ou_user');
      expect(chat?.chatName).toBe('New Chat');
    });
  });

  describe('createProactiveMessenger', () => {
    it('should create a ProactiveMessenger instance', () => {
      const instance = createProactiveMessenger(mockClient as unknown as lark.Client);

      expect(instance).toBeInstanceOf(ProactiveMessenger);
    });
  });
});
