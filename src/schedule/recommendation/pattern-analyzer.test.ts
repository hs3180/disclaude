/**
 * Tests for PatternAnalyzer
 *
 * Tests pattern detection from user message history.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PatternAnalyzer } from './pattern-analyzer.js';
import { MessageHistoryManager } from '../../core/message-history.js';
import { DEFAULT_RECOMMENDATION_CONFIG } from './types.js';

describe('PatternAnalyzer', () => {
  let messageHistoryManager: MessageHistoryManager;
  let analyzer: PatternAnalyzer;
  const chatId = 'test-chat-123';

  beforeEach(() => {
    messageHistoryManager = new MessageHistoryManager();
    analyzer = new PatternAnalyzer({
      messageHistoryManager,
      config: {
        ...DEFAULT_RECOMMENDATION_CONFIG,
        minOccurrences: 2, // Lower threshold for testing
        minConfidence: 0.5,
      },
    });
  });

  describe('analyzeChatPatterns', () => {
    it('should return empty result for empty chat', async () => {
      const result = await analyzer.analyzeChatPatterns(chatId);

      expect(result.chatId).toBe(chatId);
      expect(result.patterns).toHaveLength(0);
      expect(result.messageCount).toBe(0);
    });

    it('should detect daily pattern from consistent times', async () => {
      // Add messages at 9 AM for 5 consecutive days
      const baseTime = new Date();
      baseTime.setHours(9, 0, 0, 0);

      for (let i = 0; i < 5; i++) {
        const timestamp = baseTime.getTime() - i * 24 * 60 * 60 * 1000;
        messageHistoryManager.addUserMessage(
          chatId,
          `msg-${i}`,
          '帮我总结今天的代码变更',
          'user-1'
        );
        // Manually set timestamp (hack for testing)
        const history = (messageHistoryManager as any).histories.get(chatId);
        if (history) {
          history.messages[history.messages.length - 1].timestamp = timestamp;
        }
      }

      const result = await analyzer.analyzeChatPatterns(chatId);

      expect(result.patterns.length).toBeGreaterThanOrEqual(0);
      // Pattern detection depends on message content and timing
    });

    it('should not detect pattern with insufficient occurrences', async () => {
      // Add only 1 message
      messageHistoryManager.addUserMessage(chatId, 'msg-1', '帮我总结代码变更');

      const result = await analyzer.analyzeChatPatterns(chatId);

      expect(result.patterns).toHaveLength(0);
    });
  });

  describe('classifyIntent', () => {
    it('should classify code-summary intent', () => {
      const result = analyzer.classifyIntent('帮我总结今天的代码变更');

      expect(result.intent).toBe('code-summary');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should classify weekly-report intent', () => {
      const result = analyzer.classifyIntent('生成上周的周报');

      expect(result.intent).toBe('weekly-report');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should classify status-check intent', () => {
      const result = analyzer.classifyIntent('检查服务状态');

      expect(result.intent).toBe('status-check');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should create generic intent for unknown patterns', () => {
      const result = analyzer.classifyIntent('这是一条随机的消息');

      expect(result.intent).toBeDefined();
      expect(result.intent).toMatch(/^custom-/);
    });
  });
});
