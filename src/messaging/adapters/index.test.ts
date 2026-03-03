/**
 * Tests for Channel Adapters.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliAdapter, createCliAdapter } from './cli-adapter.js';
import { RestAdapter, createRestAdapter, resetRestAdapter, getRestAdapter } from './rest-adapter.js';
import { isTextContent, type UniversalMessage } from '../universal-message.js';

// Mock Config for Feishu adapter tests
vi.mock('../../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
  },
}));

describe('Channel Adapters', () => {
  describe('CliAdapter', () => {
    let adapter: CliAdapter;

    beforeEach(() => {
      adapter = createCliAdapter();
    });

    describe('canHandle', () => {
      it('should handle CLI chat IDs', () => {
        expect(adapter.canHandle('cli-123')).toBe(true);
        expect(adapter.canHandle('cli-test-abc')).toBe(true);
      });

      it('should not handle non-CLI chat IDs', () => {
        expect(adapter.canHandle('oc_123')).toBe(false);
        expect(adapter.canHandle('ou_456')).toBe(false);
        expect(adapter.canHandle('uuid-1234')).toBe(false);
      });
    });

    describe('capabilities', () => {
      it('should have correct capabilities', () => {
        expect(adapter.name).toBe('cli');
        expect(adapter.capabilities.supportsCard).toBe(false);
        expect(adapter.capabilities.supportsMarkdown).toBe(true);
        expect(adapter.capabilities.maxMessageLength).toBe(Infinity);
      });
    });

    describe('convert', () => {
      it('should convert text message', () => {
        const msg: UniversalMessage = {
          chatId: 'cli-test',
          content: { type: 'text', text: 'Hello' },
        };
        const result = adapter.convert(msg);
        expect(result).toContain('[cli-test]');
        expect(result).toContain('Hello');
      });

      it('should convert markdown message', () => {
        const msg: UniversalMessage = {
          chatId: 'cli-test',
          content: { type: 'markdown', text: '**Bold**' },
        };
        const result = adapter.convert(msg);
        expect(result).toContain('**Bold**');
      });

      it('should convert card to text', () => {
        const msg: UniversalMessage = {
          chatId: 'cli-test',
          content: {
            type: 'card',
            title: 'Card Title',
            sections: [{ type: 'text', content: 'Card Content' }],
          },
        };
        const result = adapter.convert(msg);
        expect(result).toContain('**Card Title**');
        expect(result).toContain('Card Content');
      });

      it('should convert done message', () => {
        const successMsg: UniversalMessage = {
          chatId: 'cli-test',
          content: { type: 'done', success: true, message: 'Completed' },
        };
        expect(adapter.convert(successMsg)).toContain('✅');
        expect(adapter.convert(successMsg)).toContain('Completed');

        const failMsg: UniversalMessage = {
          chatId: 'cli-test',
          content: { type: 'done', success: false, error: 'Failed' },
        };
        expect(adapter.convert(failMsg)).toContain('❌');
        expect(adapter.convert(failMsg)).toContain('Failed');
      });

      it('should convert file message', () => {
        const msg: UniversalMessage = {
          chatId: 'cli-test',
          content: { type: 'file', path: '/path/to/file.txt', name: 'file.txt' },
        };
        const result = adapter.convert(msg);
        expect(result).toContain('📎');
        expect(result).toContain('file.txt');
      });
    });

    describe('send', () => {
      it('should send message successfully', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const msg: UniversalMessage = {
          chatId: 'cli-test',
          content: { type: 'text', text: 'Hello' },
        };
        const result = await adapter.send(msg);
        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
      });
    });
  });

  describe('RestAdapter', () => {
    let adapter: RestAdapter;

    beforeEach(() => {
      resetRestAdapter();
      adapter = createRestAdapter();
    });

    describe('canHandle', () => {
      it('should handle UUID format chat IDs', () => {
        expect(adapter.canHandle('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
        expect(adapter.canHandle('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
      });

      it('should not handle non-UUID chat IDs', () => {
        expect(adapter.canHandle('oc_123')).toBe(false);
        expect(adapter.canHandle('cli-test')).toBe(false);
        expect(adapter.canHandle('not-a-uuid')).toBe(false);
      });
    });

    describe('capabilities', () => {
      it('should have correct capabilities', () => {
        expect(adapter.name).toBe('rest');
        expect(adapter.capabilities.supportsCard).toBe(true);
        expect(adapter.capabilities.supportedContentTypes).toContain('done');
      });
    });

    describe('convert', () => {
      it('should convert message to REST format', () => {
        const msg: UniversalMessage = {
          chatId: '123e4567-e89b-12d3-a456-426614174000',
          content: { type: 'text', text: 'Hello' },
        };
        const result = adapter.convert(msg);
        expect(result.id).toBeDefined();
        expect(result.chatId).toBe(msg.chatId);
        expect(result.content).toEqual(msg.content);
        expect(result.timestamp).toBeDefined();
      });

      it('should preserve threadId', () => {
        const msg: UniversalMessage = {
          chatId: '123e4567-e89b-12d3-a456-426614174000',
          threadId: 'thread-123',
          content: { type: 'text', text: 'Hello' },
        };
        const result = adapter.convert(msg);
        expect(result.threadId).toBe('thread-123');
      });
    });

    describe('send', () => {
      it('should store message successfully', async () => {
        const msg: UniversalMessage = {
          chatId: '123e4567-e89b-12d3-a456-426614174000',
          content: { type: 'text', text: 'Hello' },
        };
        const result = await adapter.send(msg);
        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
        expect(result.platformData).toBeDefined();
      });

      it('should allow message retrieval', async () => {
        const chatId = '123e4567-e89b-12d3-a456-426614174000';
        const msg: UniversalMessage = {
          chatId,
          content: { type: 'text', text: 'Test message' },
        };
        await adapter.send(msg);

        const messages = adapter.getMessages(chatId);
        expect(messages).toHaveLength(1);
        const [{ content }] = messages;
        expect(isTextContent(content) && content.text).toBe('Test message');
      });

      it('should support getMessagesSince', async () => {
        const chatId = '123e4567-e89b-12d3-a456-426614174000';

        await adapter.send({
          chatId,
          content: { type: 'text', text: 'Message 1' },
        });
        const result2 = await adapter.send({
          chatId,
          content: { type: 'text', text: 'Message 2' },
        });
        await adapter.send({
          chatId,
          content: { type: 'text', text: 'Message 3' },
        });

        const newMessages = adapter.getMessagesSince(chatId, result2.messageId!);
        expect(newMessages).toHaveLength(1);
        const [{ content }] = newMessages;
        expect(isTextContent(content) && content.text).toBe('Message 3');
      });

      it('should support clearMessages', async () => {
        const chatId = '123e4567-e89b-12d3-a456-426614174000';
        await adapter.send({
          chatId,
          content: { type: 'text', text: 'Test' },
        });

        adapter.clearMessages(chatId);
        expect(adapter.getMessages(chatId)).toHaveLength(0);
      });
    });

    describe('getRestAdapter singleton', () => {
      it('should return the same instance', () => {
        const instance1 = getRestAdapter();
        const instance2 = getRestAdapter();
        expect(instance1).toBe(instance2);
      });
    });
  });
});
