/**
 * Tests for CliAdapter
 * @see Issue #1617 Phase 4
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CliAdapter, createCliAdapter } from './cli-adapter.js';

describe('CliAdapter', () => {
  let adapter: CliAdapter;

  beforeEach(() => {
    adapter = new CliAdapter();
  });

  describe('properties', () => {
    it('should have name "cli"', () => {
      expect(adapter.name).toBe('cli');
    });

    it('should support text and markdown', () => {
      expect(adapter.capabilities.supportsMarkdown).toBe(true);
      expect(adapter.capabilities.supportedContentTypes).toContain('text');
      expect(adapter.capabilities.supportedContentTypes).toContain('markdown');
    });

    it('should not support cards', () => {
      expect(adapter.capabilities.supportsCard).toBe(false);
    });
  });

  describe('canHandle', () => {
    it('should handle cli- prefixed IDs', () => {
      expect(adapter.canHandle('cli-session-1')).toBe(true);
    });

    it('should not handle non-cli IDs', () => {
      expect(adapter.canHandle('oc_chat1')).toBe(false);
      expect(adapter.canHandle('unknown')).toBe(false);
    });
  });

  describe('convert', () => {
    it('should convert text content', () => {
      const result = adapter.convert({
        chatId: 'cli-test',
        content: { type: 'text', text: 'Hello!' },
      });
      expect(result).toBe('Hello!');
    });

    it('should convert markdown content', () => {
      const result = adapter.convert({
        chatId: 'cli-test',
        content: { type: 'markdown', text: '**Bold** text' },
      });
      expect(result).toBe('**Bold** text');
    });

    it('should convert card to text', () => {
      const result = adapter.convert({
        chatId: 'cli-test',
        content: {
          type: 'card',
          title: 'Test Card',
          sections: [{ type: 'text', content: 'Content' }],
        } as any,
      });
      expect(result).toContain('Test Card');
      expect(result).toContain('Content');
    });

    it('should convert file content', () => {
      const result = adapter.convert({
        chatId: 'cli-test',
        content: { type: 'file', name: 'test.pdf', text: 'file content' } as any,
      });
      expect(result).toContain('test.pdf');
    });

    it('should convert done content with success', () => {
      const result = adapter.convert({
        chatId: 'cli-test',
        content: { type: 'done', success: true, message: 'Done!' } as any,
      });
      expect(result).toContain('✅');
      expect(result).toContain('Done!');
    });

    it('should convert done content with failure', () => {
      const result = adapter.convert({
        chatId: 'cli-test',
        content: { type: 'done', success: false, error: 'Failed' } as any,
      });
      expect(result).toContain('❌');
      expect(result).toContain('Failed');
    });

    it('should handle unknown content type', () => {
      const result = adapter.convert({
        chatId: 'cli-test',
        content: { type: 'unknown_type' } as any,
      });
      expect(result).toContain('Unknown message type');
    });
  });

  describe('send', () => {
    it('should return success with messageId', async () => {
      const result = await adapter.send({
        chatId: 'cli-test',
        content: { type: 'text', text: 'Hello!' },
      });
      expect(result.success).toBe(true);
      expect(result.messageId).toMatch(/^cli-\d+$/);
    });
  });
});

describe('createCliAdapter', () => {
  it('should create a CliAdapter instance', () => {
    const adapter = createCliAdapter();
    expect(adapter).toBeInstanceOf(CliAdapter);
  });
});
