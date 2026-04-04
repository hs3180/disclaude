/**
 * Tests for Universal Message Format (UMF).
 *
 * Verifies type guards and helper functions for creating
 * platform-agnostic message types.
 *
 * Issue #1617: Phase 2 - messaging module test coverage.
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
      const content: MessageContent = { type: 'text', text: 'Hello' };
      expect(isTextContent(content)).toBe(true);
    });

    it('should return false for non-text content', () => {
      expect(isTextContent({ type: 'markdown' as const, text: '**bold**' })).toBe(false);
      expect(isTextContent({ type: 'card' as const, title: 'Title', sections: [] })).toBe(false);
      expect(isTextContent({ type: 'file' as const, path: '/tmp/file.txt' })).toBe(false);
      expect(isTextContent({ type: 'done' as const, success: true })).toBe(false);
    });
  });

  describe('isMarkdownContent', () => {
    it('should return true for markdown content', () => {
      const content: MessageContent = { type: 'markdown', text: '**bold**' };
      expect(isMarkdownContent(content)).toBe(true);
    });

    it('should return false for non-markdown content', () => {
      expect(isMarkdownContent({ type: 'text' as const, text: 'plain' })).toBe(false);
      expect(isMarkdownContent({ type: 'card' as const, title: 'T', sections: [] })).toBe(false);
    });
  });

  describe('isCardContent', () => {
    it('should return true for card content', () => {
      const content: MessageContent = {
        type: 'card',
        title: 'Card Title',
        sections: [{ type: 'text', content: 'Body text' }],
      };
      expect(isCardContent(content)).toBe(true);
    });

    it('should return false for non-card content', () => {
      expect(isCardContent({ type: 'text' as const, text: 'plain' })).toBe(false);
      expect(isCardContent({ type: 'done' as const, success: true })).toBe(false);
    });
  });

  describe('isFileContent', () => {
    it('should return true for file content', () => {
      const content: MessageContent = {
        type: 'file',
        path: '/tmp/test.pdf',
        name: 'test.pdf',
        mimeType: 'application/pdf',
      };
      expect(isFileContent(content)).toBe(true);
    });

    it('should return true for file content with minimal fields', () => {
      const content: MessageContent = { type: 'file', path: '/tmp/file.txt' };
      expect(isFileContent(content)).toBe(true);
    });

    it('should return false for non-file content', () => {
      expect(isFileContent({ type: 'text' as const, text: 'plain' })).toBe(false);
      expect(isFileContent({ type: 'card' as const, title: 'T', sections: [] })).toBe(false);
    });
  });

  describe('isDoneContent', () => {
    it('should return true for successful done content', () => {
      const content: MessageContent = { type: 'done', success: true, message: 'Completed' };
      expect(isDoneContent(content)).toBe(true);
    });

    it('should return true for failed done content', () => {
      const content: MessageContent = {
        type: 'done',
        success: false,
        message: 'Failed',
        error: 'Connection timeout',
      };
      expect(isDoneContent(content)).toBe(true);
    });

    it('should return false for non-done content', () => {
      expect(isDoneContent({ type: 'text' as const, text: 'plain' })).toBe(false);
    });
  });

  describe('type guard narrowing', () => {
    it('isTextContent should narrow type to TextContent', () => {
      const content: MessageContent = { type: 'text', text: 'Hello' };
      if (isTextContent(content)) {
        // TypeScript should narrow this to TextContent
        const text: string = content.text;
        expect(text).toBe('Hello');
      }
    });

    it('isCardContent should narrow type to CardContent', () => {
      const content: MessageContent = {
        type: 'card',
        title: 'Title',
        sections: [],
      };
      if (isCardContent(content)) {
        const title: string = content.title;
        expect(title).toBe('Title');
        expect(content.sections).toEqual([]);
      }
    });
  });
});

describe('createTextMessage', () => {
  it('should create a text message with required fields', () => {
    const msg = createTextMessage('chat-1', 'Hello world');

    expect(msg.chatId).toBe('chat-1');
    expect(msg.content.type).toBe('text');
    if (isTextContent(msg.content)) {
      expect(msg.content.text).toBe('Hello world');
    }
    expect(msg.threadId).toBeUndefined();
    expect(msg.metadata).toBeUndefined();
  });

  it('should create a text message with threadId', () => {
    const msg = createTextMessage('chat-1', 'Reply', 'thread-123');
    expect(msg.threadId).toBe('thread-123');
  });

  it('should handle empty text', () => {
    const msg = createTextMessage('chat-1', '');
    expect(isTextContent(msg.content)).toBe(true);
    if (isTextContent(msg.content)) {
      expect(msg.content.text).toBe('');
    }
  });

  it('should handle special characters in text', () => {
    const text = 'Hello "world" <>&\'\\n\t';
    const msg = createTextMessage('chat-1', text);
    if (isTextContent(msg.content)) {
      expect(msg.content.text).toBe(text);
    }
  });
});

describe('createMarkdownMessage', () => {
  it('should create a markdown message with required fields', () => {
    const msg = createMarkdownMessage('chat-1', '**bold text**');

    expect(msg.chatId).toBe('chat-1');
    expect(msg.content.type).toBe('markdown');
    if (isMarkdownContent(msg.content)) {
      expect(msg.content.text).toBe('**bold text**');
    }
  });

  it('should create a markdown message with threadId', () => {
    const msg = createMarkdownMessage('chat-1', '# Header', 'thread-456');
    expect(msg.threadId).toBe('thread-456');
  });

  it('should handle complex markdown content', () => {
    const markdown = `# Title

- item 1
- item 2

\`\`\`typescript
const x = 1;
\`\`\`
`;
    const msg = createMarkdownMessage('chat-1', markdown);
    if (isMarkdownContent(msg.content)) {
      expect(msg.content.text).toBe(markdown);
    }
  });
});

describe('createCardMessage', () => {
  it('should create a card message with title and sections', () => {
    const msg = createCardMessage('chat-1', 'Task Complete', [
      { type: 'text', content: 'All files processed.' },
    ]);

    expect(msg.chatId).toBe('chat-1');
    expect(msg.content.type).toBe('card');
    if (isCardContent(msg.content)) {
      expect(msg.content.title).toBe('Task Complete');
      expect(msg.content.sections).toHaveLength(1);
      expect(msg.content.subtitle).toBeUndefined();
      expect(msg.content.actions).toBeUndefined();
      expect(msg.content.theme).toBeUndefined();
    }
  });

  it('should create a card with all options', () => {
    const msg = createCardMessage('chat-1', 'Report', [
      { type: 'text', content: 'Summary...' },
      { type: 'markdown', content: '**Key metrics**' },
    ], {
      subtitle: 'Weekly Report',
      actions: [
        { type: 'button', label: 'View Details', value: 'view_details', style: 'primary' },
        { type: 'button', label: 'Dismiss', value: 'dismiss' },
      ],
      theme: 'blue',
      threadId: 'thread-789',
    });

    expect(msg.threadId).toBe('thread-789');
    if (isCardContent(msg.content)) {
      expect(msg.content.subtitle).toBe('Weekly Report');
      expect(msg.content.actions).toHaveLength(2);
      expect(msg.content.theme).toBe('blue');
    }
  });

  it('should create a card with empty sections', () => {
    const msg = createCardMessage('chat-1', 'Empty Card', []);
    if (isCardContent(msg.content)) {
      expect(msg.content.sections).toEqual([]);
    }
  });

  it('should support all section types', () => {
    const msg = createCardMessage('chat-1', 'Rich Card', [
      { type: 'text', content: 'Text section' },
      { type: 'markdown', content: '**Bold**' },
      { type: 'image', imageUrl: 'https://example.com/image.png' },
      { type: 'divider' },
      { type: 'fields', fields: [{ label: 'Status', value: 'Active' }] },
    ]);

    if (isCardContent(msg.content)) {
      expect(msg.content.sections).toHaveLength(5);
      expect(msg.content.sections[0].type).toBe('text');
      expect(msg.content.sections[2].type).toBe('image');
      expect(msg.content.sections[3].type).toBe('divider');
      expect(msg.content.sections[4].type).toBe('fields');
    }
  });

  it('should support all action types', () => {
    const msg = createCardMessage('chat-1', 'Actions Card', [], {
      actions: [
        { type: 'button', label: 'Click', value: 'click', style: 'primary' },
        { type: 'button', label: 'Cancel', value: 'cancel', style: 'danger' },
        { type: 'select', label: 'Choose', value: 'choose', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
        { type: 'link', label: 'Open', value: 'open', url: 'https://example.com' },
      ],
    });

    if (isCardContent(msg.content)) {
      expect(msg.content.actions).toHaveLength(4);
    }
  });

  it('should support all button styles', () => {
    const styles: Array<'primary' | 'secondary' | 'danger'> = ['primary', 'secondary', 'danger'];

    for (const style of styles) {
      const msg = createCardMessage('chat-1', 'Style Card', [], {
        actions: [{ type: 'button', label: style, value: style, style }],
      });

      if (isCardContent(msg.content)) {
        expect(msg.content.actions![0].style).toBe(style);
      }
    }
  });
});

describe('createDoneMessage', () => {
  it('should create a success done message', () => {
    const msg = createDoneMessage('chat-1', true, 'Task completed');

    expect(msg.chatId).toBe('chat-1');
    expect(msg.content.type).toBe('done');
    if (isDoneContent(msg.content)) {
      expect(msg.content.success).toBe(true);
      expect(msg.content.message).toBe('Task completed');
      expect(msg.content.error).toBeUndefined();
    }
  });

  it('should create a failure done message', () => {
    const msg = createDoneMessage('chat-1', false, undefined, 'Connection timeout');

    if (isDoneContent(msg.content)) {
      expect(msg.content.success).toBe(false);
      expect(msg.content.message).toBeUndefined();
      expect(msg.content.error).toBe('Connection timeout');
    }
  });

  it('should create done message with both message and error', () => {
    const msg = createDoneMessage('chat-1', false, 'Partial failure', 'Step 3 failed');

    if (isDoneContent(msg.content)) {
      expect(msg.content.message).toBe('Partial failure');
      expect(msg.content.error).toBe('Step 3 failed');
    }
  });

  it('should create minimal done message', () => {
    const msg = createDoneMessage('chat-1', true);

    if (isDoneContent(msg.content)) {
      expect(msg.content.success).toBe(true);
      expect(msg.content.message).toBeUndefined();
      expect(msg.content.error).toBeUndefined();
    }
  });
});
