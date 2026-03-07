/**
 * Tests for Message Content Parser.
 * Issue #846: Support for reading packed conversation records and quote replies
 */

import { describe, it, expect } from 'vitest';
import {
  parseTextMessage,
  parsePostMessage,
  parseMergeForwardMessage,
  formatMergeForwardAsText,
  buildQuoteContextPrompt,
  parseMessageContent,
} from './message-content-parser.js';

describe('parseTextMessage', () => {
  it('should parse plain text message', () => {
    const content = JSON.stringify({ text: 'Hello world' });
    const result = parseTextMessage(content);
    expect(result.text).toBe('Hello world');
    expect(result.quote).toBeUndefined();
  });

  it('should parse text with quote', () => {
    const content = JSON.stringify({
      text: 'I agree',
      quote: 'Original message',
    });
    const result = parseTextMessage(content);
    expect(result.text).toBe('I agree');
    expect(result.quote).toEqual({ text: 'Original message' });
  });

  it('should handle empty text', () => {
    const content = JSON.stringify({ text: '' });
    const result = parseTextMessage(content);
    expect(result.text).toBe('');
  });

  it('should handle invalid JSON', () => {
    const content = 'not valid json';
    const result = parseTextMessage(content);
    expect(result.text).toBe('not valid json');
  });
});

describe('parsePostMessage', () => {
  it('should parse rich text post', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'text', text: 'Hello ' }],
        [{ tag: 'text', text: 'world' }],
      ],
    });
    const result = parsePostMessage(content);
    expect(result).toBe('Hello world');
  });

  it('should handle empty content', () => {
    const content = JSON.stringify({ content: [] });
    const result = parsePostMessage(content);
    expect(result).toBe('');
  });

  it('should handle invalid JSON', () => {
    const content = 'invalid';
    const result = parsePostMessage(content);
    expect(result).toBe('');
  });
});

describe('parseMergeForwardMessage', () => {
  it('should parse merge forward message', () => {
    const content = JSON.stringify({
      mergedTitle: '聊天记录',
      mergedMessageList: [
        {
          createTime: '1234567890',
          sender: { name: 'Alice' },
          body: {
            type: 'text',
            content: JSON.stringify({ text: 'Hello' }),
          },
        },
        {
          createTime: '1234567891',
          sender: { name: 'Bob' },
          body: {
            type: 'text',
            content: JSON.stringify({ text: 'World' }),
          },
        },
      ],
    });

    const result = parseMergeForwardMessage(content);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('聊天记录');
    expect(result?.messages).toHaveLength(2);
    expect(result?.messages[0].sender).toBe('Alice');
    expect(result?.messages[0].content).toBe('Hello');
    expect(result?.messages[1].sender).toBe('Bob');
    expect(result?.messages[1].content).toBe('World');
  });

  it('should return null for non-merge forward content', () => {
    const content = JSON.stringify({ text: 'regular message' });
    const result = parseMergeForwardMessage(content);
    expect(result).toBeNull();
  });

  it('should handle invalid JSON', () => {
    const content = 'invalid';
    const result = parseMergeForwardMessage(content);
    expect(result).toBeNull();
  });
});

describe('formatMergeForwardAsText', () => {
  it('should format merge forward as readable text', () => {
    const mergeForward = {
      title: '聊天记录',
      messages: [
        { sender: 'Alice', content: 'Hello', timestamp: '1234567890' },
        { sender: 'Bob', content: 'World' },
      ],
    };

    const result = formatMergeForwardAsText(mergeForward);
    expect(result).toContain('聊天记录');
    expect(result).toContain('Alice');
    expect(result).toContain('Hello');
    expect(result).toContain('Bob');
    expect(result).toContain('World');
  });
});

describe('buildQuoteContextPrompt', () => {
  it('should build context with quoted message', () => {
    const userMessage = 'I agree with this';
    const quotedMessage = {
      messageId: 'msg_123',
      text: 'Original proposal',
      sender: { name: 'Alice' },
    };

    const result = buildQuoteContextPrompt(userMessage, quotedMessage);
    expect(result).toContain('用户引用了以下消息');
    expect(result).toContain('来自 Alice');
    expect(result).toContain('Original proposal');
    expect(result).toContain('用户的消息');
    expect(result).toContain('I agree with this');
  });

  it('should build context with merge forward', () => {
    const userMessage = 'Check this conversation';
    const mergeForward = {
      title: 'Discussion',
      messages: [
        { sender: 'Alice', content: 'Hello' },
      ],
    };

    const result = buildQuoteContextPrompt(userMessage, undefined, mergeForward);
    expect(result).toContain('用户转发了以下聊天记录');
    expect(result).toContain('Discussion');
    expect(result).toContain('Hello');
  });

  it('should return just the user message when no special content', () => {
    const userMessage = 'Just a regular message';
    const result = buildQuoteContextPrompt(userMessage);
    expect(result).toContain('用户的消息');
    expect(result).toContain('Just a regular message');
  });
});

describe('parseMessageContent', () => {
  it('should parse text message', () => {
    const content = JSON.stringify({ text: 'Hello' });
    const result = parseMessageContent(content, 'text');
    expect(result.text).toBe('Hello');
    expect(result.hasSpecialContent).toBe(false);
  });

  it('should parse post message', () => {
    const content = JSON.stringify({
      content: [[{ tag: 'text', text: 'Rich text' }]],
    });
    const result = parseMessageContent(content, 'post');
    expect(result.text).toBe('Rich text');
    expect(result.hasSpecialContent).toBe(false);
  });

  it('should parse merge_forward message', () => {
    const content = JSON.stringify({
      mergedTitle: 'Chat',
      mergedMessageList: [
        {
          sender: { name: 'Alice' },
          body: { content: JSON.stringify({ text: 'Hi' }) },
        },
      ],
    });
    const result = parseMessageContent(content, 'merge_forward');
    expect(result.text).toContain('聊天记录');
    expect(result.mergeForward).toBeDefined();
    expect(result.mergeForward?.messages).toHaveLength(1);
    expect(result.hasSpecialContent).toBe(true);
  });

  it('should detect quote reply from parent_id', () => {
    const content = JSON.stringify({ text: 'Reply' });
    const result = parseMessageContent(content, 'text', 'parent_msg_123');
    expect(result.quotedMessage).toBeDefined();
    expect(result.quotedMessage?.messageId).toBe('parent_msg_123');
    expect(result.hasSpecialContent).toBe(true);
  });

  it('should handle unknown message type', () => {
    const content = 'plain text';
    const result = parseMessageContent(content, 'unknown');
    expect(result.text).toBe('plain text');
    expect(result.hasSpecialContent).toBe(false);
  });
});
