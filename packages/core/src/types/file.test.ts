/**
 * Tests for file transfer types (packages/core/src/types/file.ts)
 *
 * Issue #1617 Phase 2: Tests for core type factory functions.
 *
 * Covers:
 * - createFileRef: basic creation, optional fields, expiration
 * - createInboundAttachment: source='user', required fields, optional fields
 * - createOutboundFile: source='agent', optional chatId/threadId
 * - Edge cases: missing options, expiresInMs calculation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFileRef,
  createInboundAttachment,
  createOutboundFile,
} from './file.js';

describe('File Transfer Types', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // createFileRef
  // =========================================================================
  describe('createFileRef', () => {
    it('should create a FileRef with required fields', () => {
      const ref = createFileRef('document.pdf', 'user');

      expect(ref.fileName).toBe('document.pdf');
      expect(ref.source).toBe('user');
      expect(ref.id).toBeDefined();
      expect(ref.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(ref.createdAt).toBe(Date.now());
      expect(ref.mimeType).toBeUndefined();
      expect(ref.size).toBeUndefined();
      expect(ref.localPath).toBeUndefined();
      expect(ref.platformKey).toBeUndefined();
      expect(ref.expiresAt).toBeUndefined();
    });

    it('should create a FileRef with agent source', () => {
      const ref = createFileRef('output.csv', 'agent');
      expect(ref.source).toBe('agent');
    });

    it('should include optional mimeType when provided', () => {
      const ref = createFileRef('image.png', 'user', { mimeType: 'image/png' });
      expect(ref.mimeType).toBe('image/png');
    });

    it('should include optional size when provided', () => {
      const ref = createFileRef('data.json', 'agent', { size: 1024 });
      expect(ref.size).toBe(1024);
    });

    it('should include optional localPath when provided', () => {
      const ref = createFileRef('log.txt', 'agent', { localPath: '/tmp/logs/log.txt' });
      expect(ref.localPath).toBe('/tmp/logs/log.txt');
    });

    it('should include optional platformKey when provided', () => {
      const ref = createFileRef('report.pdf', 'user', { platformKey: 'feishu_key_123' });
      expect(ref.platformKey).toBe('feishu_key_123');
    });

    it('should set expiresAt when expiresInMs is provided', () => {
      const now = Date.now();
      const ref = createFileRef('temp.txt', 'agent', { expiresInMs: 3600000 });

      expect(ref.expiresAt).toBe(now + 3600000);
    });

    it('should not set expiresAt when expiresInMs is not provided', () => {
      const ref = createFileRef('permanent.txt', 'user');
      expect(ref.expiresAt).toBeUndefined();
    });

    it('should leave expiresAt undefined when expiresInMs is 0 (falsy)', () => {
      const ref = createFileRef('instant.txt', 'agent', { expiresInMs: 0 });
      expect(ref.expiresAt).toBeUndefined();
    });

    it('should generate unique IDs for each FileRef', () => {
      const ref1 = createFileRef('a.txt', 'user');
      const ref2 = createFileRef('b.txt', 'user');
      expect(ref1.id).not.toBe(ref2.id);
    });

    it('should set createdAt to current timestamp', () => {
      const now = Date.now();
      const ref = createFileRef('file.txt', 'user');
      expect(ref.createdAt).toBe(now);
    });

    it('should handle all optional fields together', () => {
      const ref = createFileRef('full.dat', 'user', {
        mimeType: 'application/octet-stream',
        size: 2048,
        localPath: '/data/full.dat',
        platformKey: 'pk_123',
        expiresInMs: 7200000,
      });

      expect(ref.fileName).toBe('full.dat');
      expect(ref.source).toBe('user');
      expect(ref.mimeType).toBe('application/octet-stream');
      expect(ref.size).toBe(2048);
      expect(ref.localPath).toBe('/data/full.dat');
      expect(ref.platformKey).toBe('pk_123');
      expect(ref.expiresAt).toBe(Date.now() + 7200000);
    });
  });

  // =========================================================================
  // createInboundAttachment
  // =========================================================================
  describe('createInboundAttachment', () => {
    it('should create an InboundAttachment with required fields', () => {
      const att = createInboundAttachment('photo.jpg', 'chat-123', 'image');

      expect(att.fileName).toBe('photo.jpg');
      expect(att.source).toBe('user');
      expect(att.chatId).toBe('chat-123');
      expect(att.fileType).toBe('image');
      expect(att.id).toBeDefined();
      expect(att.createdAt).toBe(Date.now());
      expect(att.messageId).toBeUndefined();
    });

    it('should always have source as "user"', () => {
      const att = createInboundAttachment('doc.pdf', 'chat-456', 'file');
      expect(att.source).toBe('user');
    });

    it('should support all fileType values', () => {
      const imageAtt = createInboundAttachment('img.png', 'c1', 'image');
      const fileAtt = createInboundAttachment('doc.pdf', 'c1', 'file');
      const mediaAtt = createInboundAttachment('video.mp4', 'c1', 'media');

      expect(imageAtt.fileType).toBe('image');
      expect(fileAtt.fileType).toBe('file');
      expect(mediaAtt.fileType).toBe('media');
    });

    it('should include optional mimeType', () => {
      const att = createInboundAttachment('data.csv', 'c1', 'file', {
        mimeType: 'text/csv',
      });
      expect(att.mimeType).toBe('text/csv');
    });

    it('should include optional size', () => {
      const att = createInboundAttachment('big.zip', 'c1', 'file', {
        size: 10485760,
      });
      expect(att.size).toBe(10485760);
    });

    it('should include optional localPath', () => {
      const att = createInboundAttachment('upload.png', 'c1', 'image', {
        localPath: '/uploads/upload.png',
      });
      expect(att.localPath).toBe('/uploads/upload.png');
    });

    it('should include optional platformKey', () => {
      const att = createInboundAttachment('screenshot.png', 'c1', 'image', {
        platformKey: 'oss_key_abc',
      });
      expect(att.platformKey).toBe('oss_key_abc');
    });

    it('should include optional messageId', () => {
      const att = createInboundAttachment('audio.mp3', 'c1', 'media', {
        messageId: 'msg-789',
      });
      expect(att.messageId).toBe('msg-789');
    });

    it('should set expiresAt when expiresInMs is provided', () => {
      const now = Date.now();
      const att = createInboundAttachment('temp.jpg', 'c1', 'image', {
        expiresInMs: 1800000,
      });
      expect(att.expiresAt).toBe(now + 1800000);
    });

    it('should generate a unique ID for each attachment', () => {
      const att1 = createInboundAttachment('a.png', 'c1', 'image');
      const att2 = createInboundAttachment('b.png', 'c1', 'image');
      expect(att1.id).not.toBe(att2.id);
    });

    it('should include all optional fields together', () => {
      const att = createInboundAttachment('report.xlsx', 'chat-xyz', 'file', {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 5120,
        localPath: '/tmp/report.xlsx',
        platformKey: 'feishu_xlsx_key',
        messageId: 'msg-100',
        expiresInMs: 600000,
      });

      expect(att.fileName).toBe('report.xlsx');
      expect(att.source).toBe('user');
      expect(att.chatId).toBe('chat-xyz');
      expect(att.fileType).toBe('file');
      expect(att.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(att.size).toBe(5120);
      expect(att.localPath).toBe('/tmp/report.xlsx');
      expect(att.platformKey).toBe('feishu_xlsx_key');
      expect(att.messageId).toBe('msg-100');
      expect(att.expiresAt).toBe(Date.now() + 600000);
    });
  });

  // =========================================================================
  // createOutboundFile
  // =========================================================================
  describe('createOutboundFile', () => {
    it('should create an OutboundFile with required fields', () => {
      const file = createOutboundFile('result.json');

      expect(file.fileName).toBe('result.json');
      expect(file.source).toBe('agent');
      expect(file.id).toBeDefined();
      expect(file.createdAt).toBe(Date.now());
      expect(file.chatId).toBeUndefined();
      expect(file.threadId).toBeUndefined();
    });

    it('should always have source as "agent"', () => {
      const file = createOutboundFile('output.txt');
      expect(file.source).toBe('agent');
    });

    it('should include optional mimeType', () => {
      const file = createOutboundFile('chart.svg', { mimeType: 'image/svg+xml' });
      expect(file.mimeType).toBe('image/svg+xml');
    });

    it('should include optional size', () => {
      const file = createOutboundFile('data.bin', { size: 4096 });
      expect(file.size).toBe(4096);
    });

    it('should include optional localPath', () => {
      const file = createOutboundFile('artifact.tar.gz', {
        localPath: '/workspace/artifact.tar.gz',
      });
      expect(file.localPath).toBe('/workspace/artifact.tar.gz');
    });

    it('should include optional chatId', () => {
      const file = createOutboundFile('report.pdf', { chatId: 'chat-target' });
      expect(file.chatId).toBe('chat-target');
    });

    it('should include optional threadId', () => {
      const file = createOutboundFile('reply.txt', { threadId: 'thread-42' });
      expect(file.threadId).toBe('thread-42');
    });

    it('should set expiresAt when expiresInMs is provided', () => {
      const now = Date.now();
      const file = createOutboundFile('cache.tmp', { expiresInMs: 5000 });
      expect(file.expiresAt).toBe(now + 5000);
    });

    it('should generate unique IDs for each OutboundFile', () => {
      const file1 = createOutboundFile('a.txt');
      const file2 = createOutboundFile('b.txt');
      expect(file1.id).not.toBe(file2.id);
    });

    it('should include all optional fields together', () => {
      const file = createOutboundFile('summary.md', {
        mimeType: 'text/markdown',
        size: 8192,
        localPath: '/output/summary.md',
        chatId: 'chat-999',
        threadId: 'thread-111',
        expiresInMs: 120000,
      });

      expect(file.fileName).toBe('summary.md');
      expect(file.source).toBe('agent');
      expect(file.mimeType).toBe('text/markdown');
      expect(file.size).toBe(8192);
      expect(file.localPath).toBe('/output/summary.md');
      expect(file.chatId).toBe('chat-999');
      expect(file.threadId).toBe('thread-111');
      expect(file.expiresAt).toBe(Date.now() + 120000);
    });
  });
});
