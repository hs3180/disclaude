/**
 * Tests for Message Content Parser.
 * @see Issue #846 - Support for quote replies and forwarded chat history
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseForwardedHistory,
  formatContextPrompt,
  type ParsedMessageContext,
} from './message-content-parser.js';

// Mock the logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('MessageContentParser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseForwardedHistory', () => {
    it('should detect forwarded text message with "转发消息" indicator', () => {
      const content = JSON.stringify({ text: '【转发消息】\n这是转发的消息内容' });
      const result = parseForwardedHistory(content, 'text');

      expect(result.isForwarded).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages?.[0].content).toContain('转发消息');
    });

    it('should detect forwarded text message with "转发自" indicator', () => {
      const content = JSON.stringify({ text: '转发自张三:\n你好，这是对话记录' });
      const result = parseForwardedHistory(content, 'text');

      expect(result.isForwarded).toBe(true);
    });

    it('should detect forwarded text message with "Forwarded message" indicator', () => {
      const content = JSON.stringify({ text: 'Forwarded message:\nThis is forwarded content' });
      const result = parseForwardedHistory(content, 'text');

      expect(result.isForwarded).toBe(true);
    });

    it('should not detect regular text message as forwarded', () => {
      const content = JSON.stringify({ text: '这是一条普通消息' });
      const result = parseForwardedHistory(content, 'text');

      expect(result.isForwarded).toBe(false);
    });

    it('should detect forwarded post message with forward indicator', () => {
      const content = JSON.stringify({
        content: [
          [{ tag: 'text', text: '【转发消息】' }],
          [{ tag: 'text', text: '用户A: 你好' }],
          [{ tag: 'text', text: '用户B: 你好，有什么可以帮助你的？' }],
        ],
      });
      const result = parseForwardedHistory(content, 'post');

      expect(result.isForwarded).toBe(true);
      expect(result.messages).toHaveLength(1);
    });

    it('should not detect regular post message as forwarded', () => {
      const content = JSON.stringify({
        content: [
          [{ tag: 'text', text: '这是一条普通富文本消息' }],
        ],
      });
      const result = parseForwardedHistory(content, 'post');

      expect(result.isForwarded).toBe(false);
    });

    it('should handle invalid JSON content', () => {
      const result = parseForwardedHistory('invalid json', 'text');

      expect(result.isForwarded).toBe(false);
    });
  });

  describe('formatContextPrompt', () => {
    it('should format quote reply context', () => {
      const context: ParsedMessageContext = {
        quoteReply: {
          parentMessageId: 'msg_123',
          parentContent: '这是被引用的消息内容',
          parentSender: '张三',
        },
      };

      const prompt = formatContextPrompt(context);

      expect(prompt).toBeDefined();
      expect(prompt).toContain('引用的消息');
      expect(prompt).toContain('这是被引用的消息内容');
      expect(prompt).toContain('张三');
    });

    it('should format forwarded history context', () => {
      const context: ParsedMessageContext = {
        forwardedHistory: {
          isForwarded: true,
          messages: [
            { content: '你好', sender: '用户A' },
            { content: '你好，有什么可以帮助你的？', sender: '用户B' },
          ],
        },
      };

      const prompt = formatContextPrompt(context);

      expect(prompt).toBeDefined();
      expect(prompt).toContain('转发的对话记录');
      expect(prompt).toContain('用户A');
      expect(prompt).toContain('你好');
    });

    it('should format combined context with both quote reply and forwarded history', () => {
      const context: ParsedMessageContext = {
        quoteReply: {
          parentMessageId: 'msg_123',
          parentContent: '原消息内容',
        },
        forwardedHistory: {
          isForwarded: true,
          messages: [{ content: '转发的消息' }],
        },
      };

      const prompt = formatContextPrompt(context);

      expect(prompt).toBeDefined();
      expect(prompt).toContain('引用的消息');
      expect(prompt).toContain('转发的对话记录');
    });

    it('should return undefined for empty context', () => {
      const context: ParsedMessageContext = {};

      const prompt = formatContextPrompt(context);

      expect(prompt).toBeUndefined();
    });

    it('should return undefined for context without useful info', () => {
      const context: ParsedMessageContext = {
        quoteReply: {
          parentMessageId: 'msg_123',
          // No parentContent
        },
        forwardedHistory: {
          isForwarded: false,
        },
      };

      const prompt = formatContextPrompt(context);

      expect(prompt).toBeUndefined();
    });
  });
});
