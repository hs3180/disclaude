/**
 * Tests for Universal Message Format (packages/core/src/messaging/universal-message.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,
  createTextMessage,
  createMarkdownMessage,
  createCardMessage,
  createDoneMessage,
} from './universal-message.js';
import type { MessageContent } from './universal-message.js';

describe('Type Guards', () => {
  describe('isTextContent', () => {
    it('should return true for text content', () => {
      const content: MessageContent = { type: 'text', text: 'hello' };
      expect(isTextContent(content)).toBe(true);
    });

    it('should return false for non-text content', () => {
      const content: MessageContent = { type: 'markdown', text: 'hello' };
      expect(isTextContent(content)).toBe(false);
    });

    it('should narrow type to TextContent', () => {
      const content: MessageContent = { type: 'text', text: 'hello' };
      if (isTextContent(content)) {
        expect(content.text).toBe('hello');
      }
    });
  });

  describe('isMarkdownContent', () => {
    it('should return true for markdown content', () => {
      const content: MessageContent = { type: 'markdown', text: '# Hello' };
      expect(isMarkdownContent(content)).toBe(true);
    });

    it('should return false for non-markdown content', () => {
      const content: MessageContent = { type: 'text', text: 'hello' };
      expect(isMarkdownContent(content)).toBe(false);
    });

    it('should narrow type to MarkdownContent', () => {
      const content: MessageContent = { type: 'markdown', text: '# Hello' };
      if (isMarkdownContent(content)) {
        expect(content.text).toBe('# Hello');
      }
    });
  });

  describe('isCardContent', () => {
    it('should return true for card content', () => {
      const content: MessageContent = {
        type: 'card',
        title: 'Test',
        sections: [],
      };
      expect(isCardContent(content)).toBe(true);
    });

    it('should return false for non-card content', () => {
      const content: MessageContent = { type: 'text', text: 'hello' };
      expect(isCardContent(content)).toBe(false);
    });

    it('should narrow type to CardContent', () => {
      const content: MessageContent = {
        type: 'card',
        title: 'Test',
        sections: [{ type: 'text', content: 'body' }],
      };
      if (isCardContent(content)) {
        expect(content.title).toBe('Test');
        expect(content.sections).toHaveLength(1);
      }
    });
  });

  describe('isFileContent', () => {
    it('should return true for file content', () => {
      const content: MessageContent = { type: 'file', path: '/path/to/file' };
      expect(isFileContent(content)).toBe(true);
    });

    it('should return false for non-file content', () => {
      const content: MessageContent = { type: 'text', text: 'hello' };
      expect(isFileContent(content)).toBe(false);
    });

    it('should narrow type to FileContent', () => {
      const content: MessageContent = { type: 'file', path: '/path/to/file.pdf', name: 'doc.pdf' };
      if (isFileContent(content)) {
        expect(content.path).toBe('/path/to/file.pdf');
        expect(content.name).toBe('doc.pdf');
      }
    });
  });

  describe('isDoneContent', () => {
    it('should return true for done content', () => {
      const content: MessageContent = { type: 'done', success: true };
      expect(isDoneContent(content)).toBe(true);
    });

    it('should return false for non-done content', () => {
      const content: MessageContent = { type: 'text', text: 'hello' };
      expect(isDoneContent(content)).toBe(false);
    });

    it('should narrow type to DoneContent', () => {
      const content: MessageContent = { type: 'done', success: false, error: 'fail' };
      if (isDoneContent(content)) {
        expect(content.success).toBe(false);
        expect(content.error).toBe('fail');
      }
    });
  });
});

describe('Factory Functions', () => {
  describe('createTextMessage', () => {
    it('should create a text message', () => {
      const msg = createTextMessage('oc_123', 'Hello');
      expect(msg.chatId).toBe('oc_123');
      expect(msg.content).toEqual({ type: 'text', text: 'Hello' });
    });

    it('should include threadId when provided', () => {
      const msg = createTextMessage('oc_123', 'Hello', 'thread_1');
      expect(msg.threadId).toBe('thread_1');
    });

    it('should not include threadId when not provided', () => {
      const msg = createTextMessage('oc_123', 'Hello');
      expect(msg.threadId).toBeUndefined();
    });

    it('should handle empty text', () => {
      const msg = createTextMessage('oc_123', '');
      expect(msg.content.text).toBe('');
    });
  });

  describe('createMarkdownMessage', () => {
    it('should create a markdown message', () => {
      const msg = createMarkdownMessage('oc_123', '# Title');
      expect(msg.chatId).toBe('oc_123');
      expect(msg.content).toEqual({ type: 'markdown', text: '# Title' });
    });

    it('should include threadId when provided', () => {
      const msg = createMarkdownMessage('oc_123', '# Title', 'thread_1');
      expect(msg.threadId).toBe('thread_1');
    });

    it('should not include threadId when not provided', () => {
      const msg = createMarkdownMessage('oc_123', '# Title');
      expect(msg.threadId).toBeUndefined();
    });
  });

  describe('createCardMessage', () => {
    it('should create a card message with title and sections', () => {
      const msg = createCardMessage('oc_123', 'Task Complete', [
        { type: 'text', content: 'All done!' },
      ]);
      expect(msg.chatId).toBe('oc_123');
      expect(msg.content.type).toBe('card');
      if (msg.content.type === 'card') {
        expect(msg.content.title).toBe('Task Complete');
        expect(msg.content.sections).toHaveLength(1);
        expect(msg.content.sections[0].content).toBe('All done!');
      }
    });

    it('should include optional subtitle', () => {
      const msg = createCardMessage('oc_123', 'Title', [], { subtitle: 'Subtitle' });
      if (msg.content.type === 'card') {
        expect(msg.content.subtitle).toBe('Subtitle');
      }
    });

    it('should include actions when provided', () => {
      const actions = [{ type: 'button' as const, label: 'OK', value: 'ok' }];
      const msg = createCardMessage('oc_123', 'Title', [], { actions });
      if (msg.content.type === 'card') {
        expect(msg.content.actions).toHaveLength(1);
        expect(msg.content.actions![0].label).toBe('OK');
      }
    });

    it('should include theme when provided', () => {
      const msg = createCardMessage('oc_123', 'Title', [], { theme: 'blue' });
      if (msg.content.type === 'card') {
        expect(msg.content.theme).toBe('blue');
      }
    });

    it('should include threadId when provided', () => {
      const msg = createCardMessage('oc_123', 'Title', [], { threadId: 'thread_1' });
      expect(msg.threadId).toBe('thread_1');
    });

    it('should handle empty sections', () => {
      const msg = createCardMessage('oc_123', 'Title', []);
      if (msg.content.type === 'card') {
        expect(msg.content.sections).toHaveLength(0);
      }
    });

    it('should handle multiple section types', () => {
      const sections = [
        { type: 'markdown' as const, content: '**Bold**' },
        { type: 'divider' as const },
        { type: 'fields' as const, fields: [{ label: 'Status', value: 'OK' }] },
      ];
      const msg = createCardMessage('oc_123', 'Title', sections);
      if (msg.content.type === 'card') {
        expect(msg.content.sections).toHaveLength(3);
        expect(msg.content.sections[0].type).toBe('markdown');
        expect(msg.content.sections[1].type).toBe('divider');
        expect(msg.content.sections[2].type).toBe('fields');
      }
    });
  });

  describe('createDoneMessage', () => {
    it('should create a success done message', () => {
      const msg = createDoneMessage('oc_123', true, 'Task completed');
      expect(msg.chatId).toBe('oc_123');
      expect(msg.content).toEqual({ type: 'done', success: true, message: 'Task completed' });
    });

    it('should create a failure done message', () => {
      const msg = createDoneMessage('oc_123', false, undefined, 'Something failed');
      expect(msg.content).toEqual({ type: 'done', success: false, error: 'Something failed' });
    });

    it('should create done message with only success flag', () => {
      const msg = createDoneMessage('oc_123', true);
      if (msg.content.type === 'done') {
        expect(msg.content.success).toBe(true);
        expect(msg.content.message).toBeUndefined();
        expect(msg.content.error).toBeUndefined();
      }
    });

    it('should create done message with both message and error', () => {
      const msg = createDoneMessage('oc_123', false, 'Partial success', 'Timeout');
      if (msg.content.type === 'done') {
        expect(msg.content.message).toBe('Partial success');
        expect(msg.content.error).toBe('Timeout');
      }
    });
  });
});
