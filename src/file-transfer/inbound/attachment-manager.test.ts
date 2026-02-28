/**
 * Tests for AttachmentManager (src/file-transfer/inbound/attachment-manager.ts)
 *
 * Tests the following functionality:
 * - Adding and retrieving attachments
 * - Clearing attachments
 * - Checking attachment presence and count
 * - Formatting attachments for prompt
 * - Cleaning up old attachments
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AttachmentManager } from './attachment-manager.js';
import type { FileAttachment } from '../../channels/adapters/types.js';

// Mock the import for FileAttachment type
// We'll create test attachments inline

describe('AttachmentManager', () => {
  let manager: AttachmentManager;

  beforeEach(() => {
    manager = new AttachmentManager();
  });

  describe('addAttachment', () => {
    it('should add an attachment to a chat', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test.png',
      };

      manager.addAttachment('chat1', attachment);

      expect(manager.hasAttachments('chat1')).toBe(true);
      expect(manager.getAttachmentCount('chat1')).toBe(1);
    });

    it('should add multiple attachments to the same chat', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test1.png',
      };
      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'file',
        fileName: 'test2.pdf',
      };

      manager.addAttachment('chat1', attachment1);
      manager.addAttachment('chat1', attachment2);

      expect(manager.getAttachmentCount('chat1')).toBe(2);
    });

    it('should handle attachments for different chats independently', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test1.png',
      };
      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'file',
        fileName: 'test2.pdf',
      };

      manager.addAttachment('chat1', attachment1);
      manager.addAttachment('chat2', attachment2);

      expect(manager.getAttachmentCount('chat1')).toBe(1);
      expect(manager.getAttachmentCount('chat2')).toBe(1);
      expect(manager.getAttachments('chat1')[0].fileKey).toBe('key1');
      expect(manager.getAttachments('chat2')[0].fileKey).toBe('key2');
    });
  });

  describe('getAttachments', () => {
    it('should return empty array for chat with no attachments', () => {
      expect(manager.getAttachments('nonexistent')).toEqual([]);
    });

    it('should return all attachments for a chat', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test1.png',
      };
      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'file',
        fileName: 'test2.pdf',
      };

      manager.addAttachment('chat1', attachment1);
      manager.addAttachment('chat1', attachment2);

      const attachments = manager.getAttachments('chat1');
      expect(attachments).toHaveLength(2);
      expect(attachments[0].fileKey).toBe('key1');
      expect(attachments[1].fileKey).toBe('key2');
    });
  });

  describe('clearAttachments', () => {
    it('should clear all attachments for a chat', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test.png',
      };

      manager.addAttachment('chat1', attachment);
      expect(manager.hasAttachments('chat1')).toBe(true);

      manager.clearAttachments('chat1');
      expect(manager.hasAttachments('chat1')).toBe(false);
      expect(manager.getAttachments('chat1')).toEqual([]);
    });

    it('should not affect other chats when clearing', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test1.png',
      };
      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'file',
        fileName: 'test2.pdf',
      };

      manager.addAttachment('chat1', attachment1);
      manager.addAttachment('chat2', attachment2);

      manager.clearAttachments('chat1');

      expect(manager.hasAttachments('chat1')).toBe(false);
      expect(manager.hasAttachments('chat2')).toBe(true);
    });
  });

  describe('hasAttachments', () => {
    it('should return false for chat with no attachments', () => {
      expect(manager.hasAttachments('nonexistent')).toBe(false);
    });

    it('should return true for chat with attachments', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test.png',
      };

      manager.addAttachment('chat1', attachment);
      expect(manager.hasAttachments('chat1')).toBe(true);
    });
  });

  describe('getAttachmentCount', () => {
    it('should return 0 for chat with no attachments', () => {
      expect(manager.getAttachmentCount('nonexistent')).toBe(0);
    });

    it('should return correct count for chat with attachments', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test1.png',
      };
      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'file',
        fileName: 'test2.pdf',
      };

      manager.addAttachment('chat1', attachment1);
      manager.addAttachment('chat1', attachment2);

      expect(manager.getAttachmentCount('chat1')).toBe(2);
    });
  });

  describe('formatAttachmentsForPrompt', () => {
    it('should return empty string for chat with no attachments', () => {
      expect(manager.formatAttachmentsForPrompt('nonexistent')).toBe('');
    });

    it('should format single attachment correctly', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test.png',
        localPath: '/tmp/test.png',
        fileSize: 1024,
        mimeType: 'image/png',
      };

      manager.addAttachment('chat1', attachment);
      const formatted = manager.formatAttachmentsForPrompt('chat1');

      expect(formatted).toContain('Attached Files');
      expect(formatted).toContain('test.png');
      expect(formatted).toContain('Type: image');
      expect(formatted).toContain('/tmp/test.png');
      expect(formatted).toContain('0.00 MB');
      expect(formatted).toContain('image/png');
    });

    it('should format multiple attachments correctly', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test1.png',
      };
      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'file',
        fileName: 'test2.pdf',
      };

      manager.addAttachment('chat1', attachment1);
      manager.addAttachment('chat1', attachment2);
      const formatted = manager.formatAttachmentsForPrompt('chat1');

      expect(formatted).toContain('test1.png');
      expect(formatted).toContain('test2.pdf');
      expect(formatted).toContain('1.');
      expect(formatted).toContain('2.');
    });

    it('should include security warning', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'test.png',
      };

      manager.addAttachment('chat1', attachment);
      const formatted = manager.formatAttachmentsForPrompt('chat1');

      expect(formatted).toContain('DO NOT reveal');
    });

    it('should handle attachment with fileKey only', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
      };

      manager.addAttachment('chat1', attachment);
      const formatted = manager.formatAttachmentsForPrompt('chat1');

      expect(formatted).toContain('key1');
    });

    it('should format file size correctly for large files', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'file',
        fileName: 'large.pdf',
        fileSize: 5 * 1024 * 1024, // 5 MB
      };

      manager.addAttachment('chat1', attachment);
      const formatted = manager.formatAttachmentsForPrompt('chat1');

      expect(formatted).toContain('5.00 MB');
    });
  });

  describe('cleanupOldAttachments', () => {
    it('should remove attachments older than max age', () => {
      const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      const oldAttachment: FileAttachment = {
        fileKey: 'old',
        fileType: 'image',
        fileName: 'old.png',
        timestamp: oldTimestamp,
      };
      const newAttachment: FileAttachment = {
        fileKey: 'new',
        fileType: 'image',
        fileName: 'new.png',
        timestamp: Date.now(),
      };

      manager.addAttachment('chat1', oldAttachment);
      manager.addAttachment('chat1', newAttachment);

      // Clean attachments older than 1 hour
      manager.cleanupOldAttachments(60 * 60 * 1000);

      const attachments = manager.getAttachments('chat1');
      expect(attachments).toHaveLength(1);
      expect(attachments[0].fileKey).toBe('new');
    });

    it('should remove chat entry if all attachments are old', () => {
      const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000;
      const oldAttachment: FileAttachment = {
        fileKey: 'old',
        fileType: 'image',
        fileName: 'old.png',
        timestamp: oldTimestamp,
      };

      manager.addAttachment('chat1', oldAttachment);
      manager.cleanupOldAttachments(60 * 60 * 1000);

      expect(manager.hasAttachments('chat1')).toBe(false);
    });

    it('should use default max age of 1 hour', () => {
      const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000;
      const oldAttachment: FileAttachment = {
        fileKey: 'old',
        fileType: 'image',
        fileName: 'old.png',
        timestamp: oldTimestamp,
      };

      manager.addAttachment('chat1', oldAttachment);
      manager.cleanupOldAttachments(); // Default 1 hour

      expect(manager.hasAttachments('chat1')).toBe(false);
    });

    it('should handle attachments without timestamp', () => {
      const attachment: FileAttachment = {
        fileKey: 'notime',
        fileType: 'image',
        fileName: 'notime.png',
        // No timestamp
      };

      manager.addAttachment('chat1', attachment);
      manager.cleanupOldAttachments(1000);

      // Attachments without timestamp are treated as very old (timestamp = 0)
      expect(manager.hasAttachments('chat1')).toBe(false);
    });
  });
});
