/**
 * Tests for RestAdapter
 * @see Issue #1617 Phase 4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RestAdapter,
  createRestAdapter,
  getRestAdapter,
  resetRestAdapter,
} from './rest-adapter.js';

describe('RestAdapter', () => {
  let adapter: RestAdapter;

  beforeEach(() => {
    adapter = new RestAdapter();
    resetRestAdapter();
  });

  afterEach(() => {
    resetRestAdapter();
  });

  describe('properties', () => {
    it('should have name "rest"', () => {
      expect(adapter.name).toBe('rest');
    });

    it('should support text, markdown, card, file, done', () => {
      expect(adapter.capabilities.supportedContentTypes).toEqual(
        expect.arrayContaining(['text', 'markdown', 'card', 'file', 'done'])
      );
    });
  });

  describe('canHandle', () => {
    it('should handle UUID format chatIds', () => {
      expect(adapter.canHandle('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should not handle non-UUID chatIds', () => {
      expect(adapter.canHandle('oc_chat1')).toBe(false);
      expect(adapter.canHandle('cli-session')).toBe(false);
      expect(adapter.canHandle('not-a-uuid')).toBe(false);
    });
  });

  describe('convert', () => {
    it('should convert to RestMessage format', () => {
      const msg = {
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        content: { type: 'text' as const, text: 'Hello!' },
      };

      const result = adapter.convert(msg);
      expect(result.chatId).toBe(msg.chatId);
      expect(result.content).toEqual(msg.content);
      expect(result.id).toMatch(/^msg_/);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('should include threadId when present', () => {
      const result = adapter.convert({
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        threadId: 'thread-1',
        content: { type: 'text', text: 'Hello!' },
      });
      expect(result.threadId).toBe('thread-1');
    });
  });

  describe('send', () => {
    it('should store message and return success', async () => {
      const result = await adapter.send({
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        content: { type: 'text', text: 'Hello!' },
      });
      expect(result.success).toBe(true);
      expect(result.messageId).toMatch(/^msg_/);
    });

    it('should accumulate messages per chat', async () => {
      const chatId = '550e8400-e29b-41d4-a716-446655440000';
      await adapter.send({ chatId, content: { type: 'text', text: 'Msg 1' } });
      await adapter.send({ chatId, content: { type: 'text', text: 'Msg 2' } });

      const messages = adapter.getMessages(chatId);
      expect(messages).toHaveLength(2);
    });

    it('should separate messages per chatId', async () => {
      const chatId1 = '550e8400-e29b-41d4-a716-446655440001';
      const chatId2 = '550e8400-e29b-41d4-a716-446655440002';
      await adapter.send({ chatId: chatId1, content: { type: 'text', text: 'Msg 1' } });
      await adapter.send({ chatId: chatId2, content: { type: 'text', text: 'Msg 2' } });

      expect(adapter.getMessages(chatId1)).toHaveLength(1);
      expect(adapter.getMessages(chatId2)).toHaveLength(1);
    });
  });

  describe('getMessagesSince', () => {
    it('should return messages after given ID', async () => {
      const chatId = '550e8400-e29b-41d4-a716-446655440000';
      const result1 = await adapter.send({ chatId, content: { type: 'text', text: 'Msg 1' } });
      await adapter.send({ chatId, content: { type: 'text', text: 'Msg 2' } });
      await adapter.send({ chatId, content: { type: 'text', text: 'Msg 3' } });

      const since = adapter.getMessagesSince(chatId, result1.messageId!);
      expect(since).toHaveLength(2);
    });

    it('should return all messages when sinceId not found', async () => {
      const chatId = '550e8400-e29b-41d4-a716-446655440000';
      await adapter.send({ chatId, content: { type: 'text', text: 'Msg 1' } });
      await adapter.send({ chatId, content: { type: 'text', text: 'Msg 2' } });

      const since = adapter.getMessagesSince(chatId, 'nonexistent_id');
      expect(since).toHaveLength(2);
    });
  });

  describe('clearMessages', () => {
    it('should remove all messages for a chat', async () => {
      const chatId = '550e8400-e29b-41d4-a716-446655440000';
      await adapter.send({ chatId, content: { type: 'text', text: 'Msg' } });
      adapter.clearMessages(chatId);
      expect(adapter.getMessages(chatId)).toHaveLength(0);
    });
  });

  describe('getMessages', () => {
    it('should return empty array for unknown chat', () => {
      expect(adapter.getMessages('unknown')).toEqual([]);
    });
  });
});

describe('Global RestAdapter', () => {
  afterEach(() => {
    resetRestAdapter();
  });

  it('should create singleton on first access', () => {
    const adapter = getRestAdapter();
    expect(adapter).toBeInstanceOf(RestAdapter);
  });

  it('should return same instance on subsequent calls', () => {
    const a = getRestAdapter();
    const b = getRestAdapter();
    expect(a).toBe(b);
  });

  it('should reset singleton', () => {
    const a = getRestAdapter();
    resetRestAdapter();
    const b = getRestAdapter();
    expect(a).not.toBe(b);
  });
});

describe('createRestAdapter', () => {
  it('should create a new instance', () => {
    const adapter = createRestAdapter();
    expect(adapter).toBeInstanceOf(RestAdapter);
  });
});
