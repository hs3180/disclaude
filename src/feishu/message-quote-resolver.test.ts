/**
 * Tests for Message Quote Resolver.
 * @see Issue #846
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageQuoteResolver, createMessageQuoteResolver } from './message-quote-resolver.js';
import type * as lark from '@larksuiteoapi/node-sdk';

// Mock the logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('MessageQuoteResolver', () => {
  let mockClient: lark.Client;
  let resolver: MessageQuoteResolver;

  beforeEach(() => {
    // Create mock client
    mockClient = {
      im: {
        message: {
          get: vi.fn(),
        },
      },
    } as unknown as lark.Client;

    resolver = new MessageQuoteResolver(mockClient);
  });

  describe('resolveMessageQuote', () => {
    it('should return null when no parent_id and not merge_forward', async () => {
      const result = await resolver.resolveMessageQuote('text', undefined, 'msg_123');
      expect(result).toBeNull();
    });

    it('should fetch quoted message when parent_id is provided', async () => {
      // Mock the API response
      const mockGet = mockClient.im.message.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        code: 0,
        data: {
          items: [{
            message_id: 'quoted_msg_123',
            msg_type: 'text',
            content: JSON.stringify({ text: 'This is the quoted message' }),
            create_time: '1709500000000',
          }],
        },
      });

      const result = await resolver.resolveMessageQuote('text', 'quoted_msg_123', 'msg_456');

      expect(result).not.toBeNull();
      expect(result?.contextString).toContain('引用的原消息');
      expect(result?.contextString).toContain('This is the quoted message');
    });

    it('should handle merge_forward messages with sub-messages', async () => {
      // Mock the API response for merge_forward
      const mockGet = mockClient.im.message.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        code: 0,
        data: {
          items: [
            {
              message_id: 'merge_msg_123',
              msg_type: 'merge_forward',
            },
            {
              message_id: 'sub_msg_1',
              upper_message_id: 'merge_msg_123',
              msg_type: 'text',
              content: JSON.stringify({ text: 'First forwarded message' }),
              create_time: '1709500000001',
            },
            {
              message_id: 'sub_msg_2',
              upper_message_id: 'merge_msg_123',
              msg_type: 'text',
              content: JSON.stringify({ text: 'Second forwarded message' }),
              create_time: '1709500000002',
            },
          ],
        },
      });

      const result = await resolver.resolveMessageQuote('merge_forward', undefined, 'merge_msg_123');

      expect(result).not.toBeNull();
      expect(result?.contextString).toContain('转发的对话记录');
      expect(result?.contextString).toContain('First forwarded message');
      expect(result?.contextString).toContain('Second forwarded message');
    });

    it('should handle API errors gracefully', async () => {
      const mockGet = mockClient.im.message.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValue({
        code: 1001,
        msg: 'Access denied',
        data: {},
      });

      const result = await resolver.resolveMessageQuote('text', 'quoted_msg_123', 'msg_456');
      // Should return null since no content was resolved
      expect(result).toBeNull();
    });

    it('should return fallback for merge_forward when API fails', async () => {
      const mockGet = mockClient.im.message.get as ReturnType<typeof vi.fn>;
      mockGet.mockRejectedValue(new Error('Network error'));

      const result = await resolver.resolveMessageQuote('merge_forward', undefined, 'msg_123');

      // Should return fallback message
      expect(result).not.toBeNull();
      expect(result?.contextString).toContain('转发的对话记录');
    });

    it('should combine quote and merge_forward context', async () => {
      const mockGet = mockClient.im.message.get as ReturnType<typeof vi.fn>;
      mockGet.mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{
            message_id: 'quoted_msg_123',
            msg_type: 'text',
            content: JSON.stringify({ text: 'Quoted content' }),
            create_time: '1709500000000',
          }],
        },
      }).mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            {
              message_id: 'merge_msg_123',
              msg_type: 'merge_forward',
            },
            {
              message_id: 'sub_msg_1',
              upper_message_id: 'merge_msg_123',
              msg_type: 'text',
              content: JSON.stringify({ text: 'Forwarded content' }),
              create_time: '1709500000001',
            },
          ],
        },
      });

      const result = await resolver.resolveMessageQuote('merge_forward', 'quoted_msg_123', 'merge_msg_123');
      expect(result).not.toBeNull();
      expect(result?.contextString).toContain('引用的原消息');
      expect(result?.contextString).toContain('转发的对话记录');
    });
  });

  describe('extractTextFromContent', () => {
    // Access private method through any cast for testing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractText = (resolver: any, content: string, msgType: string) =>
      resolver.extractTextFromContent(content, msgType);

    it('should extract text from text message', () => {
      const content = JSON.stringify({ text: 'Hello World' });
      const text = extractText(resolver, content, 'text');
      expect(text).toBe('Hello World');
    });

    it('should extract text from post (rich text) message', () => {
      const content = JSON.stringify({
        content: [
          [{ tag: 'text', text: 'Hello ' }],
          [{ tag: 'text', text: 'World' }],
        ],
      });
      const text = extractText(resolver, content, 'post');
      expect(text).toBe('Hello World');
    });

    it('should return placeholder for image', () => {
      const content = JSON.stringify({});
      const text = extractText(resolver, content, 'image');
      expect(text).toBe('[图片]');
    });

    it('should return placeholder for file with name', () => {
      const content = JSON.stringify({ file_name: 'document.pdf' });
      const text = extractText(resolver, content, 'file');
      expect(text).toBe('[文件: document.pdf]');
    });

    it('should return empty string for empty content', () => {
      const text = extractText(resolver, '', 'text');
      expect(text).toBe('');
    });
  });

  describe('truncateMessages', () => {
    // Access private method through any cast for testing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const truncate = (resolver: any, messages: string[]) =>
      resolver.truncateMessages(messages);

    it('should preserve all messages when under limit', () => {
      const messages = ['Short message 1', 'Short message 2', 'Short message 3'];
      const result = truncate(resolver, messages);
      expect(result).toContain('Short message 1');
      expect(result).toContain('Short message 2');
      expect(result).toContain('Short message 3');
    });

    it('should truncate long messages with head and tail preserved', () => {
      // Create a long list of messages
      const messages: string[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push(`Message ${i}: ${'x'.repeat(100)}`);
      }
      const result = truncate(resolver, messages);
      expect(result).toContain('省略');
      // Head should be preserved
      expect(result).toContain('Message 0:');
      // Tail should be preserved
      expect(result).toContain('Message 99:');
    });
  });

  describe('createMessageQuoteResolver', () => {
    it('should create a resolver instance', () => {
      const resolver = createMessageQuoteResolver(mockClient);
      expect(resolver).toBeInstanceOf(MessageQuoteResolver);
    });
  });
});
