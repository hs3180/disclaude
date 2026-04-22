/**
 * Tests for unified file transfer types and factory functions.
 *
 * Verifies createFileRef, createInboundAttachment, and createOutboundFile
 * produce correctly structured objects with proper defaults and overrides.
 *
 * Issue #1617: Phase 2 — core types/file test coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFileRef,
  createInboundAttachment,
  createOutboundFile,
} from './file.js';

// Mock uuid to return predictable values for deterministic assertions
vi.mock('uuid', () => ({
  v4: () => 'mock-uuid-1234',
}));

describe('createFileRef', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  it('should create a FileRef with required fields only', () => {
    const ref = createFileRef('photo.png', 'user');

    expect(ref).toMatchObject({
      id: 'mock-uuid-1234',
      fileName: 'photo.png',
      source: 'user',
      createdAt: 1700000000000,
    });
    expect(ref.mimeType).toBeUndefined();
    expect(ref.size).toBeUndefined();
    expect(ref.localPath).toBeUndefined();
    expect(ref.platformKey).toBeUndefined();
    expect(ref.expiresAt).toBeUndefined();
  });

  it('should create a FileRef with agent source', () => {
    const ref = createFileRef('output.txt', 'agent');
    expect(ref.source).toBe('agent');
  });

  it('should include all optional fields when provided', () => {
    const ref = createFileRef('doc.pdf', 'user', {
      mimeType: 'application/pdf',
      size: 1024,
      localPath: '/tmp/doc.pdf',
      platformKey: 'feishu_file_abc',
    });

    expect(ref.mimeType).toBe('application/pdf');
    expect(ref.size).toBe(1024);
    expect(ref.localPath).toBe('/tmp/doc.pdf');
    expect(ref.platformKey).toBe('feishu_file_abc');
  });

  it('should calculate expiresAt from expiresInMs', () => {
    const ref = createFileRef('temp.dat', 'agent', {
      expiresInMs: 3600000,
    });

    expect(ref.expiresAt).toBe(1700000000000 + 3600000);
  });

  it('should not set expiresAt when expiresInMs is not provided', () => {
    const ref = createFileRef('permanent.dat', 'user');
    expect(ref.expiresAt).toBeUndefined();
  });

  it('should not set expiresAt when expiresInMs is 0', () => {
    // expiresInMs=0 is falsy, so expiresAt should be undefined
    const ref = createFileRef('zero.dat', 'user', { expiresInMs: 0 });
    expect(ref.expiresAt).toBeUndefined();
  });

  it('should generate unique IDs for each call (uses uuid)', () => {
    // With our mock, all calls return same UUID — this test documents the uuid dependency
    const ref1 = createFileRef('a.txt', 'user');
    const ref2 = createFileRef('b.txt', 'user');
    // In production, these would differ; with mock they're the same
    expect(ref1.id).toBe('mock-uuid-1234');
    expect(ref2.id).toBe('mock-uuid-1234');
  });
});

describe('createInboundAttachment', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  it('should create an InboundAttachment with required fields', () => {
    const att = createInboundAttachment('img.jpg', 'oc_abc123', 'image');

    expect(att).toMatchObject({
      id: 'mock-uuid-1234',
      fileName: 'img.jpg',
      source: 'user',
      chatId: 'oc_abc123',
      fileType: 'image',
      createdAt: 1700000000000,
    });
  });

  it('should always set source to user regardless of internal createFileRef', () => {
    const att = createInboundAttachment('file.zip', 'oc_xyz', 'file');
    expect(att.source).toBe('user');
  });

  it('should support all file types', () => {
    const image = createInboundAttachment('a.png', 'oc_1', 'image');
    const file = createInboundAttachment('b.pdf', 'oc_2', 'file');
    const media = createInboundAttachment('c.mp4', 'oc_3', 'media');

    expect(image.fileType).toBe('image');
    expect(file.fileType).toBe('file');
    expect(media.fileType).toBe('media');
  });

  it('should include optional fields when provided', () => {
    const att = createInboundAttachment('doc.pdf', 'oc_test', 'file', {
      mimeType: 'application/pdf',
      size: 2048,
      localPath: '/tmp/doc.pdf',
      platformKey: 'file_key_xyz',
      messageId: 'msg_123',
      expiresInMs: 7200000,
    });

    expect(att.mimeType).toBe('application/pdf');
    expect(att.size).toBe(2048);
    expect(att.localPath).toBe('/tmp/doc.pdf');
    expect(att.platformKey).toBe('file_key_xyz');
    expect(att.messageId).toBe('msg_123');
    expect(att.expiresAt).toBe(1700000000000 + 7200000);
  });

  it('should have undefined optional fields when not provided', () => {
    const att = createInboundAttachment('x.txt', 'oc_1', 'file');

    expect(att.messageId).toBeUndefined();
    expect(att.mimeType).toBeUndefined();
    expect(att.size).toBeUndefined();
  });
});

describe('createOutboundFile', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  it('should create an OutboundFile with fileName only', () => {
    const file = createOutboundFile('result.csv');

    expect(file).toMatchObject({
      id: 'mock-uuid-1234',
      fileName: 'result.csv',
      source: 'agent',
      createdAt: 1700000000000,
    });
    expect(file.chatId).toBeUndefined();
    expect(file.threadId).toBeUndefined();
  });

  it('should always set source to agent', () => {
    const file = createOutboundFile('output.log');
    expect(file.source).toBe('agent');
  });

  it('should include all optional fields when provided', () => {
    const file = createOutboundFile('report.md', {
      mimeType: 'text/markdown',
      size: 512,
      localPath: '/workspace/report.md',
      chatId: 'oc_target',
      threadId: 'om_thread123',
      expiresInMs: 1800000,
    });

    expect(file.mimeType).toBe('text/markdown');
    expect(file.size).toBe(512);
    expect(file.localPath).toBe('/workspace/report.md');
    expect(file.chatId).toBe('oc_target');
    expect(file.threadId).toBe('om_thread123');
    expect(file.expiresAt).toBe(1700000000000 + 1800000);
  });

  it('should handle minimal options object', () => {
    const file = createOutboundFile('data.json', {});
    expect(file.fileName).toBe('data.json');
    expect(file.source).toBe('agent');
    expect(file.chatId).toBeUndefined();
    expect(file.threadId).toBeUndefined();
  });
});
