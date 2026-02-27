/**
 * Tests for file transfer types (src/file-transfer/types.ts)
 *
 * Tests the following functionality:
 * - createFileRef factory function
 * - createInboundAttachment factory function
 * - createOutboundFile factory function
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFileRef,
  createInboundAttachment,
  createOutboundFile,
} from './types.js';

// Mock uuid
vi.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

describe('createFileRef', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create file ref with required fields', () => {
    const ref = createFileRef('test.txt', 'agent');

    expect(ref.id).toBe('test-uuid-1234');
    expect(ref.fileName).toBe('test.txt');
    expect(ref.source).toBe('agent');
    expect(ref.createdAt).toBeDefined();
    expect(ref.expiresAt).toBeUndefined();
  });

  it('should create file ref with all optional fields', () => {
    const ref = createFileRef('document.pdf', 'user', {
      mimeType: 'application/pdf',
      size: 1024,
      localPath: '/tmp/document.pdf',
      platformKey: 'platform_key_123',
      expiresInMs: 3600000, // 1 hour
    });

    expect(ref.mimeType).toBe('application/pdf');
    expect(ref.size).toBe(1024);
    expect(ref.localPath).toBe('/tmp/document.pdf');
    expect(ref.platformKey).toBe('platform_key_123');
    expect(ref.expiresAt).toBeGreaterThan(ref.createdAt);
  });

  it('should calculate expiresAt correctly', () => {
    const beforeCreate = Date.now();
    const ref = createFileRef('temp.txt', 'agent', {
      expiresInMs: 5000,
    });
    const afterCreate = Date.now();

    // expiresAt should be createdAt + expiresInMs
    expect(ref.expiresAt).toBeGreaterThanOrEqual(beforeCreate + 5000);
    expect(ref.expiresAt).toBeLessThanOrEqual(afterCreate + 5000);
  });

  it('should work with minimal options', () => {
    const ref = createFileRef('test.txt', 'agent', {});

    expect(ref.fileName).toBe('test.txt');
    expect(ref.source).toBe('agent');
    expect(ref.mimeType).toBeUndefined();
    expect(ref.size).toBeUndefined();
  });
});

describe('createInboundAttachment', () => {
  it('should create inbound attachment with required fields', () => {
    const attachment = createInboundAttachment(
      'image.png',
      'chat_123',
      'image'
    );

    expect(attachment.id).toBe('test-uuid-1234');
    expect(attachment.fileName).toBe('image.png');
    expect(attachment.chatId).toBe('chat_123');
    expect(attachment.fileType).toBe('image');
    expect(attachment.source).toBe('user');
  });

  it('should create inbound attachment with optional fields', () => {
    const attachment = createInboundAttachment(
      'document.pdf',
      'chat_456',
      'file',
      {
        mimeType: 'application/pdf',
        size: 2048,
        localPath: '/tmp/document.pdf',
        platformKey: 'file_key_123',
        messageId: 'msg_789',
        expiresInMs: 60000,
      }
    );

    expect(attachment.mimeType).toBe('application/pdf');
    expect(attachment.size).toBe(2048);
    expect(attachment.localPath).toBe('/tmp/document.pdf');
    expect(attachment.platformKey).toBe('file_key_123');
    expect(attachment.messageId).toBe('msg_789');
    expect(attachment.expiresAt).toBeDefined();
  });

  it('should support different file types', () => {
    const image = createInboundAttachment('img.png', 'chat', 'image');
    const file = createInboundAttachment('doc.pdf', 'chat', 'file');
    const media = createInboundAttachment('video.mp4', 'chat', 'media');

    expect(image.fileType).toBe('image');
    expect(file.fileType).toBe('file');
    expect(media.fileType).toBe('media');
  });
});

describe('createOutboundFile', () => {
  it('should create outbound file with required fields', () => {
    const file = createOutboundFile('output.txt');

    expect(file.id).toBe('test-uuid-1234');
    expect(file.fileName).toBe('output.txt');
    expect(file.source).toBe('agent');
    expect(file.createdAt).toBeDefined();
  });

  it('should create outbound file with optional fields', () => {
    const file = createOutboundFile('report.pdf', {
      mimeType: 'application/pdf',
      size: 4096,
      localPath: '/tmp/report.pdf',
      chatId: 'chat_123',
      threadId: 'thread_456',
      expiresInMs: 300000,
    });

    expect(file.mimeType).toBe('application/pdf');
    expect(file.size).toBe(4096);
    expect(file.localPath).toBe('/tmp/report.pdf');
    expect(file.chatId).toBe('chat_123');
    expect(file.threadId).toBe('thread_456');
    expect(file.expiresAt).toBeDefined();
  });

  it('should always set source to agent', () => {
    const file = createOutboundFile('test.txt');
    expect(file.source).toBe('agent');
  });

  it('should work with minimal options', () => {
    const file = createOutboundFile('test.txt', {});

    expect(file.fileName).toBe('test.txt');
    expect(file.source).toBe('agent');
    expect(file.chatId).toBeUndefined();
    expect(file.threadId).toBeUndefined();
  });
});

describe('type compatibility', () => {
  it('FileRef should be compatible with InboundAttachment base', () => {
    const attachment = createInboundAttachment('test.png', 'chat', 'image');

    // All FileRef fields should be present
    expect(attachment.id).toBeDefined();
    expect(attachment.fileName).toBeDefined();
    expect(attachment.source).toBeDefined();
    expect(attachment.createdAt).toBeDefined();
  });

  it('FileRef should be compatible with OutboundFile base', () => {
    const file = createOutboundFile('output.txt');

    // All FileRef fields should be present
    expect(file.id).toBeDefined();
    expect(file.fileName).toBeDefined();
    expect(file.source).toBeDefined();
    expect(file.createdAt).toBeDefined();
  });
});
