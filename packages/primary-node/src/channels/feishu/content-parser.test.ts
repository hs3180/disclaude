/**
 * Tests for content-parser — Feishu message content parsing utilities.
 *
 * Pure functions extracted from message-handler.ts (Issue #4126). Had zero
 * test coverage despite handling critical parsing logic for rich text,
 * code blocks, chat history, and timestamps.
 */

import { describe, it, expect } from 'vitest';
import {
  extractOpenId,
  parsePostContent,
  parseChatHistoryElement,
  parseShareChatContent,
  extractSenderName,
  extractMessageContent,
  formatMessageTime,
} from './content-parser.js';

describe('extractOpenId', () => {
  it('should extract open_id from object sender_id', () => {
    expect(extractOpenId({ sender_id: { open_id: 'ou_abc' } })).toBe('ou_abc');
  });
  it('should extract from string sender_id', () => {
    expect(extractOpenId({ sender_id: 'ou_str' })).toBe('ou_str');
  });
  it('should return undefined when no sender_id', () => {
    expect(extractOpenId({})).toBeUndefined();
    expect(extractOpenId(undefined)).toBeUndefined();
  });
});

describe('parsePostContent', () => {
  it('should parse text segments', () => {
    const content = [[{ tag: 'text', text: 'Hello ' }, { tag: 'text', text: 'world' }]];
    expect(parsePostContent(content)).toBe('Hello world');
  });

  it('should parse link segments', () => {
    expect(parsePostContent([[{ tag: 'a', text: 'click here', href: 'https://x.com' }]])).toContain('click here');
  });

  it('should parse mention segments', () => {
    expect(parsePostContent([[{ tag: 'at', text: 'alice', user_id: 'ou_a' }]])).toBe('@alice');
    expect(parsePostContent([[{ tag: 'at' }]])).toBe('@user');
  });

  it('should render image as placeholder', () => {
    expect(parsePostContent([[{ tag: 'img' }]])).toBe('[图片]');
  });

  it('should format code blocks as markdown', () => {
    const result = parsePostContent([[{ tag: 'code_block', text: 'const x = 1;', language: 'ts' }]]);
    expect(result).toContain('```ts');
    expect(result).toContain('const x = 1;');
  });

  it('should skip non-array rows', () => {
    expect(parsePostContent(['not-an-array' as unknown as unknown[]])).toBe('');
  });

  it('should skip segments without tag', () => {
    expect(parsePostContent([[{ text: 'no tag' }]])).toBe('');
  });
});

describe('parseChatHistoryElement', () => {
  it('should format messages with sender + content', () => {
    const result = parseChatHistoryElement({
      messages: [
        { sender: 'Alice', content: 'Hi', create_time: '10:00' },
        { sender: 'Bob', content: 'Hello' },
      ],
    });
    expect(result).toContain('[10:00] Alice: Hi');
    expect(result).toContain('Bob: Hello');
    expect(result).toContain('--- 转发的聊天记录 ---');
    expect(result).toContain('--- 转发结束 ---');
  });

  it('should return empty for non-array messages', () => {
    expect(parseChatHistoryElement({ messages: 'not-an-array' })).toBe('');
    expect(parseChatHistoryElement({})).toBe('');
  });
});

describe('extractSenderName', () => {
  it('should extract string sender', () => {
    expect(extractSenderName({ sender: 'Alice' })).toBe('Alice');
  });
  it('should extract from object sender', () => {
    expect(extractSenderName({ sender: { name: 'Bob' } })).toBe('Bob');
    expect(extractSenderName({ sender: { nickname: 'Bobby' } })).toBe('Bobby');
  });
  it('should fall back to 未知发送者', () => {
    expect(extractSenderName({})).toBe('未知发送者');
  });
  it('should try alternative fields', () => {
    expect(extractSenderName({ from: 'Carol' })).toBe('Carol');
    expect(extractSenderName({ author: 'Dave' })).toBe('Dave');
  });
});

describe('extractMessageContent', () => {
  it('should extract string content', () => {
    expect(extractMessageContent({ content: 'hello' })).toBe('hello');
  });
  it('should try alternative fields', () => {
    expect(extractMessageContent({ body: 'text body' })).toBe('text body');
    expect(extractMessageContent({ text: 'plain text' })).toBe('plain text');
  });
  it('should handle nested text', () => {
    expect(extractMessageContent({ content: { text: 'nested' } })).toBe('nested');
  });
  it('should return empty for no content', () => {
    expect(extractMessageContent({})).toBe('');
  });
});

describe('formatMessageTime', () => {
  it('should format Unix timestamp (seconds)', () => {
    const result = formatMessageTime({ create_time: 1700000000 });
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
  it('should format Unix timestamp (milliseconds)', () => {
    const result = formatMessageTime({ timestamp: 1700000000000 });
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
  it('should return empty for no timestamp', () => {
    expect(formatMessageTime({})).toBe('');
  });
  it('should handle string timestamps', () => {
    const result = formatMessageTime({ time: '1700000000' });
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('parseShareChatContent', () => {
  it('should format structured chat history', () => {
    const result = parseShareChatContent({
      title: 'Meeting Notes',
      chat_history: [{ sender: 'Alice', content: 'Agenda?' }],
    });
    expect(result).toContain('📋 Meeting Notes');
    expect(result).toContain('Alice');
    expect(result).toContain('Agenda?');
  });
  it('should fall back to body text', () => {
    expect(parseShareChatContent({ body: 'forwarded text' })).toBe('[转发消息] forwarded text');
  });
  it('should show unparsable message for empty', () => {
    expect(parseShareChatContent({})).toBe('[转发消息] 无法解析内容');
  });
});
