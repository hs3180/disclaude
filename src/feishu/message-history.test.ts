/**
 * Tests for message history (src/feishu/message-history.ts)
 *
 * Tests the following functionality:
 * - Adding user and bot messages
 * - Retrieving conversation history
 * - Formatting history for prompts
 * - Clearing history
 * - Message limit enforcement
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageHistoryManager,
  messageHistoryManager,
} from './message-history.js';

describe('MessageHistoryManager', () => {
  let manager: MessageHistoryManager;

  beforeEach(() => {
    manager = new MessageHistoryManager();
  });

  describe('addUserMessage', () => {
    it('should add user message to history', () => {
      manager.addUserMessage('oc_chat123', 'om_msg1', 'Hello', 'ou_user1');

      const history = manager.getHistory('oc_chat123');

      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('user');
      expect(history[0].content).toBe('Hello');
      expect(history[0].userId).toBe('ou_user1');
    });

    it('should create new chat if not exists', () => {
      manager.addUserMessage('oc_new_chat', 'om_msg1', 'First message');

      const history = manager.getHistory('oc_new_chat');

      expect(history).toHaveLength(1);
    });

    it('should assign timestamp automatically', () => {
      const beforeTime = Date.now();
      manager.addUserMessage('oc_chat123', 'om_msg1', 'Hello');
      const afterTime = Date.now();

      const history = manager.getHistory('oc_chat123');

      expect(history[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(history[0].timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should handle optional userId', () => {
      manager.addUserMessage('oc_chat123', 'om_msg1', 'Hello');

      const history = manager.getHistory('oc_chat123');

      expect(history[0].userId).toBeUndefined();
    });
  });

  describe('addBotMessage', () => {
    it('should add bot message to history', () => {
      manager.addBotMessage('oc_chat123', 'om_msg1', 'Hi there!');

      const history = manager.getHistory('oc_chat123');

      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('bot');
      expect(history[0].content).toBe('Hi there!');
    });

    it('should create new chat if not exists', () => {
      manager.addBotMessage('oc_new_chat', 'om_msg1', 'Bot response');

      const history = manager.getHistory('oc_new_chat');

      expect(history).toHaveLength(1);
    });

    it('should not include userId for bot messages', () => {
      manager.addBotMessage('oc_chat123', 'om_msg1', 'Response');

      const history = manager.getHistory('oc_chat123');

      expect(history[0].userId).toBeUndefined();
    });
  });

  describe('getHistory', () => {
    it('should return empty array for non-existent chat', () => {
      const history = manager.getHistory('oc_nonexistent');

      expect(history).toEqual([]);
    });

    it('should return messages in chronological order', () => {
      manager.addUserMessage('oc_chat123', 'om_msg1', 'First');
      manager.addBotMessage('oc_chat123', 'om_msg2', 'Second');
      manager.addUserMessage('oc_chat123', 'om_msg3', 'Third');

      const history = manager.getHistory('oc_chat123');

      expect(history).toHaveLength(3);
      expect(history[0].content).toBe('First');
      expect(history[1].content).toBe('Second');
      expect(history[2].content).toBe('Third');
    });

    it('should return copy of messages (not reference)', () => {
      manager.addUserMessage('oc_chat123', 'om_msg1', 'Original');

      const history1 = manager.getHistory('oc_chat123');
      const history2 = manager.getHistory('oc_chat123');

      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
    });
  });

  describe('getFormattedHistory', () => {
    it('should return placeholder for empty history', () => {
      const formatted = manager.getFormattedHistory('oc_chat123');

      expect(formatted).toBe('(No previous conversation history)');
    });

    it('should format messages with role prefix', () => {
      manager.addUserMessage('oc_chat123', 'om_msg1', 'Hello');
      manager.addBotMessage('oc_chat123', 'om_msg2', 'Hi');
      manager.addUserMessage('oc_chat123', 'om_msg3', 'How are you?');

      const formatted = manager.getFormattedHistory('oc_chat123');

      expect(formatted).toContain('[1] User: Hello');
      expect(formatted).toContain('[2] Bot: Hi');
      expect(formatted).toContain('[3] User: How are you?');
    });

    it('should limit messages when maxMessages is specified', () => {
      for (let i = 1; i <= 10; i++) {
        manager.addUserMessage('oc_chat123', `om_msg${i}`, `Message ${i}`);
      }

      const formatted = manager.getFormattedHistory('oc_chat123', 3);

      expect(formatted).toContain('[1] User: Message 8');
      expect(formatted).toContain('[2] User: Message 9');
      expect(formatted).toContain('[3] User: Message 10');
      expect(formatted).not.toContain('Message 7');
    });

    it('should return all messages when maxMessages not specified', () => {
      for (let i = 1; i <= 5; i++) {
        manager.addUserMessage('oc_chat123', `om_msg${i}`, `Message ${i}`);
      }

      const formatted = manager.getFormattedHistory('oc_chat123');

      expect(formatted).toContain('[1] User: Message 1');
      expect(formatted).toContain('[5] User: Message 5');
    });

    it('should handle multiline messages', () => {
      manager.addUserMessage('oc_chat123', 'om_msg1', 'Line 1\nLine 2\nLine 3');

      const formatted = manager.getFormattedHistory('oc_chat123');

      expect(formatted).toContain('Line 1\nLine 2\nLine 3');
    });
  });

  describe('clearHistory', () => {
    it('should clear history for specific chat', () => {
      manager.addUserMessage('oc_chat123', 'om_msg1', 'Message 1');
      manager.addUserMessage('oc_chat456', 'om_msg2', 'Message 2');

      manager.clearHistory('oc_chat123');

      expect(manager.getHistory('oc_chat123')).toEqual([]);
      expect(manager.getHistory('oc_chat456')).toHaveLength(1);
    });

    it('should handle clearing non-existent chat', () => {
      expect(() => manager.clearHistory('oc_nonexistent')).not.toThrow();
    });

    it('should allow re-adding messages after clear', () => {
      manager.addUserMessage('oc_chat123', 'om_msg1', 'First');
      manager.clearHistory('oc_chat123');
      manager.addUserMessage('oc_chat123', 'om_msg2', 'Second');

      const history = manager.getHistory('oc_chat123');

      expect(history).toHaveLength(1);
      expect(history[0].content).toBe('Second');
    });
  });

  describe('getStats', () => {
    it('should return zero stats for new manager', () => {
      const stats = manager.getStats();

      expect(stats.totalChats).toBe(0);
      expect(stats.totalMessages).toBe(0);
    });

    it('should count multiple chats correctly', () => {
      manager.addUserMessage('oc_chat1', 'om_msg1', 'Message 1');
      manager.addUserMessage('oc_chat2', 'om_msg2', 'Message 2');
      manager.addUserMessage('oc_chat3', 'om_msg3', 'Message 3');

      const stats = manager.getStats();

      expect(stats.totalChats).toBe(3);
      expect(stats.totalMessages).toBe(3);
    });

    it('should count messages per chat correctly', () => {
      manager.addUserMessage('oc_chat1', 'om_msg1', 'M1');
      manager.addBotMessage('oc_chat1', 'om_msg2', 'M2');
      manager.addUserMessage('oc_chat1', 'om_msg3', 'M3');
      manager.addUserMessage('oc_chat2', 'om_msg4', 'M4');

      const stats = manager.getStats();

      expect(stats.totalChats).toBe(2);
      expect(stats.totalMessages).toBe(4);
    });
  });

  describe('message limit enforcement', () => {
    it('should enforce MAX_MESSAGES_PER_CHAT limit', () => {
      // Add more messages than the limit (100)
      for (let i = 1; i <= 150; i++) {
        manager.addUserMessage('oc_chat123', `om_msg${i}`, `Message ${i}`);
      }

      const history = manager.getHistory('oc_chat123');

      expect(history.length).toBe(100);
    });

    it('should keep most recent messages when over limit', () => {
      for (let i = 1; i <= 110; i++) {
        manager.addUserMessage('oc_chat123', `om_msg${i}`, `Message ${i}`);
      }

      const history = manager.getHistory('oc_chat123');

      expect(history.length).toBe(100);
      expect(history[0].content).toBe('Message 11'); // First 10 removed
      expect(history[99].content).toBe('Message 110'); // Last one kept
    });

    it('should trim old messages as new ones are added', () => {
      // Fill to limit
      for (let i = 1; i <= 100; i++) {
        manager.addUserMessage('oc_chat123', `om_msg${i}`, `Message ${i}`);
      }

      // Add one more
      manager.addUserMessage('oc_chat123', 'om_msg101', 'Message 101');

      const history = manager.getHistory('oc_chat123');

      expect(history.length).toBe(100);
      expect(history[0].content).toBe('Message 2');
      expect(history[99].content).toBe('Message 101');
    });
  });

  describe('multiple chats isolation', () => {
    it('should keep chats independent', () => {
      manager.addUserMessage('oc_chat1', 'om_msg1', 'Chat 1 msg 1');
      manager.addUserMessage('oc_chat2', 'om_msg2', 'Chat 2 msg 1');
      manager.addUserMessage('oc_chat1', 'om_msg3', 'Chat 1 msg 2');

      const history1 = manager.getHistory('oc_chat1');
      const history2 = manager.getHistory('oc_chat2');

      expect(history1).toHaveLength(2);
      expect(history2).toHaveLength(1);
      expect(history1[0].content).toBe('Chat 1 msg 1');
      expect(history2[0].content).toBe('Chat 2 msg 1');
    });

    it('should clear one chat without affecting others', () => {
      manager.addUserMessage('oc_chat1', 'om_msg1', 'Chat 1');
      manager.addUserMessage('oc_chat2', 'om_msg2', 'Chat 2');
      manager.addUserMessage('oc_chat3', 'om_msg3', 'Chat 3');

      manager.clearHistory('oc_chat2');

      expect(manager.getHistory('oc_chat1')).toHaveLength(1);
      expect(manager.getHistory('oc_chat2')).toHaveLength(0);
      expect(manager.getHistory('oc_chat3')).toHaveLength(1);
    });
  });
});

describe('messageHistoryManager global instance', () => {
  it('should be a MessageHistoryManager instance', () => {
    expect(messageHistoryManager).toBeInstanceOf(MessageHistoryManager);
  });

  it('should persist across test runs', () => {
    messageHistoryManager.addUserMessage('oc_test', 'om_msg1', 'Test');

    const history = messageHistoryManager.getHistory('oc_test');

    expect(history).toHaveLength(1);

    // Cleanup
    messageHistoryManager.clearHistory('oc_test');
  });
});
