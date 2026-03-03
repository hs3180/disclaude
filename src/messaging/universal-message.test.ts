/**
 * Tests for Universal Message Format (UMF).
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
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
  type TextContent,
  type MarkdownContent,
  type CardContent,
  type FileContent,
  type DoneContent,
} from './universal-message.js';

describe('Universal Message Format', () => {
  describe('Type Guards', () => {
    it('should identify TextContent', () => {
      const content: TextContent = { type: 'text', text: 'Hello' };
      expect(isTextContent(content)).toBe(true);
      expect(isMarkdownContent(content)).toBe(false);
      expect(isCardContent(content)).toBe(false);
    });

    it('should identify MarkdownContent', () => {
      const content: MarkdownContent = { type: 'markdown', text: '**Bold**' };
      expect(isMarkdownContent(content)).toBe(true);
      expect(isTextContent(content)).toBe(false);
    });

    it('should identify CardContent', () => {
      const content: CardContent = {
        type: 'card',
        title: 'Title',
        sections: [{ type: 'text', content: 'Content' }],
      };
      expect(isCardContent(content)).toBe(true);
      expect(isTextContent(content)).toBe(false);
    });

    it('should identify FileContent', () => {
      const content: FileContent = { type: 'file', path: '/path/to/file' };
      expect(isFileContent(content)).toBe(true);
    });

    it('should identify DoneContent', () => {
      const content: DoneContent = { type: 'done', success: true };
      expect(isDoneContent(content)).toBe(true);
    });
  });

  describe('Helper Functions', () => {
    describe('createTextMessage', () => {
      it('should create a text message', () => {
        const msg = createTextMessage('oc_xxx', 'Hello');
        expect(msg.chatId).toBe('oc_xxx');
        expect(msg.content.type).toBe('text');
        expect(isTextContent(msg.content) && msg.content.text).toBe('Hello');
        expect(msg.threadId).toBeUndefined();
      });

      it('should create a text message with threadId', () => {
        const msg = createTextMessage('oc_xxx', 'Hello', 'thread_123');
        expect(msg.threadId).toBe('thread_123');
      });
    });

    describe('createMarkdownMessage', () => {
      it('should create a markdown message', () => {
        const msg = createMarkdownMessage('oc_xxx', '**Bold**');
        expect(msg.chatId).toBe('oc_xxx');
        expect(msg.content.type).toBe('markdown');
        expect(isMarkdownContent(msg.content) && msg.content.text).toBe('**Bold**');
      });
    });

    describe('createCardMessage', () => {
      it('should create a card message with minimal options', () => {
        const msg = createCardMessage('oc_xxx', 'Title', [
          { type: 'text', content: 'Content' },
        ]);
        expect(msg.chatId).toBe('oc_xxx');
        expect(msg.content.type).toBe('card');
        if (isCardContent(msg.content)) {
          expect(msg.content.title).toBe('Title');
          expect(msg.content.sections).toHaveLength(1);
          expect(msg.content.subtitle).toBeUndefined();
          expect(msg.content.actions).toBeUndefined();
        }
      });

      it('should create a card message with all options', () => {
        const msg = createCardMessage('oc_xxx', 'Title', [
          { type: 'text', content: 'Content' },
        ], {
          subtitle: 'Subtitle',
          actions: [{ type: 'button', label: 'Click', value: 'click' }],
          theme: 'green',
          threadId: 'thread_123',
        });
        if (isCardContent(msg.content)) {
          expect(msg.content.subtitle).toBe('Subtitle');
          expect(msg.content.actions).toHaveLength(1);
          expect(msg.content.theme).toBe('green');
        }
        expect(msg.threadId).toBe('thread_123');
      });
    });

    describe('createDoneMessage', () => {
      it('should create a success done message', () => {
        const msg = createDoneMessage('oc_xxx', true, 'Task completed');
        expect(msg.chatId).toBe('oc_xxx');
        expect(msg.content.type).toBe('done');
        if (isDoneContent(msg.content)) {
          expect(msg.content.success).toBe(true);
          expect(msg.content.message).toBe('Task completed');
          expect(msg.content.error).toBeUndefined();
        }
      });

      it('should create a failure done message', () => {
        const msg = createDoneMessage('oc_xxx', false, undefined, 'Error occurred');
        if (isDoneContent(msg.content)) {
          expect(msg.content.success).toBe(false);
          expect(msg.content.message).toBeUndefined();
          expect(msg.content.error).toBe('Error occurred');
        }
      });
    });
  });
});
