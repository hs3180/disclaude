/**
 * Tests for request_review tool.
 *
 * @module mcp/tools/request-review.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request_review, quick_review } from './request-review.js';
import * as interactiveMessage from './interactive-message.js';

// Mock the send_interactive_message function
vi.mock('./interactive-message.js', () => ({
  send_interactive_message: vi.fn(),
}));

const mockSendInteractiveMessage = vi.mocked(interactiveMessage.send_interactive_message);

describe('request_review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parameter validation', () => {
    it('should fail when title is missing', async () => {
      const result = await request_review({
        title: '',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('title is required');
    });

    it('should fail when title is not a string', async () => {
      const result = await request_review({
        title: undefined as unknown as string,
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('title is required');
    });

    it('should fail when chatId is missing', async () => {
      const result = await request_review({
        title: 'Test Review',
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });
  });

  describe('basic review request', () => {
    it('should send interactive message with default modern theme', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      const result = await request_review({
        title: 'Code Review Request',
        summary: 'Please review my changes',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('现代');
      expect(result.messageId).toBe('msg_123');
      expect(mockSendInteractiveMessage).toHaveBeenCalledTimes(1);

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      expect(callArgs.chatId).toBe('oc_test');
      expect(callArgs.card).toBeDefined();
      expect(callArgs.actionPrompts).toBeDefined();
    });

    it('should send interactive message with imperial theme', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_456',
      });

      const result = await request_review({
        title: '奏折呈递',
        summary: '臣有一事启奏',
        theme: 'imperial',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('御书房');
      expect(result.messageId).toBe('msg_456');
    });

    it('should send interactive message with minimal theme', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_789',
      });

      const result = await request_review({
        title: 'Simple Review',
        theme: 'minimal',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('简约');
    });
  });

  describe('review with changes', () => {
    it('should include changes in the review card', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_changes',
      });

      const result = await request_review({
        title: 'Feature Complete',
        summary: 'Added new feature',
        changes: [
          { path: 'src/feature.ts', type: 'added', additions: 100, deletions: 0 },
          { path: 'tests/feature.test.ts', type: 'modified', additions: 50, deletions: 10 },
        ],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(mockSendInteractiveMessage).toHaveBeenCalledTimes(1);

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      expect(callArgs.card).toBeDefined();
    });

    it('should handle changes with descriptions', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_desc',
      });

      const result = await request_review({
        title: 'Bug Fix',
        changes: [
          { path: 'src/bug.ts', type: 'modified', description: 'Fixed null pointer', additions: 5, deletions: 2 },
        ],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('review with diff', () => {
    it('should send review with diff preview', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_diff',
      });

      const result = await request_review({
        title: 'Code Changes',
        summary: 'Refactored the module',
        diff: '--- a/old.ts\n+++ b/new.ts\n@@ -1,3 +1,4 @@',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(mockSendInteractiveMessage).toHaveBeenCalledTimes(1);
    });

    it('should respect maxDiffLines parameter', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_maxdiff',
      });

      const result = await request_review({
        title: 'Large Changes',
        diff: 'very long diff content...',
        maxDiffLines: 50,
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('batch review', () => {
    it('should send batch review card with items', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_batch',
      });

      const result = await request_review({
        title: 'Batch Approval',
        items: [
          { name: 'PR #101', description: 'Fix login bug' },
          { name: 'PR #102', description: 'Add dark mode' },
          { name: 'PR #103', description: 'Update docs' },
        ],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(mockSendInteractiveMessage).toHaveBeenCalledTimes(1);

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      expect(callArgs.actionPrompts).toHaveProperty('approve_all');
      expect(callArgs.actionPrompts).toHaveProperty('reject_all');
    });

    it('should handle items without descriptions', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_nodesc',
      });

      const result = await request_review({
        title: 'Simple Batch',
        items: [
          { name: 'Item 1' },
          { name: 'Item 2' },
        ],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('context and details', () => {
    it('should include context in the review', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_context',
      });

      const result = await request_review({
        title: 'PR Review',
        context: 'PR #123',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
    });

    it('should include details in the review', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_details',
      });

      const result = await request_review({
        title: 'Detailed Review',
        details: 'This is a detailed explanation of the changes',
        footerNote: 'Please review by EOD',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('thread reply', () => {
    it('should support parentMessageId for thread reply', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_thread',
      });

      const result = await request_review({
        title: 'Thread Review',
        chatId: 'oc_test',
        parentMessageId: 'om_parent',
      });

      expect(result.success).toBe(true);

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      expect(callArgs.parentMessageId).toBe('om_parent');
    });
  });

  describe('error handling', () => {
    it('should return error when send_interactive_message fails', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: false,
        error: 'Network error',
        message: 'Failed to send message',
      });

      const result = await request_review({
        title: 'Test Review',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should handle exceptions', async () => {
      mockSendInteractiveMessage.mockRejectedValueOnce(new Error('Unexpected error'));

      const result = await request_review({
        title: 'Test Review',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unexpected error');
    });
  });
});

describe('quick_review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parameter validation', () => {
    it('should fail when title is missing', async () => {
      const result = await quick_review({
        title: '',
        message: 'Test message',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('title and message are required');
    });

    it('should fail when message is missing', async () => {
      const result = await quick_review({
        title: 'Test Title',
        message: '',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('title and message are required');
    });

    it('should fail when chatId is missing', async () => {
      const result = await quick_review({
        title: 'Test Title',
        message: 'Test message',
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });
  });

  describe('successful calls', () => {
    it('should send quick review with default theme', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_quick',
      });

      const result = await quick_review({
        title: 'Quick Confirmation',
        message: 'Do you want to proceed?',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('快速审批');
      expect(result.messageId).toBe('msg_quick');
      expect(mockSendInteractiveMessage).toHaveBeenCalledTimes(1);

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      expect(callArgs.chatId).toBe('oc_test');
      expect(callArgs.card).toBeDefined();
      expect(callArgs.actionPrompts).toBeDefined();
    });

    it('should send quick review with imperial theme', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_imperial',
      });

      const result = await quick_review({
        title: '请圣裁',
        message: '此事需陛下定夺',
        theme: 'imperial',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
    });

    it('should support parentMessageId for thread reply', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_quick_thread',
      });

      const result = await quick_review({
        title: 'Thread Quick Review',
        message: 'Quick question',
        chatId: 'oc_test',
        parentMessageId: 'om_parent',
      });

      expect(result.success).toBe(true);

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      expect(callArgs.parentMessageId).toBe('om_parent');
    });
  });

  describe('error handling', () => {
    it('should return error when send_interactive_message fails', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: false,
        error: 'API error',
        message: 'Failed',
      });

      const result = await quick_review({
        title: 'Test',
        message: 'Test message',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });

    it('should handle exceptions', async () => {
      mockSendInteractiveMessage.mockRejectedValueOnce(new Error('Network failure'));

      const result = await quick_review({
        title: 'Test',
        message: 'Test message',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network failure');
    });
  });
});
