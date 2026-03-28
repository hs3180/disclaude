/**
 * Unit tests for Universal Message Format (UMF) types and helpers.
 *
 * Tests type guards and helper functions for creating platform-agnostic messages.
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
  type MessageContent,
  type UniversalMessage,
} from './universal-message.js';

describe('Universal Message - Type Guards', () => {
  describe('isTextContent', () => {
    it('should return true for text content', () => {
      expect(isTextContent({ type: 'text', text: 'hello' })).toBe(true);
    });

    it('should return false for non-text content', () => {
      expect(isTextContent({ type: 'markdown', text: '**hello**' })).toBe(false);
      expect(isTextContent({ type: 'card', title: 'Title', sections: [] })).toBe(false);
      expect(isTextContent({ type: 'file', path: '/path' })).toBe(false);
      expect(isTextContent({ type: 'done', success: true })).toBe(false);
    });
  });

  describe('isMarkdownContent', () => {
    it('should return true for markdown content', () => {
      expect(isMarkdownContent({ type: 'markdown', text: '**hello**' })).toBe(true);
    });

    it('should return false for non-markdown content', () => {
      expect(isMarkdownContent({ type: 'text', text: 'hello' })).toBe(false);
      expect(isMarkdownContent({ type: 'card', title: 'Title', sections: [] })).toBe(false);
    });
  });

  describe('isCardContent', () => {
    it('should return true for card content', () => {
      const card = {
        type: 'card' as const,
        title: 'Test Card',
        sections: [{ type: 'text', content: 'Body' }],
      };
      expect(isCardContent(card)).toBe(true);
    });

    it('should return false for non-card content', () => {
      expect(isCardContent({ type: 'text', text: 'hello' })).toBe(false);
      expect(isCardContent({ type: 'markdown', text: '**hello**' })).toBe(false);
    });
  });

  describe('isFileContent', () => {
    it('should return true for file content', () => {
      expect(isFileContent({ type: 'file', path: '/path/to/file.pdf' })).toBe(true);
    });

    it('should return true for file content with optional fields', () => {
      expect(isFileContent({
        type: 'file',
        path: '/path/to/file.pdf',
        name: 'file.pdf',
        mimeType: 'application/pdf',
      })).toBe(true);
    });

    it('should return false for non-file content', () => {
      expect(isFileContent({ type: 'text', text: 'hello' })).toBe(false);
    });
  });

  describe('isDoneContent', () => {
    it('should return true for done content with success', () => {
      expect(isDoneContent({ type: 'done', success: true, message: 'Completed' })).toBe(true);
    });

    it('should return true for done content with failure', () => {
      expect(isDoneContent({ type: 'done', success: false, error: 'Failed' })).toBe(true);
    });

    it('should return false for non-done content', () => {
      expect(isDoneContent({ type: 'text', text: 'hello' })).toBe(false);
    });
  });
});

describe('Universal Message - Helper Functions', () => {
  describe('createTextMessage', () => {
    it('should create a text message with required fields', () => {
      const msg = createTextMessage('chat-1', 'Hello World');

      expect(msg.chatId).toBe('chat-1');
      expect(msg.content.type).toBe('text');
      if (msg.content.type === 'text') {
        expect(msg.content.text).toBe('Hello World');
      }
      expect(msg.threadId).toBeUndefined();
    });

    it('should create a text message with optional threadId', () => {
      const msg = createTextMessage('chat-1', 'Hello', 'thread-123');

      expect(msg.threadId).toBe('thread-123');
    });

    it('should handle empty text', () => {
      const msg = createTextMessage('chat-1', '');

      expect(msg.content.type).toBe('text');
      if (msg.content.type === 'text') {
        expect(msg.content.text).toBe('');
      }
    });

    it('should handle long text', () => {
      const longText = 'a'.repeat(10000);
      const msg = createTextMessage('chat-1', longText);

      if (msg.content.type === 'text') {
        expect(msg.content.text).toBe(longText);
      }
    });
  });

  describe('createMarkdownMessage', () => {
    it('should create a markdown message with required fields', () => {
      const msg = createMarkdownMessage('chat-1', '**Bold**');

      expect(msg.chatId).toBe('chat-1');
      expect(msg.content.type).toBe('markdown');
      if (msg.content.type === 'markdown') {
        expect(msg.content.text).toBe('**Bold**');
      }
    });

    it('should create a markdown message with optional threadId', () => {
      const msg = createMarkdownMessage('chat-1', '# Title', 'thread-456');

      expect(msg.threadId).toBe('thread-456');
    });
  });

  describe('createCardMessage', () => {
    it('should create a card message with title and sections', () => {
      const msg = createCardMessage('chat-1', 'Status', [
        { type: 'text', content: 'All good' },
      ]);

      expect(msg.chatId).toBe('chat-1');
      expect(msg.content.type).toBe('card');
      if (msg.content.type === 'card') {
        expect(msg.content.title).toBe('Status');
        expect(msg.content.sections).toHaveLength(1);
        expect(msg.content.sections[0].content).toBe('All good');
      }
    });

    it('should create a card with all optional fields', () => {
      const msg = createCardMessage('chat-1', 'Task', [
        { type: 'markdown', content: '## Details' },
        { type: 'divider' },
        { type: 'fields', fields: [{ label: 'Status', value: 'Done' }] },
      ], {
        subtitle: 'Sub info',
        actions: [
          { type: 'button', label: 'View', value: 'view_action' },
        ],
        theme: 'blue',
        threadId: 'thread-789',
      });

      expect(msg.threadId).toBe('thread-789');
      if (msg.content.type === 'card') {
        expect(msg.content.subtitle).toBe('Sub info');
        expect(msg.content.actions).toHaveLength(1);
        expect(msg.content.actions![0].label).toBe('View');
        expect(msg.content.theme).toBe('blue');
        expect(msg.content.sections).toHaveLength(3);
      }
    });

    it('should create a card without optional fields', () => {
      const msg = createCardMessage('chat-1', 'Simple', []);

      if (msg.content.type === 'card') {
        expect(msg.content.subtitle).toBeUndefined();
        expect(msg.content.actions).toBeUndefined();
        expect(msg.content.theme).toBeUndefined();
        expect(msg.content.sections).toEqual([]);
      }
    });

    it('should create a card with image sections', () => {
      const msg = createCardMessage('chat-1', 'Image Card', [
        { type: 'image', imageUrl: 'https://example.com/image.png' },
      ]);

      if (msg.content.type === 'card') {
        expect(msg.content.sections[0].type).toBe('image');
        expect(msg.content.sections[0].imageUrl).toBe('https://example.com/image.png');
      }
    });

    it('should create a card with link actions', () => {
      const msg = createCardMessage('chat-1', 'Links', [], {
        actions: [
          { type: 'link', label: 'Open', value: 'open_link', url: 'https://example.com' },
        ],
      });

      if (msg.content.type === 'card') {
        expect(msg.content.actions![0].url).toBe('https://example.com');
      }
    });

    it('should create a card with select actions', () => {
      const msg = createCardMessage('chat-1', 'Options', [], {
        actions: [
          {
            type: 'select',
            label: 'Choose',
            value: 'select_action',
            options: [
              { label: 'A', value: 'a' },
              { label: 'B', value: 'b' },
            ],
          },
        ],
      });

      if (msg.content.type === 'card') {
        expect(msg.content.actions![0].options).toHaveLength(2);
      }
    });

    it('should create a card with danger style button', () => {
      const msg = createCardMessage('chat-1', 'Confirm', [], {
        actions: [
          { type: 'button', label: 'Delete', value: 'delete', style: 'danger' },
        ],
      });

      if (msg.content.type === 'card') {
        expect(msg.content.actions![0].style).toBe('danger');
      }
    });
  });

  describe('createDoneMessage', () => {
    it('should create a done message with success', () => {
      const msg = createDoneMessage('chat-1', true, 'Task completed');

      expect(msg.chatId).toBe('chat-1');
      expect(msg.content.type).toBe('done');
      if (msg.content.type === 'done') {
        expect(msg.content.success).toBe(true);
        expect(msg.content.message).toBe('Task completed');
      }
    });

    it('should create a done message with failure', () => {
      const msg = createDoneMessage('chat-1', false, undefined, 'Something went wrong');

      if (msg.content.type === 'done') {
        expect(msg.content.success).toBe(false);
        expect(msg.content.error).toBe('Something went wrong');
        expect(msg.content.message).toBeUndefined();
      }
    });

    it('should create a done message with both message and error', () => {
      const msg = createDoneMessage('chat-1', false, 'Partial failure', 'Timeout');

      if (msg.content.type === 'done') {
        expect(msg.content.message).toBe('Partial failure');
        expect(msg.content.error).toBe('Timeout');
      }
    });

    it('should create a minimal done message', () => {
      const msg = createDoneMessage('chat-1', true);

      if (msg.content.type === 'done') {
        expect(msg.content.success).toBe(true);
        expect(msg.content.message).toBeUndefined();
        expect(msg.content.error).toBeUndefined();
      }
    });
  });
});
