/**
 * Tests for core message history manager (src/core/message-history.ts)
 *
 * Tests the platform-agnostic message history functionality.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageHistoryManager,
  messageHistoryManager,
  type IMessageHistoryManager,
} from './message-history.js';

describe('MessageHistoryManager (Core)', () => {
  let manager: IMessageHistoryManager;

  beforeEach(() => {
    manager = new MessageHistoryManager();
  });

  describe('interface implementation', () => {
    it('should implement IMessageHistoryManager', () => {
      expect(manager.getHistory).toBeDefined();
      expect(manager.addUserMessage).toBeDefined();
      expect(manager.addBotMessage).toBeDefined();
      expect(manager.clearHistory).toBeDefined();
      expect(manager.getFormattedHistory).toBeDefined();
      expect(manager.getStats).toBeDefined();
    });
  });

  describe('addUserMessage', () => {
    it('should add user message to history', () => {
      manager.addUserMessage('chat123', 'msg1', 'Hello', 'user1');

      const history = manager.getHistory('chat123');

      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('user');
      expect(history[0].content).toBe('Hello');
      expect(history[0].userId).toBe('user1');
    });
  });

  describe('addBotMessage', () => {
    it('should add bot message to history', () => {
      manager.addBotMessage('chat123', 'msg1', 'Hi there!');

      const history = manager.getHistory('chat123');

      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('bot');
      expect(history[0].content).toBe('Hi there!');
    });
  });

  describe('getHistory', () => {
    it('should return empty array for non-existent chat', () => {
      const history = manager.getHistory('nonexistent');

      expect(history).toEqual([]);
    });

    it('should return messages in chronological order', () => {
      manager.addUserMessage('chat123', 'msg1', 'First');
      manager.addBotMessage('chat123', 'msg2', 'Second');
      manager.addUserMessage('chat123', 'msg3', 'Third');

      const history = manager.getHistory('chat123');

      expect(history).toHaveLength(3);
      expect(history[0].content).toBe('First');
      expect(history[1].content).toBe('Second');
      expect(history[2].content).toBe('Third');
    });
  });

  describe('getFormattedHistory', () => {
    it('should return placeholder for empty history', () => {
      const formatted = manager.getFormattedHistory('chat123');

      expect(formatted).toBe('(No previous conversation history)');
    });

    it('should format messages with role prefix', () => {
      manager.addUserMessage('chat123', 'msg1', 'Hello');
      manager.addBotMessage('chat123', 'msg2', 'Hi');

      const formatted = manager.getFormattedHistory('chat123');

      expect(formatted).toContain('[1] User: Hello');
      expect(formatted).toContain('[2] Bot: Hi');
    });
  });

  describe('clearHistory', () => {
    it('should clear history for specific chat', () => {
      manager.addUserMessage('chat123', 'msg1', 'Message');

      manager.clearHistory('chat123');

      expect(manager.getHistory('chat123')).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return zero stats for new manager', () => {
      const stats = manager.getStats();

      expect(stats.totalChats).toBe(0);
      expect(stats.totalMessages).toBe(0);
    });

    it('should count multiple chats correctly', () => {
      manager.addUserMessage('chat1', 'msg1', 'M1');
      manager.addUserMessage('chat2', 'msg2', 'M2');

      const stats = manager.getStats();

      expect(stats.totalChats).toBe(2);
      expect(stats.totalMessages).toBe(2);
    });
  });
});

describe('messageHistoryManager global instance (Core)', () => {
  it('should be a MessageHistoryManager instance', () => {
    expect(messageHistoryManager).toBeInstanceOf(MessageHistoryManager);
  });
});
