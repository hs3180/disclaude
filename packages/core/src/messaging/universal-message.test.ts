/**
 * Tests for Universal Message Format (UMF)
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
} from './universal-message.js';
import type {
  TextContent,
  MarkdownContent,
  CardContent,
  FileContent,
  DoneContent,
  CardSection,
  CardAction,
} from './universal-message.js';

describe('Universal Message - Type Guards', () => {
  const textContent: TextContent = { type: 'text', text: 'Hello' };
  const markdownContent: MarkdownContent = { type: 'markdown', text: '**Bold**' };
  const cardContent: CardContent = {
    type: 'card',
    title: 'Test Card',
    sections: [{ type: 'text', content: 'Section text' }],
  };
  const fileContent: FileContent = { type: 'file', path: '/path/to/file.pdf' };
  const doneContent: DoneContent = { type: 'done', success: true };

  describe('isTextContent', () => {
    it('returns true for TextContent', () => {
      expect(isTextContent(textContent)).toBe(true);
    });

    it('returns false for other content types', () => {
      expect(isTextContent(markdownContent)).toBe(false);
      expect(isTextContent(cardContent)).toBe(false);
      expect(isTextContent(fileContent)).toBe(false);
      expect(isTextContent(doneContent)).toBe(false);
    });
  });

  describe('isMarkdownContent', () => {
    it('returns true for MarkdownContent', () => {
      expect(isMarkdownContent(markdownContent)).toBe(true);
    });

    it('returns false for other content types', () => {
      expect(isMarkdownContent(textContent)).toBe(false);
      expect(isMarkdownContent(cardContent)).toBe(false);
      expect(isMarkdownContent(fileContent)).toBe(false);
      expect(isMarkdownContent(doneContent)).toBe(false);
    });
  });

  describe('isCardContent', () => {
    it('returns true for CardContent', () => {
      expect(isCardContent(cardContent)).toBe(true);
    });

    it('returns false for other content types', () => {
      expect(isCardContent(textContent)).toBe(false);
      expect(isCardContent(markdownContent)).toBe(false);
      expect(isCardContent(fileContent)).toBe(false);
      expect(isCardContent(doneContent)).toBe(false);
    });
  });

  describe('isFileContent', () => {
    it('returns true for FileContent', () => {
      expect(isFileContent(fileContent)).toBe(true);
    });

    it('returns false for other content types', () => {
      expect(isFileContent(textContent)).toBe(false);
      expect(isFileContent(markdownContent)).toBe(false);
      expect(isFileContent(cardContent)).toBe(false);
      expect(isFileContent(doneContent)).toBe(false);
    });
  });

  describe('isDoneContent', () => {
    it('returns true for DoneContent', () => {
      expect(isDoneContent(doneContent)).toBe(true);
    });

    it('returns false for other content types', () => {
      expect(isDoneContent(textContent)).toBe(false);
      expect(isDoneContent(markdownContent)).toBe(false);
      expect(isDoneContent(cardContent)).toBe(false);
      expect(isDoneContent(fileContent)).toBe(false);
    });
  });
});

describe('Universal Message - Factory Functions', () => {
  describe('createTextMessage', () => {
    it('creates a text message with correct structure', () => {
      const msg = createTextMessage('oc_123', 'Hello World');
      expect(msg.chatId).toBe('oc_123');
      expect(msg.content.type).toBe('text');
      expect(isTextContent(msg.content)).toBe(true);
      if (isTextContent(msg.content)) {
        expect(msg.content.text).toBe('Hello World');
      }
    });

    it('includes threadId when provided', () => {
      const msg = createTextMessage('oc_123', 'Hello', 'thread_1');
      expect(msg.threadId).toBe('thread_1');
    });

    it('omits threadId when undefined', () => {
      const msg = createTextMessage('oc_123', 'Hello');
      expect(msg.threadId).toBeUndefined();
    });

    it('handles empty text', () => {
      const msg = createTextMessage('oc_123', '');
      if (isTextContent(msg.content)) {
        expect(msg.content.text).toBe('');
      }
    });
  });

  describe('createMarkdownMessage', () => {
    it('creates a markdown message with correct structure', () => {
      const msg = createMarkdownMessage('oc_123', '**Bold**');
      expect(msg.chatId).toBe('oc_123');
      expect(msg.content.type).toBe('markdown');
      expect(isMarkdownContent(msg.content)).toBe(true);
      if (isMarkdownContent(msg.content)) {
        expect(msg.content.text).toBe('**Bold**');
      }
    });

    it('includes threadId when provided', () => {
      const msg = createMarkdownMessage('oc_123', 'text', 'thread_1');
      expect(msg.threadId).toBe('thread_1');
    });

    it('omits threadId when undefined', () => {
      const msg = createMarkdownMessage('oc_123', 'text');
      expect(msg.threadId).toBeUndefined();
    });
  });

  describe('createCardMessage', () => {
    const basicSections: CardSection[] = [
      { type: 'text', content: 'Section text' },
    ];

    it('creates a card message with minimal options', () => {
      const msg = createCardMessage('oc_123', 'Title', basicSections);
      expect(msg.chatId).toBe('oc_123');
      expect(isCardContent(msg.content)).toBe(true);
      if (isCardContent(msg.content)) {
        expect(msg.content.title).toBe('Title');
        expect(msg.content.sections).toEqual(basicSections);
        expect(msg.content.subtitle).toBeUndefined();
        expect(msg.content.actions).toBeUndefined();
        expect(msg.content.theme).toBeUndefined();
      }
    });

    it('creates a card with all options', () => {
      const actions: CardAction[] = [
        { type: 'button', label: 'Click', value: 'clicked' },
      ];
      const msg = createCardMessage('oc_123', 'Title', basicSections, {
        subtitle: 'Subtitle',
        actions,
        theme: 'blue',
        threadId: 'thread_1',
      });
      if (isCardContent(msg.content)) {
        expect(msg.content.subtitle).toBe('Subtitle');
        expect(msg.content.actions).toEqual(actions);
        expect(msg.content.theme).toBe('blue');
      }
      expect(msg.threadId).toBe('thread_1');
    });

    it('creates a card with multiple sections', () => {
      const sections: CardSection[] = [
        { type: 'text', content: 'Text section' },
        { type: 'markdown', content: '**Markdown**' },
        { type: 'divider' },
        { type: 'image', imageUrl: 'https://example.com/img.png' },
        { type: 'fields', fields: [{ label: 'Key', value: 'Value' }] },
      ];
      const msg = createCardMessage('oc_123', 'Title', sections);
      if (isCardContent(msg.content)) {
        expect(msg.content.sections).toHaveLength(5);
      }
    });

    it('handles empty sections array', () => {
      const msg = createCardMessage('oc_123', 'Title', []);
      if (isCardContent(msg.content)) {
        expect(msg.content.sections).toEqual([]);
      }
    });
  });

  describe('createDoneMessage', () => {
    it('creates a success done message', () => {
      const msg = createDoneMessage('oc_123', true, 'Task completed');
      expect(msg.chatId).toBe('oc_123');
      expect(isDoneContent(msg.content)).toBe(true);
      if (isDoneContent(msg.content)) {
        expect(msg.content.success).toBe(true);
        expect(msg.content.message).toBe('Task completed');
        expect(msg.content.error).toBeUndefined();
      }
    });

    it('creates a failure done message', () => {
      const msg = createDoneMessage('oc_123', false, undefined, 'Something went wrong');
      if (isDoneContent(msg.content)) {
        expect(msg.content.success).toBe(false);
        expect(msg.content.error).toBe('Something went wrong');
      }
    });

    it('creates done message with only success flag', () => {
      const msg = createDoneMessage('oc_123', true);
      if (isDoneContent(msg.content)) {
        expect(msg.content.success).toBe(true);
        expect(msg.content.message).toBeUndefined();
        expect(msg.content.error).toBeUndefined();
      }
    });

    it('creates done message with both message and error', () => {
      const msg = createDoneMessage('oc_123', false, 'Partial success', 'Timeout');
      if (isDoneContent(msg.content)) {
        expect(msg.content.message).toBe('Partial success');
        expect(msg.content.error).toBe('Timeout');
      }
    });
  });
});

describe('Universal Message - Interface Types', () => {
  it('CardContent supports all theme options', () => {
    const themes: CardContent['theme'][] = [
      'blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange',
      'red', 'carmine', 'violet', 'purple', 'indigo', 'grey',
    ];
    for (const theme of themes) {
      const msg = createCardMessage('oc_123', 'Title', [], { theme });
      if (isCardContent(msg.content)) {
        expect(msg.content.theme).toBe(theme);
      }
    }
  });

  it('CardAction supports all types', () => {
    const actionTypes: CardAction['type'][] = ['button', 'select', 'link'];
    for (const type of actionTypes) {
      const action: CardAction = { type, label: 'Label', value: 'val' };
      expect(action.type).toBe(type);
    }
  });

  it('CardAction supports optional fields', () => {
    const action: CardAction = {
      type: 'select',
      label: 'Choose',
      value: 'choice',
      options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
      style: 'primary',
    };
    expect(action.options).toHaveLength(2);
    expect(action.style).toBe('primary');
  });

  it('FileContent supports optional fields', () => {
    const file: FileContent = {
      type: 'file',
      path: '/path/to/file.pdf',
      name: 'document.pdf',
      mimeType: 'application/pdf',
    };
    expect(file.name).toBe('document.pdf');
    expect(file.mimeType).toBe('application/pdf');
  });
});
