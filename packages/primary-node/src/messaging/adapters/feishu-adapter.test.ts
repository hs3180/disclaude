/**
 * FeishuAdapter unit tests.
 *
 * Issue #1742: Added tests for post format with @mentions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuAdapter } from './feishu-adapter.js';
import type { UniversalMessage } from '@disclaude/core';

// Mock logger
vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual('@disclaude/core') as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;

  beforeEach(() => {
    adapter = new FeishuAdapter();
  });

  describe('convert', () => {
    it('should convert text content to msg_type text', () => {
      const message: UniversalMessage = {
        chatId: 'oc_test',
        content: { type: 'text', text: 'Hello World' },
      };

      const result = adapter.convert(message) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('text');
      const parsed = JSON.parse(result.content);
      expect(parsed.text).toBe('Hello World');
    });

    it('should convert text content to msg_type post when mentions are provided (Issue #1742)', () => {
      const message: UniversalMessage = {
        chatId: 'oc_test',
        content: {
          type: 'text',
          text: 'Hello @OtherBot please help',
          mentions: [{ id: 'ou_bot123', name: 'OtherBot' }],
        },
      };

      const result = adapter.convert(message) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('post');
      const parsed = JSON.parse(result.content);
      expect(parsed.zh_cn).toBeDefined();
      expect(parsed.zh_cn.title).toBe('');
      expect(parsed.zh_cn.content).toHaveLength(1);

      // First paragraph should have text, at, and more text
      const elements = parsed.zh_cn.content[0];
      expect(elements[0]).toEqual({ tag: 'text', text: 'Hello ' });
      expect(elements[1]).toEqual({ tag: 'at', user_id: 'ou_bot123' });
      expect(elements[2]).toEqual({ tag: 'text', text: ' please help' });
    });

    it('should handle multiple mentions in text (Issue #1742)', () => {
      const message: UniversalMessage = {
        chatId: 'oc_test',
        content: {
          type: 'text',
          text: '@BotA and @BotB please collaborate',
          mentions: [
            { id: 'ou_botA', name: 'BotA' },
            { id: 'ou_botB', name: 'BotB' },
          ],
        },
      };

      const result = adapter.convert(message) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('post');
      const parsed = JSON.parse(result.content);
      const elements = parsed.zh_cn.content[0];

      expect(elements[0]).toEqual({ tag: 'at', user_id: 'ou_botA' });
      expect(elements[1]).toEqual({ tag: 'text', text: ' and ' });
      expect(elements[2]).toEqual({ tag: 'at', user_id: 'ou_botB' });
      expect(elements[3]).toEqual({ tag: 'text', text: ' please collaborate' });
    });

    it('should append mention at end when name not found in text (Issue #1742)', () => {
      const message: UniversalMessage = {
        chatId: 'oc_test',
        content: {
          type: 'text',
          text: 'Hello there',
          mentions: [{ id: 'ou_bot123', name: 'OtherBot' }],
        },
      };

      const result = adapter.convert(message) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('post');
      const parsed = JSON.parse(result.content);
      const elements = parsed.zh_cn.content[0];

      // Since "OtherBot" is not in text, @ tag is appended
      expect(elements[0]).toEqual({ tag: 'at', user_id: 'ou_bot123' });
      expect(elements[1]).toEqual({ tag: 'text', text: 'Hello there' });
    });

    it('should handle mention with only id (no name) (Issue #1742)', () => {
      const message: UniversalMessage = {
        chatId: 'oc_test',
        content: {
          type: 'text',
          text: 'Hello',
          mentions: [{ id: 'ou_bot123' }],
        },
      };

      const result = adapter.convert(message) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('post');
      const parsed = JSON.parse(result.content);
      const elements = parsed.zh_cn.content[0];

      expect(elements[0]).toEqual({ tag: 'at', user_id: 'ou_bot123' });
      expect(elements[1]).toEqual({ tag: 'text', text: 'Hello' });
    });

    it('should convert markdown content to msg_type interactive', () => {
      const message: UniversalMessage = {
        chatId: 'oc_test',
        content: { type: 'markdown', text: '**bold** text' },
      };

      const result = adapter.convert(message) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('interactive');
      const parsed = JSON.parse(result.content);
      expect(parsed.config.wide_screen_mode).toBe(true);
    });

    it('should convert done content to text message', () => {
      const message: UniversalMessage = {
        chatId: 'oc_test',
        content: { type: 'done', success: true, message: 'All good' },
      };

      const result = adapter.convert(message) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('text');
      const parsed = JSON.parse(result.content);
      expect(parsed.text).toContain('✅');
      expect(parsed.text).toContain('All good');
    });
  });

  describe('canHandle', () => {
    it('should handle Feishu group chat IDs (oc_)', () => {
      expect(adapter.canHandle('oc_abc123')).toBe(true);
    });

    it('should handle Feishu user IDs (ou_)', () => {
      expect(adapter.canHandle('ou_abc123')).toBe(true);
    });

    it('should handle Feishu bot IDs (on_)', () => {
      expect(adapter.canHandle('on_abc123')).toBe(true);
    });

    it('should reject non-Feishu IDs', () => {
      expect(adapter.canHandle('cli-123')).toBe(false);
      expect(adapter.canHandle('random')).toBe(false);
    });
  });
});
