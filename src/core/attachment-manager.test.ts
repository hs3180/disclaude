/**
 * Tests for core attachment manager (src/core/attachment-manager.ts)
 *
 * Tests the platform-agnostic attachment management functionality.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AttachmentManager, attachmentManager } from './attachment-manager.js';
import type { FileAttachment, IAttachmentManager } from '../channels/adapters/types.js';

describe('AttachmentManager (Core)', () => {
  let manager: IAttachmentManager;

  beforeEach(() => {
    manager = new AttachmentManager();
  });

  describe('interface implementation', () => {
    it('should implement IAttachmentManager', () => {
      expect(manager.hasAttachments).toBeDefined();
      expect(manager.getAttachments).toBeDefined();
      expect(manager.addAttachment).toBeDefined();
      expect(manager.clearAttachments).toBeDefined();
    });
  });

  describe('addAttachment', () => {
    it('should add attachment to chat', () => {
      const attachment: FileAttachment = {
        fileKey: 'key123',
        fileType: 'image',
        fileName: 'test.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('chat123', attachment);

      expect(manager.getAttachments('chat123')).toHaveLength(1);
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

      manager.addAttachment('chat123', attachment1);
      manager.addAttachment('chat123', attachment2);

      expect(manager.getAttachments('chat123')).toHaveLength(2);
    });
  });

  describe('getAttachments', () => {
    it('should return empty array for chat with no attachments', () => {
      const attachments = manager.getAttachments('chat123');

      expect(attachments).toEqual([]);
    });

    it('should return all attachments for a chat', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('chat123', attachment);

      const attachments = manager.getAttachments('chat123');

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual(attachment);
    });
  });

  describe('hasAttachments', () => {
    it('should return false for chat with no attachments', () => {
      expect(manager.hasAttachments('chat123')).toBe(false);
    });

    it('should return true for chat with attachments', () => {
      const attachment: FileAttachment = {
        fileKey: 'key1',
        fileType: 'image',
        fileName: 'image.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('chat123', attachment);

      expect(manager.hasAttachments('chat123')).toBe(true);
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

      manager.addAttachment('chat123', attachment);
      expect(manager.hasAttachments('chat123')).toBe(true);

      manager.clearAttachments('chat123');

      expect(manager.hasAttachments('chat123')).toBe(false);
    });
  });

  describe('cleanupOldAttachments', () => {
    it('should clean up old attachments', () => {
      const oldAttachment: FileAttachment = {
        fileKey: 'old',
        fileType: 'image',
        fileName: 'old.jpg',
        timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      };

      const newAttachment: FileAttachment = {
        fileKey: 'new',
        fileType: 'image',
        fileName: 'new.jpg',
        timestamp: Date.now(),
      };

      manager.addAttachment('chat123', oldAttachment);
      manager.addAttachment('chat123', newAttachment);

      (manager as AttachmentManager).cleanupOldAttachments();

      const attachments = manager.getAttachments('chat123');
      expect(attachments).toHaveLength(1);
      expect(attachments[0].fileKey).toBe('new');
    });
  });
});

describe('attachmentManager global instance (Core)', () => {
  it('should be an AttachmentManager instance', () => {
    expect(attachmentManager).toBeInstanceOf(AttachmentManager);
  });
});
