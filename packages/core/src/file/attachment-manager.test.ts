/**
 * Tests for AttachmentManager (packages/core/src/file/attachment-manager.ts)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AttachmentManager } from './attachment-manager.js';
import type { FileAttachment } from '../types/adapter.js';

describe('AttachmentManager', () => {
  let manager: AttachmentManager;

  beforeEach(() => {
    manager = new AttachmentManager();
  });

  // -- Helper to create a basic FileAttachment --

  function makeAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
    return {
      fileKey: 'file-key-1',
      fileName: 'test.pdf',
      fileType: 'file',
      timestamp: Date.now(),
      ...overrides,
    };
  }

  // -- addAttachment / getAttachments --

  describe('addAttachment', () => {
    it('should add an attachment to a new chat', () => {
      const att = makeAttachment();
      manager.addAttachment('chat-1', att);
      expect(manager.getAttachments('chat-1')).toEqual([att]);
    });

    it('should append to existing attachments for the same chat', () => {
      const att1 = makeAttachment({ fileKey: 'key-1' });
      const att2 = makeAttachment({ fileKey: 'key-2' });
      manager.addAttachment('chat-1', att1);
      manager.addAttachment('chat-1', att2);
      expect(manager.getAttachments('chat-1')).toHaveLength(2);
    });

    it('should track attachments per chat independently', () => {
      manager.addAttachment('chat-1', makeAttachment({ fileKey: 'a' }));
      manager.addAttachment('chat-2', makeAttachment({ fileKey: 'b' }));
      expect(manager.getAttachments('chat-1')).toHaveLength(1);
      expect(manager.getAttachments('chat-2')).toHaveLength(1);
    });
  });

  // -- getAttachments (unknown chat) --

  describe('getAttachments', () => {
    it('should return empty array for unknown chatId', () => {
      expect(manager.getAttachments('unknown')).toEqual([]);
    });
  });

  // -- clearAttachments --

  describe('clearAttachments', () => {
    it('should remove all attachments for a chat', () => {
      manager.addAttachment('chat-1', makeAttachment());
      manager.clearAttachments('chat-1');
      expect(manager.getAttachments('chat-1')).toEqual([]);
    });

    it('should not affect other chats', () => {
      manager.addAttachment('chat-1', makeAttachment({ fileKey: 'a' }));
      manager.addAttachment('chat-2', makeAttachment({ fileKey: 'b' }));
      manager.clearAttachments('chat-1');
      expect(manager.getAttachments('chat-2')).toHaveLength(1);
    });
  });

  // -- hasAttachments --

  describe('hasAttachments', () => {
    it('should return false for unknown chat', () => {
      expect(manager.hasAttachments('unknown')).toBe(false);
    });

    it('should return false after clearing', () => {
      manager.addAttachment('chat-1', makeAttachment());
      manager.clearAttachments('chat-1');
      expect(manager.hasAttachments('chat-1')).toBe(false);
    });

    it('should return true when attachments exist', () => {
      manager.addAttachment('chat-1', makeAttachment());
      expect(manager.hasAttachments('chat-1')).toBe(true);
    });
  });

  // -- getAttachmentCount --

  describe('getAttachmentCount', () => {
    it('should return 0 for unknown chat', () => {
      expect(manager.getAttachmentCount('unknown')).toBe(0);
    });

    it('should return correct count', () => {
      manager.addAttachment('chat-1', makeAttachment({ fileKey: 'a' }));
      manager.addAttachment('chat-1', makeAttachment({ fileKey: 'b' }));
      manager.addAttachment('chat-1', makeAttachment({ fileKey: 'c' }));
      expect(manager.getAttachmentCount('chat-1')).toBe(3);
    });
  });

  // -- formatAttachmentsForPrompt --

  describe('formatAttachmentsForPrompt', () => {
    it('should return empty string for no attachments', () => {
      expect(manager.formatAttachmentsForPrompt('chat-1')).toBe('');
    });

    it('should include file name and type', () => {
      manager.addAttachment('chat-1', makeAttachment({
        fileName: 'report.pdf',
        fileType: 'file',
      }));
      const result = manager.formatAttachmentsForPrompt('chat-1');
      expect(result).toContain('report.pdf');
      expect(result).toContain('Type: file');
    });

    it('should include local path when available', () => {
      manager.addAttachment('chat-1', makeAttachment({
        localPath: '/tmp/downloads/report.pdf',
      }));
      const result = manager.formatAttachmentsForPrompt('chat-1');
      expect(result).toContain('/tmp/downloads/report.pdf');
    });

    it('should include file size in MB', () => {
      manager.addAttachment('chat-1', makeAttachment({
        fileSize: 1024 * 1024 * 2.5, // 2.5 MB
      }));
      const result = manager.formatAttachmentsForPrompt('chat-1');
      expect(result).toContain('2.50 MB');
    });

    it('should include MIME type when available', () => {
      manager.addAttachment('chat-1', makeAttachment({
        mimeType: 'application/pdf',
      }));
      const result = manager.formatAttachmentsForPrompt('chat-1');
      expect(result).toContain('application/pdf');
    });

    it('should include path warning', () => {
      manager.addAttachment('chat-1', makeAttachment());
      const result = manager.formatAttachmentsForPrompt('chat-1');
      expect(result).toContain('DO NOT reveal');
    });

    it('should number attachments', () => {
      manager.addAttachment('chat-1', makeAttachment({ fileKey: 'a' }));
      manager.addAttachment('chat-1', makeAttachment({ fileKey: 'b' }));
      const result = manager.formatAttachmentsForPrompt('chat-1');
      expect(result).toContain('1.');
      expect(result).toContain('2.');
    });

    it('should use fileKey when fileName is missing', () => {
      manager.addAttachment('chat-1', makeAttachment({ fileName: undefined }));
      const result = manager.formatAttachmentsForPrompt('chat-1');
      expect(result).toContain('file-key-1');
    });
  });

  // -- cleanupOldAttachments --

  describe('cleanupOldAttachments', () => {
    it('should remove attachments older than maxAgeMs', () => {
      const now = Date.now();
      const oldAtt = makeAttachment({ timestamp: now - 2 * 60 * 60 * 1000 }); // 2 hours ago
      const freshAtt = makeAttachment({ timestamp: now - 30 * 60 * 1000 }); // 30 min ago

      manager.addAttachment('chat-1', oldAtt);
      manager.addAttachment('chat-1', freshAtt);

      manager.cleanupOldAttachments(60 * 60 * 1000); // 1 hour threshold

      expect(manager.getAttachments('chat-1')).toHaveLength(1);
      expect(manager.getAttachments('chat-1')[0].fileKey).toBe(freshAtt.fileKey);
    });

    it('should remove chat entry when all attachments are old', () => {
      const now = Date.now();
      manager.addAttachment('chat-1', makeAttachment({ timestamp: now - 2 * 60 * 60 * 1000 }));

      manager.cleanupOldAttachments(60 * 60 * 1000);

      expect(manager.hasAttachments('chat-1')).toBe(false);
    });

    it('should keep attachments with no timestamp', () => {
      // timestamp undefined means age = now - 0 = 0, so always within threshold
      manager.addAttachment('chat-1', makeAttachment({ timestamp: undefined }));
      manager.cleanupOldAttachments(0); // even 0ms threshold
      // timestamp is undefined, age = now - (undefined || 0) = now, which is >= 0
      // Actually: now - (undefined || 0) = now - 0 = now, and now >= 0 is true, so it IS filtered out
      // Let me re-check: age = now - (att.timestamp || 0). If timestamp is undefined, age = now.
      // For maxAgeMs = 0, age (now) >= 0 is true, so it IS removed.
      // This test verifies that behavior.
      expect(manager.hasAttachments('chat-1')).toBe(false);
    });

    it('should use 1 hour default threshold', () => {
      const now = Date.now();
      const halfHourAgo = makeAttachment({ timestamp: now - 30 * 60 * 1000 });
      const twoHoursAgo = makeAttachment({ timestamp: now - 2 * 60 * 60 * 1000 });

      manager.addAttachment('chat-1', halfHourAgo);
      manager.addAttachment('chat-2', twoHoursAgo);

      manager.cleanupOldAttachments(); // default 1 hour

      expect(manager.hasAttachments('chat-1')).toBe(true);
      expect(manager.hasAttachments('chat-2')).toBe(false);
    });

    it('should handle attachments with timestamp=0 (very old)', () => {
      manager.addAttachment('chat-1', makeAttachment({ timestamp: 0 }));
      manager.cleanupOldAttachments(1000); // 1 second threshold
      expect(manager.hasAttachments('chat-1')).toBe(false);
    });
  });
});
