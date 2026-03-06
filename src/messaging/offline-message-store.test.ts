/**
 * Tests for OfflineMessageStore.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import {
  OfflineMessageStore,
  getOfflineMessageStore,
  resetOfflineMessageStore,
  type OfflineMessageContext,
} from './offline-message-store.js';

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace',
  },
}));

describe('OfflineMessageStore', () => {
  let store: OfflineMessageStore;
  const testFilePath = '/tmp/test-workspace/.offline-messages.json';

  beforeEach(async () => {
    // Reset singleton
    resetOfflineMessageStore();

    // Ensure test directory exists
    await fs.mkdir('/tmp/test-workspace', { recursive: true });

    // Clean up test file
    try {
      await fs.unlink(testFilePath);
    } catch {
      // File doesn't exist, that's fine
    }

    // Create fresh store instance
    store = new OfflineMessageStore({ filePath: testFilePath });
  });

  afterEach(async () => {
    store.dispose();
    resetOfflineMessageStore();

    // Clean up test file
    try {
      await fs.unlink(testFilePath);
    } catch {
      // Ignore
    }
  });

  describe('save', () => {
    it('should save a message context with generated fields', async () => {
      const context = await store.save({
        id: 'msg-1',
        chatId: 'oc_test',
        question: 'Test question?',
        callbackAction: 'create_task',
      });

      expect(context.id).toBe('msg-1');
      expect(context.chatId).toBe('oc_test');
      expect(context.question).toBe('Test question?');
      expect(context.callbackAction).toBe('create_task');
      expect(context.createdAt).toBeGreaterThan(0);
      expect(context.expiresAt).toBeGreaterThan(context.createdAt);
      expect(context.handled).toBe(false);
    });

    it('should persist messages to file', async () => {
      await store.save({
        id: 'msg-2',
        chatId: 'oc_test',
        question: 'Persisted question?',
        callbackAction: 'trigger_skill',
      });

      // Read the file and verify
      const data = await fs.readFile(testFilePath, 'utf-8');
      const parsed = JSON.parse(data) as OfflineMessageContext[];

      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('msg-2');
    });

    it('should save with optional fields', async () => {
      const context = await store.save({
        id: 'msg-3',
        chatId: 'oc_test',
        question: 'Question with options',
        options: ['Option A', 'Option B'],
        agentContext: 'Some context',
        callbackAction: 'record_knowledge',
        callbackParams: { skill: 'test-skill' },
      });

      expect(context.options).toEqual(['Option A', 'Option B']);
      expect(context.agentContext).toBe('Some context');
      expect(context.callbackParams).toEqual({ skill: 'test-skill' });
    });
  });

  describe('findByMessageId', () => {
    it('should find a message by ID', async () => {
      await store.save({
        id: 'msg-find',
        chatId: 'oc_test',
        question: 'Find me',
        callbackAction: 'create_task',
      });

      const found = await store.findByMessageId('msg-find');
      expect(found).toBeDefined();
      expect(found?.question).toBe('Find me');
    });

    it('should return undefined for non-existent ID', async () => {
      const found = await store.findByMessageId('non-existent');
      expect(found).toBeUndefined();
    });
  });

  describe('findByChatId', () => {
    it('should find all messages for a chat', async () => {
      await store.save({
        id: 'msg-chat-1',
        chatId: 'oc_chat1',
        question: 'Question 1',
        callbackAction: 'create_task',
      });
      await store.save({
        id: 'msg-chat-2',
        chatId: 'oc_chat1',
        question: 'Question 2',
        callbackAction: 'create_task',
      });
      await store.save({
        id: 'msg-chat-3',
        chatId: 'oc_chat2',
        question: 'Question 3',
        callbackAction: 'create_task',
      });

      const chat1Messages = await store.findByChatId('oc_chat1');
      expect(chat1Messages).toHaveLength(2);

      const chat2Messages = await store.findByChatId('oc_chat2');
      expect(chat2Messages).toHaveLength(1);
    });
  });

  describe('markHandled', () => {
    it('should mark a message as handled', async () => {
      await store.save({
        id: 'msg-handle',
        chatId: 'oc_test',
        question: 'Handle me',
        callbackAction: 'create_task',
      });

      await store.markHandled('msg-handle');

      const context = await store.findByMessageId('msg-handle');
      expect(context?.handled).toBe(true);
    });
  });

  describe('remove', () => {
    it('should remove a message', async () => {
      await store.save({
        id: 'msg-remove',
        chatId: 'oc_test',
        question: 'Remove me',
        callbackAction: 'create_task',
      });

      await store.remove('msg-remove');

      const found = await store.findByMessageId('msg-remove');
      expect(found).toBeUndefined();
    });
  });

  describe('getActive', () => {
    it('should return only active messages', async () => {
      await store.save({
        id: 'msg-active-1',
        chatId: 'oc_test',
        question: 'Active 1',
        callbackAction: 'create_task',
      });

      await store.save({
        id: 'msg-active-2',
        chatId: 'oc_test',
        question: 'Active 2',
        callbackAction: 'create_task',
      });

      // Mark one as handled
      await store.markHandled('msg-active-1');

      const active = await store.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('msg-active-2');
    });
  });

  describe('persistence', () => {
    it('should load messages from file on initialization', async () => {
      // Save a message
      await store.save({
        id: 'msg-persist',
        chatId: 'oc_test',
        question: 'Persist test',
        callbackAction: 'create_task',
      });

      // Dispose the store
      store.dispose();

      // Create a new store instance
      const newStore = new OfflineMessageStore({ filePath: testFilePath });
      await newStore.initialize();

      const found = await newStore.findByMessageId('msg-persist');
      expect(found).toBeDefined();
      expect(found?.question).toBe('Persist test');

      newStore.dispose();
    });

    it('should not load expired messages', async () => {
      // Save a message with very short TTL
      const shortTtlStore = new OfflineMessageStore({
        filePath: testFilePath,
        defaultTtl: -1, // Already expired
      });

      await shortTtlStore.save({
        id: 'msg-expired',
        chatId: 'oc_test',
        question: 'Expired',
        callbackAction: 'create_task',
      });

      shortTtlStore.dispose();

      // Create a new store and initialize
      const newStore = new OfflineMessageStore({ filePath: testFilePath });
      await newStore.initialize();

      const found = await newStore.findByMessageId('msg-expired');
      expect(found).toBeUndefined();

      newStore.dispose();
    });
  });
});

describe('Singleton functions', () => {
  afterEach(() => {
    resetOfflineMessageStore();
  });

  it('should return the same instance', () => {
    const store1 = getOfflineMessageStore();
    const store2 = getOfflineMessageStore();
    expect(store1).toBe(store2);
  });

  it('should create new instance after reset', () => {
    const store1 = getOfflineMessageStore();
    resetOfflineMessageStore();
    const store2 = getOfflineMessageStore();
    expect(store1).not.toBe(store2);
  });
});
