/**
 * Tests for Universal Message Format (UMF).
 *
 * @see Issue #480
 */

import { describe, it, expect } from 'vitest';
import {
  type CardContent,
  type MessageContent,
  type UniversalMessage,
  DEFAULT_CAPABILITIES,
  FEISHU_CAPABILITIES,
  CLI_CAPABILITIES,
  REST_CAPABILITIES,
  isTextContent,
  isMarkdownContent,
  isCardContent,
  isFileContent,
  isDoneContent,
  createTextMessage,
  createMarkdownMessage,
  createCardMessage,
} from './universal-message.js';

describe('UniversalMessage Types', () => {
  describe('Type Guards', () => {
    it('should identify TextContent', () => {
      const content: MessageContent = { type: 'text', text: 'Hello' };
      expect(isTextContent(content)).toBe(true);
      expect(isMarkdownContent(content)).toBe(false);
      expect(isCardContent(content)).toBe(false);
    });

    it('should identify MarkdownContent', () => {
      const content: MessageContent = { type: 'markdown', text: '**Bold**' };
      expect(isMarkdownContent(content)).toBe(true);
      expect(isTextContent(content)).toBe(false);
    });

    it('should identify CardContent', () => {
      const content: MessageContent = {
        type: 'card',
        title: 'Test Card',
        sections: [],
      };
      expect(isCardContent(content)).toBe(true);
      expect(isTextContent(content)).toBe(false);
    });

    it('should identify FileContent', () => {
      const content: MessageContent = {
        type: 'file',
        fileName: 'test.txt',
        filePath: '/tmp/test.txt',
      };
      expect(isFileContent(content)).toBe(true);
    });

    it('should identify DoneContent', () => {
      const content: MessageContent = { type: 'done', success: true };
      expect(isDoneContent(content)).toBe(true);
    });
  });

  describe('Capabilities', () => {
    it('should have correct default capabilities', () => {
      expect(DEFAULT_CAPABILITIES.supportsCard).toBe(false);
      expect(DEFAULT_CAPABILITIES.supportsMarkdown).toBe(true);
      expect(DEFAULT_CAPABILITIES.supportedContentTypes).toContain('text');
      expect(DEFAULT_CAPABILITIES.supportedContentTypes).toContain('markdown');
    });

    it('should have correct Feishu capabilities', () => {
      expect(FEISHU_CAPABILITIES.supportsCard).toBe(true);
      expect(FEISHU_CAPABILITIES.supportsThread).toBe(true);
      expect(FEISHU_CAPABILITIES.supportsFile).toBe(true);
      expect(FEISHU_CAPABILITIES.supportsInteractive).toBe(true);
      expect(FEISHU_CAPABILITIES.maxMessageLength).toBe(30000);
    });

    it('should have correct CLI capabilities', () => {
      expect(CLI_CAPABILITIES.supportsCard).toBe(false);
      expect(CLI_CAPABILITIES.supportsFile).toBe(true);
    });

    it('should have correct REST capabilities', () => {
      expect(REST_CAPABILITIES.supportsCard).toBe(true);
      expect(REST_CAPABILITIES.supportsThread).toBe(false);
    });
  });

  describe('Helper Functions', () => {
    it('should create text message', () => {
      const message = createTextMessage('chat-123', 'Hello World');
      expect(message.chatId).toBe('chat-123');
      expect(message.content.type).toBe('text');
      if (isTextContent(message.content)) {
        expect(message.content.text).toBe('Hello World');
      }
      expect(message.threadId).toBeUndefined();
    });

    it('should create text message with thread', () => {
      const message = createTextMessage('chat-123', 'Hello', 'thread-456');
      expect(message.threadId).toBe('thread-456');
    });

    it('should create markdown message', () => {
      const message = createMarkdownMessage('chat-123', '**Bold**');
      expect(message.content.type).toBe('markdown');
      if (isMarkdownContent(message.content)) {
        expect(message.content.text).toBe('**Bold**');
      }
    });

    it('should create card message', () => {
      const message = createCardMessage(
        'chat-123',
        {
          title: 'Test Card',
          sections: [{ type: 'text', content: 'Content' }],
        },
        'thread-456'
      );

      expect(message.chatId).toBe('chat-123');
      expect(message.threadId).toBe('thread-456');
      expect(message.content.type).toBe('card');
      if (isCardContent(message.content)) {
        expect(message.content.title).toBe('Test Card');
        expect(message.content.sections).toHaveLength(1);
      }
    });
  });
});

describe('UniversalMessage Structure', () => {
  it('should create valid text message', () => {
    const message: UniversalMessage = {
      chatId: 'oc_123',
      content: { type: 'text', text: 'Hello' },
    };

    expect(message.chatId).toBe('oc_123');
    expect(message.content.type).toBe('text');
  });

  it('should create valid card message with all options', () => {
    const card: CardContent = {
      type: 'card',
      title: 'Test Card',
      subtitle: 'Subtitle',
      theme: 'blue',
      sections: [
        { type: 'text', content: 'Text content' },
        { type: 'markdown', content: '**Bold**' },
        { type: 'divider' },
        {
          type: 'actions',
          actions: [
            { type: 'button', label: 'Click', value: 'click', style: 'primary' },
          ],
        },
        {
          type: 'columns',
          columns: [
            {
              weight: 1,
              sections: [{ type: 'text', content: 'Column 1' }],
            },
            {
              weight: 1,
              sections: [{ type: 'text', content: 'Column 2' }],
            },
          ],
        },
        { type: 'image', imageUrl: 'http://example.com/image.png', imageAlt: 'Image' },
      ],
      actions: [
        { type: 'button', label: 'Submit', value: 'submit' },
      ],
    };

    const message: UniversalMessage = {
      chatId: 'oc_123',
      threadId: 'thread-456',
      content: card,
      metadata: {
        level: 'notice',
        timestamp: Date.now(),
      },
    };

    expect(message.content.type).toBe('card');
    expect((message.content as CardContent).sections).toHaveLength(6);
  });
});
