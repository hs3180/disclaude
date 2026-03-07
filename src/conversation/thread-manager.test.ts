/**
 * Tests for ThreadManager.
 *
 * Issue #1072: Thread Management - 支持多对话切换
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { ThreadManager } from './thread-manager.js';

// Create a silent logger for tests
const logger = pino({ level: 'silent' });

describe('ThreadManager', () => {
  let threadManager: ThreadManager;
  let tempDir: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(process.cwd(), '.threads-test-'));
    threadManager = new ThreadManager({
      logger,
      storageDir: tempDir,
    });
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('createThread', () => {
    it('should create a thread with correct properties', () => {
      const thread = threadManager.createThread('chat-1', 'Test Thread', 'root-1');

      expect(thread.id).toMatch(/^thread_\d+$/);
      expect(thread.name).toBe('Test Thread');
      expect(thread.chatId).toBe('chat-1');
      expect(thread.threadRootId).toBe('root-1');
      expect(thread.messageCount).toBe(0);
      expect(thread.createdAt).toBeGreaterThan(0);
      expect(thread.updatedAt).toBe(thread.createdAt);
    });

    it('should make first thread current automatically', () => {
      const thread = threadManager.createThread('chat-1', 'First', 'root-1');
      const current = threadManager.getCurrentThread('chat-1');
      expect(current?.id).toBe(thread.id);
    });
  });

  describe('saveCurrentAsThread', () => {
    it('should save current conversation as a thread', () => {
      const thread = threadManager.saveCurrentAsThread('chat-1', 'Saved Thread', 'root-123');

      expect(thread.name).toBe('Saved Thread');
      expect(thread.threadRootId).toBe('root-123');
    });

    it('should throw error if name already exists', () => {
      threadManager.saveCurrentAsThread('chat-1', 'Existing', 'root-1');

      expect(() => {
        threadManager.saveCurrentAsThread('chat-1', 'Existing', 'root-2');
      }).toThrow('Thread "Existing" already exists');
    });
  });

  describe('switchThread', () => {
    it('should switch to thread by ID', () => {
      threadManager.createThread('chat-1', 'Thread 1', 'root-1');
      const thread2 = threadManager.createThread('chat-1', 'Thread 2', 'root-2');

      const switched = threadManager.switchThread('chat-1', thread2.id);
      expect(switched?.id).toBe(thread2.id);

      const current = threadManager.getCurrentThread('chat-1');
      expect(current?.id).toBe(thread2.id);
    });

    it('should switch to thread by name', () => {
      threadManager.createThread('chat-1', 'Thread 1', 'root-1');
      const thread2 = threadManager.createThread('chat-1', 'Thread 2', 'root-2');

      const switched = threadManager.switchThread('chat-1', 'Thread 2');
      expect(switched?.id).toBe(thread2.id);
    });

    it('should return undefined for non-existent thread', () => {
      const result = threadManager.switchThread('chat-1', 'non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('listThreads', () => {
    it('should return empty array for chat with no threads', () => {
      const threads = threadManager.listThreads('chat-1');
      expect(threads).toEqual([]);
    });

    it('should return threads sorted by creation time (newest first)', async () => {
      threadManager.createThread('chat-1', 'First', 'root-1');
      await new Promise(r => setTimeout(r, 10)); // Small delay
      threadManager.createThread('chat-1', 'Second', 'root-2');
      await new Promise(r => setTimeout(r, 10));
      threadManager.createThread('chat-1', 'Third', 'root-3');

      const threads = threadManager.listThreads('chat-1');
      expect(threads.map(t => t.name)).toEqual(['Third', 'Second', 'First']);
    });

    it('should isolate threads between different chats', () => {
      threadManager.createThread('chat-1', 'Chat1 Thread', 'root-1');
      threadManager.createThread('chat-2', 'Chat2 Thread', 'root-2');

      const chat1Threads = threadManager.listThreads('chat-1');
      const chat2Threads = threadManager.listThreads('chat-2');

      expect(chat1Threads).toHaveLength(1);
      expect(chat1Threads[0].name).toBe('Chat1 Thread');
      expect(chat2Threads).toHaveLength(1);
      expect(chat2Threads[0].name).toBe('Chat2 Thread');
    });
  });

  describe('deleteThread', () => {
    it('should delete thread by ID', () => {
      const thread = threadManager.createThread('chat-1', 'To Delete', 'root-1');

      const deleted = threadManager.deleteThread('chat-1', thread.id);
      expect(deleted).toBe(true);

      const threads = threadManager.listThreads('chat-1');
      expect(threads).toHaveLength(0);
    });

    it('should delete thread by name', () => {
      threadManager.createThread('chat-1', 'To Delete', 'root-1');

      const deleted = threadManager.deleteThread('chat-1', 'To Delete');
      expect(deleted).toBe(true);
    });

    it('should return false for non-existent thread', () => {
      const deleted = threadManager.deleteThread('chat-1', 'non-existent');
      expect(deleted).toBe(false);
    });

    it('should switch current thread when deleting current', () => {
      const thread1 = threadManager.createThread('chat-1', 'Thread 1', 'root-1');
      threadManager.createThread('chat-1', 'Thread 2', 'root-2');

      threadManager.switchThread('chat-1', 'Thread 2');
      threadManager.deleteThread('chat-1', 'Thread 2');

      const current = threadManager.getCurrentThread('chat-1');
      expect(current?.id).toBe(thread1.id);
    });
  });

  describe('renameThread', () => {
    it('should rename thread', () => {
      threadManager.createThread('chat-1', 'Old Name', 'root-1');

      const renamed = threadManager.renameThread('chat-1', 'Old Name', 'New Name');
      expect(renamed?.name).toBe('New Name');

      const threads = threadManager.listThreads('chat-1');
      expect(threads[0].name).toBe('New Name');
    });

    it('should throw error if new name exists', () => {
      threadManager.createThread('chat-1', 'Thread 1', 'root-1');
      threadManager.createThread('chat-1', 'Thread 2', 'root-2');

      expect(() => {
        threadManager.renameThread('chat-1', 'Thread 1', 'Thread 2');
      }).toThrow('Thread "Thread 2" already exists');
    });

    it('should return undefined for non-existent thread', () => {
      const result = threadManager.renameThread('chat-1', 'Non-existent', 'New Name');
      expect(result).toBeUndefined();
    });
  });

  describe('persistence', () => {
    it('should persist threads to disk', () => {
      threadManager.createThread('chat-1', 'Persisted', 'root-1');

      // Check file exists
      const files = fs.readdirSync(tempDir);
      expect(files.length).toBeGreaterThan(0);
    });

    it('should load threads from disk on state creation', () => {
      threadManager.createThread('chat-1', 'To Load', 'root-1');
      threadManager.closeAll();

      // Create new manager with same storage
      const newManager = new ThreadManager({
        logger,
        storageDir: tempDir,
      });

      const threads = newManager.listThreads('chat-1');
      expect(threads).toHaveLength(1);
      expect(threads[0].name).toBe('To Load');
    });
  });

  describe('incrementMessageCount', () => {
    it('should increment message count', () => {
      const thread = threadManager.createThread('chat-1', 'Test', 'root-1');

      threadManager.incrementMessageCount('chat-1', thread.id);
      threadManager.incrementMessageCount('chat-1', thread.id);

      const threads = threadManager.listThreads('chat-1');
      expect(threads[0].messageCount).toBe(2);
    });
  });

  describe('setThreadSummary', () => {
    it('should set thread summary', () => {
      const thread = threadManager.createThread('chat-1', 'Test', 'root-1');

      threadManager.setThreadSummary('chat-1', thread.id, 'AI-generated summary');

      const threads = threadManager.listThreads('chat-1');
      expect(threads[0].summary).toBe('AI-generated summary');
    });
  });

  describe('clearThreads', () => {
    it('should clear all threads for a chat', () => {
      threadManager.createThread('chat-1', 'Thread 1', 'root-1');
      threadManager.createThread('chat-1', 'Thread 2', 'root-2');

      threadManager.clearThreads('chat-1');

      expect(threadManager.listThreads('chat-1')).toHaveLength(0);
    });
  });

  describe('getThreadCount', () => {
    it('should return correct thread count', () => {
      expect(threadManager.getThreadCount('chat-1')).toBe(0);

      threadManager.createThread('chat-1', 'Thread 1', 'root-1');
      expect(threadManager.getThreadCount('chat-1')).toBe(1);

      threadManager.createThread('chat-1', 'Thread 2', 'root-2');
      expect(threadManager.getThreadCount('chat-1')).toBe(2);
    });
  });
});
