/**
 * Tests for Feishu attachment manager (src/feishu/attachment-manager.ts)
 *
 * Tests the following functionality:
 * - Adding attachments
 * - Retrieving attachments
 * - Clearing attachments
 * - Formatting attachments for prompts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AttachmentManager, type FileAttachment } from './attachment-manager.js';

describe('AttachmentManager', () => {
  let manager: AttachmentManager;

  beforeEach(() => {
    manager = new AttachmentManager();
  });

  describe('addAttachment', () => {
    it('should add attachment to chat', () => {
      const attachment: FileAttachment = {
        fileKey: 'file_key_123',
        fileType: 'image',
        fileName: 'test.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);

      expect(manager.getAttachments('oc_chat123')).toHaveLength(1);
    });

    it('should add multiple attachments to same chat', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image1.jpg',
        timestamp: Date.now(),
      };

      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'file',
        fileName: 'document.pdf',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment1);
      manager.addAttachment('oc_chat123', attachment2);

      expect(manager.getAttachments('oc_chat123')).toHaveLength(2);
    });

    it('should handle attachments for different chats independently', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'chat1.jpg',
        timestamp: Date.now(),
      };

      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'image',
        fileName: 'chat2.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat1', attachment1);
      manager.addAttachment('oc_chat2', attachment2);

      expect(manager.getAttachments('oc_chat1')).toHaveLength(1);
      expect(manager.getAttachments('oc_chat2')).toHaveLength(1);
    });

    it('should preserve all attachment metadata', () => {
      const attachment: FileAttachment = {
        fileKey: 'key123',
        fileType: 'file',
        fileName: 'test.pdf',
        localPath: '/tmp/test.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
        timestamp: Date.now(),
        messageId: 'om_msg123',
      };

      manager.addAttachment('oc_chat123', attachment);

      const retrieved = manager.getAttachments('oc_chat123')[0];

      expect(retrieved).toEqual(attachment);
    });
  });

  describe('getAttachments', () => {
    it('should return empty array for chat with no attachments', () => {
      const attachments = manager.getAttachments('oc_chat123');

      expect(attachments).toEqual([]);
    });

    it('should return all attachments for a chat', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image1.jpg',
        timestamp: Date.now(),
      };

      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'image',
        fileName: 'image2.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment1);
      manager.addAttachment('oc_chat123', attachment2);

      const attachments = manager.getAttachments('oc_chat123');

      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toEqual(attachment1);
      expect(attachments[1]).toEqual(attachment2);
    });

    it('should not return attachments from other chats', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat1', attachment);

      const attachments = manager.getAttachments('oc_chat2');

      expect(attachments).toEqual([]);
    });
  });

  describe('clearAttachments', () => {
    it('should clear all attachments for a chat', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);
      expect(manager.hasAttachments('oc_chat123')).toBe(true);

      manager.clearAttachments('oc_chat123');

      expect(manager.hasAttachments('oc_chat123')).toBe(false);
    });

    it('should not affect other chats', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image1.jpg',
        timestamp: Date.now(),
      };

      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'image',
        fileName: 'image2.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat1', attachment1);
      manager.addAttachment('oc_chat2', attachment2);

      manager.clearAttachments('oc_chat1');

      expect(manager.hasAttachments('oc_chat1')).toBe(false);
      expect(manager.hasAttachments('oc_chat2')).toBe(true);
    });

    it('should handle clearing chat with no attachments', () => {
      expect(() => manager.clearAttachments('oc_chat123')).not.toThrow();
      expect(manager.hasAttachments('oc_chat123')).toBe(false);
    });
  });

  describe('hasAttachments', () => {
    it('should return false for chat with no attachments', () => {
      expect(manager.hasAttachments('oc_chat123')).toBe(false);
    });

    it('should return true for chat with attachments', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);

      expect(manager.hasAttachments('oc_chat123')).toBe(true);
    });

    it('should return false after clearing attachments', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);
      manager.clearAttachments('oc_chat123');

      expect(manager.hasAttachments('oc_chat123')).toBe(false);
    });
  });

  describe('getAttachmentCount', () => {
    it('should return 0 for chat with no attachments', () => {
      expect(manager.getAttachmentCount('oc_chat123')).toBe(0);
    });

    it('should return correct count for chat with attachments', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image1.jpg',
        timestamp: Date.now(),
      };

      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'image',
        fileName: 'image2.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment1);
      manager.addAttachment('oc_chat123', attachment2);

      expect(manager.getAttachmentCount('oc_chat123')).toBe(2);
    });
  });

  describe('formatAttachmentsForPrompt', () => {
    it('should return empty string for no attachments', () => {
      const formatted = manager.formatAttachmentsForPrompt('oc_chat123');

      expect(formatted).toBe('');
    });

    it('should format single attachment', () => {
      const attachment: FileAttachment = {
        fileKey: 'key123',
        fileType: 'image',
        fileName: 'test.jpg',
        localPath: '/tmp/test.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);

      const formatted = manager.formatAttachmentsForPrompt('oc_chat123');

      expect(formatted).toContain('Attached Files');
      expect(formatted).toContain('test.jpg');
      expect(formatted).toContain('image');
    });

    it('should format multiple attachments', () => {
      const attachment1: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image1.jpg',
        localPath: '/tmp/image1.jpg',
        timestamp: Date.now(),
      };

      const attachment2: FileAttachment = {
        fileKey: 'key2',
        fileType: 'file',
        fileName: 'document.pdf',
        localPath: '/tmp/document.pdf',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment1);
      manager.addAttachment('oc_chat123', attachment2);

      const formatted = manager.formatAttachmentsForPrompt('oc_chat123');

      expect(formatted).toContain('image1.jpg');
      expect(formatted).toContain('document.pdf');
    });

    it('should include local path in formatted output', () => {
      const attachment: FileAttachment = {
        fileKey: 'key123',
        fileType: 'image',
        fileName: 'test.jpg',
        localPath: '/tmp/test.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);

      const formatted = manager.formatAttachmentsForPrompt('oc_chat123');

      expect(formatted).toContain('/tmp/test.jpg');
    });

    it('should handle missing optional fields', () => {
      const attachment: FileAttachment = {
        fileKey: 'key123',
        fileType: 'image',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);

      const formatted = manager.formatAttachmentsForPrompt('oc_chat123');

      expect(formatted).toContain('key123');
    });
  });

  describe('edge cases', () => {
    it('should handle empty chat ID', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        timestamp: Date.now(),
      };

      manager.addAttachment('', attachment);

      expect(manager.getAttachments('')).toHaveLength(1);
    });

    it('should handle very long file names', () => {
      const longName = 'a'.repeat(500);

      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'file',
        fileName: longName,
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);

      const formatted = manager.formatAttachmentsForPrompt('oc_chat123');

      expect(formatted).toContain(longName);
    });

    it('should handle special characters in file names', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'file',
        fileName: '测试文件 (中文).pdf',
        timestamp: Date.now(),
      };

      manager.addAttachment('oc_chat123', attachment);

      expect(manager.getAttachments('oc_chat123')[0].fileName).toBe('测试文件 (中文).pdf');
    });
  });
});
