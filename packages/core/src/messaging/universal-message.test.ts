/**
 * Tests for Universal Message Format.
 *
 * Tests type guards, helper functions, and message creation.
 * @module messaging/universal-message.test
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
  type UniversalMessage,
  type MessageContent,
} from './universal-message.js';

describe('Type Guards', () => {
  describe('isTextContent', () => {
    it('should return true for text content', () => {
      expect(isTextContent({ type: 'text', text: 'Hello' })).toBe(true);
    });

    it('should return false for other content types', () => {
      expect(isTextContent({ type: 'markdown', text: '# Hello' })).toBe(false);
      expect(isTextContent({ type: 'card', title: 'T', sections: [] })).toBe(false);
      expect(isTextContent({ type: 'file', path: '/f' })).toBe(false);
      expect(isTextContent({ type: 'done', success: true })).toBe(false);
    });
  });

  describe('isMarkdownContent', () => {
    it('should return true for markdown content', () => {
      expect(isMarkdownContent({ type: 'markdown', text: '# Hello' })).toBe(true);
    });

    it('should return false for other content types', () => {
      expect(isMarkdownContent({ type: 'text', text: 'Hello' })).toBe(false);
      expect(isMarkdownContent({ type: 'card', title: 'T', sections: [] })).toBe(false);
    });
  });

  describe('isCardContent', () => {
    it('should return true for card content', () => {
      expect(isCardContent({ type: 'card', title: 'Title', sections: [] })).toBe(true);
    });

    it('should return false for other content types', () => {
      expect(isCardContent({ type: 'text', text: 'Hello' })).toBe(false);
      expect(isCardContent({ type: 'markdown', text: '# Hello' })).toBe(false);
    });
  });

  describe('isFileContent', () => {
    it('should return true for file content', () => {
      expect(isFileContent({ type: 'file', path: '/path/to/file.pdf' })).toBe(true);
    });

    it('should return false for other content types', () => {
      expect(isFileContent({ type: 'text', text: 'Hello' })).toBe(false);
      expect(isFileContent({ type: 'done', success: true })).toBe(false);
    });
  });

  describe('isDoneContent', () => {
    it('should return true for done content', () => {
      expect(isDoneContent({ type: 'done', success: true })).toBe(true);
      expect(isDoneContent({ type: 'done', success: false, error: 'Failed' })).toBe(true);
    });

    it('should return false for other content types', () => {
      expect(isDoneContent({ type: 'text', text: 'Hello' })).toBe(false);
      expect(isDoneContent({ type: 'card', title: 'T', sections: [] })).toBe(false);
    });
  });
});

describe('createTextMessage', () => {
  it('should create a text message', () => {
    const msg = createTextMessage('oc_chat1', 'Hello world');

    expect(msg.chatId).toBe('oc_chat1');
    expect(msg.content.type).toBe('text');
    if (msg.content.type === 'text') {
      expect(msg.content.text).toBe('Hello world');
    }
    expect(msg.threadId).toBeUndefined();
  });

  it('should create a text message with threadId', () => {
    const msg = createTextMessage('oc_chat1', 'Reply', 'thread_123');

    expect(msg.threadId).toBe('thread_123');
  });

  it('should create a text message with metadata', () => {
    const msg: UniversalMessage = {
      ...createTextMessage('oc_chat1', 'Hello'),
      metadata: { messageId: 'msg_1', priority: 'high' },
    };

    expect(msg.metadata?.messageId).toBe('msg_1');
    expect(msg.metadata?.priority).toBe('high');
  });
});

describe('createMarkdownMessage', () => {
  it('should create a markdown message', () => {
    const msg = createMarkdownMessage('oc_chat1', '# Title\n\nContent');

    expect(msg.chatId).toBe('oc_chat1');
    expect(msg.content.type).toBe('markdown');
    if (msg.content.type === 'markdown') {
      expect(msg.content.text).toBe('# Title\n\nContent');
    }
  });

  it('should create a markdown message with threadId', () => {
    const msg = createMarkdownMessage('oc_chat1', '# Reply', 'thread_456');

    expect(msg.threadId).toBe('thread_456');
  });
});

describe('createCardMessage', () => {
  it('should create a card message with sections', () => {
    const msg = createCardMessage('oc_chat1', 'Task Complete', [
      { type: 'text', content: 'All tests passed' },
      { type: 'divider' },
    ]);

    expect(msg.content.type).toBe('card');
    if (msg.content.type === 'card') {
      expect(msg.content.title).toBe('Task Complete');
      expect(msg.content.sections).toHaveLength(2);
      expect(msg.content.sections[0].type).toBe('text');
      expect(msg.content.sections[1].type).toBe('divider');
    }
  });

  it('should create a card with subtitle', () => {
    const msg = createCardMessage('oc_chat1', 'Title', [], {
      subtitle: 'Subtitle',
    });

    if (msg.content.type === 'card') {
      expect(msg.content.subtitle).toBe('Subtitle');
    }
  });

  it('should create a card with actions', () => {
    const msg = createCardMessage('oc_chat1', 'Choose', [], {
      actions: [
        { type: 'button', label: 'Confirm', value: 'confirm', style: 'primary' },
        { type: 'link', label: 'Docs', value: 'docs', url: 'https://docs.example.com' },
      ],
    });

    if (msg.content.type === 'card') {
      expect(msg.content.actions).toHaveLength(2);
      expect(msg.content.actions![0].type).toBe('button');
      expect(msg.content.actions![1].type).toBe('link');
      expect(msg.content.actions![1].url).toBe('https://docs.example.com');
    }
  });

  it('should create a card with theme', () => {
    const msg = createCardMessage('oc_chat1', 'Title', [], {
      theme: 'green',
    });

    if (msg.content.type === 'card') {
      expect(msg.content.theme).toBe('green');
    }
  });

  it('should create a card with threadId', () => {
    const msg = createCardMessage('oc_chat1', 'Title', [], {
      threadId: 'thread_789',
    });

    expect(msg.threadId).toBe('thread_789');
  });

  it('should create a card with fields section', () => {
    const msg = createCardMessage('oc_chat1', 'Stats', [
      { type: 'fields', fields: [{ label: 'Tests', value: '100/100' }, { label: 'Coverage', value: '85%' }] },
    ]);

    if (msg.content.type === 'card') {
      expect(msg.content.sections[0].type).toBe('fields');
      expect(msg.content.sections[0].fields).toHaveLength(2);
    }
  });
});

describe('createDoneMessage', () => {
  it('should create a done message for success', () => {
    const msg = createDoneMessage('oc_chat1', true, 'Task completed');

    expect(msg.content.type).toBe('done');
    if (msg.content.type === 'done') {
      expect(msg.content.success).toBe(true);
      expect(msg.content.message).toBe('Task completed');
      expect(msg.content.error).toBeUndefined();
    }
  });

  it('should create a done message for failure', () => {
    const msg = createDoneMessage('oc_chat1', false, undefined, 'Out of memory');

    if (msg.content.type === 'done') {
      expect(msg.content.success).toBe(false);
      expect(msg.content.error).toBe('Out of memory');
    }
  });

  it('should create a done message without message or error', () => {
    const msg = createDoneMessage('oc_chat1', true);

    if (msg.content.type === 'done') {
      expect(msg.content.success).toBe(true);
      expect(msg.content.message).toBeUndefined();
      expect(msg.content.error).toBeUndefined();
    }
  });
});

describe('Type narrowing with type guards', () => {
  it('should narrow MessageContent union to TextContent', () => {
    const content: MessageContent = { type: 'text', text: 'Hello' };

    if (isTextContent(content)) {
      // TypeScript should know this is TextContent
      expect(content.text).toBe('Hello');
    }
  });

  it('should narrow MessageContent union to CardContent', () => {
    const content: MessageContent = {
      type: 'card',
      title: 'Title',
      sections: [{ type: 'text', content: 'Body' }],
    };

    if (isCardContent(content)) {
      expect(content.title).toBe('Title');
      expect(content.sections[0].content).toBe('Body');
    }
  });

  it('should handle all content types in switch', () => {
    const contents: MessageContent[] = [
      { type: 'text', text: 'Hello' },
      { type: 'markdown', text: '# Hello' },
      { type: 'card', title: 'T', sections: [] },
      { type: 'file', path: '/f' },
      { type: 'done', success: true },
    ];

    for (const content of contents) {
      switch (content.type) {
        case 'text': expect(isTextContent(content)).toBe(true); break;
        case 'markdown': expect(isMarkdownContent(content)).toBe(true); break;
        case 'card': expect(isCardContent(content)).toBe(true); break;
        case 'file': expect(isFileContent(content)).toBe(true); break;
        case 'done': expect(isDoneContent(content)).toBe(true); break;
      }
    }
  });
});
