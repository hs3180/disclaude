/**
 * Tests for Request Review MCP Tool.
 *
 * This module tests the request_review tool functionality for the
 * "御书房批奏折" review experience (Issue #946).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request_review, quick_review, batch_review } from './request-review.js';
import * as interactiveMessage from './interactive-message.js';

// Mock the send_interactive_message function
vi.mock('./interactive-message.js', () => ({
  send_interactive_message: vi.fn(),
}));

describe('Request Review Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('request_review', () => {
    it('should send review request with default modern theme', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      const result = await request_review({
        title: 'Code Review',
        summary: 'Please review this change',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('审批请求已发送');
      expect(result.messageId).toBe('msg_123');
      expect(interactiveMessage.send_interactive_message).toHaveBeenCalledTimes(1);
    });

    it('should send review request with imperial theme', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      const result = await request_review({
        title: '代码变更请求',
        summary: '修复了用户认证的 bug',
        theme: 'imperial',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('御书房');
    });

    it('should send review request with changes list', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      const result = await request_review({
        title: 'Code Review',
        summary: 'Multiple changes',
        changes: [
          { path: 'src/auth.ts', type: 'modified', additions: 10, deletions: 5 },
          { path: 'tests/auth.test.ts', type: 'added', additions: 30 },
        ],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(interactiveMessage.send_interactive_message).toHaveBeenCalledTimes(1);

      // Verify the call included proper card structure
      const callArgs = vi.mocked(interactiveMessage.send_interactive_message).mock.calls[0][0];
      expect(callArgs.card).toBeDefined();
      expect(callArgs.actionPrompts).toBeDefined();
    });

    it('should send review request with details', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      const result = await request_review({
        title: 'Code Review',
        summary: 'Please review',
        details: 'Additional context here',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
    });

    it('should send review request with parentMessageId for thread reply', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      const result = await request_review({
        title: 'Thread Review',
        summary: 'Reply in thread',
        chatId: 'oc_test',
        parentMessageId: 'parent_msg_456',
      });

      expect(result.success).toBe(true);
      const callArgs = vi.mocked(interactiveMessage.send_interactive_message).mock.calls[0][0];
      expect(callArgs.parentMessageId).toBe('parent_msg_456');
    });

    it('should handle API failure', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: false,
        message: 'API error',
      });

      const result = await request_review({
        title: 'Code Review',
        summary: 'Please review',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('失败');
    });

    it('should handle exceptions', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockRejectedValue(new Error('Network error'));

      const result = await request_review({
        title: 'Code Review',
        summary: 'Please review',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('出错');
    });
  });

  describe('quick_review', () => {
    it('should send quick review request', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_456',
      });

      const result = await quick_review({
        title: 'Quick Decision',
        message: 'Should we proceed?',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('快速审批请求已发送');
      expect(result.messageId).toBe('msg_456');
    });

    it('should send quick review with imperial theme', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_456',
      });

      const result = await quick_review({
        title: '确认操作',
        message: '是否继续执行？',
        theme: 'imperial',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
    });

    it('should handle API failure', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: false,
        message: 'Failed to send',
      });

      const result = await quick_review({
        title: 'Quick Review',
        message: 'Test',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('batch_review', () => {
    it('should send batch review request', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_789',
      });

      const result = await batch_review({
        title: 'Batch Approval',
        items: [
          { name: 'file1.ts', description: 'New feature' },
          { name: 'file2.ts', description: 'Bug fix' },
        ],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('批量审批请求已发送');
      expect(result.message).toContain('项目数: 2');
    });

    it('should send batch review with many items', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: true,
        message: 'Message sent',
        messageId: 'msg_789',
      });

      const items = Array.from({ length: 15 }, (_, i) => ({
        name: `file${i}.ts`,
        description: `Change ${i}`,
      }));

      const result = await batch_review({
        title: 'Large Batch',
        items,
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('项目数: 15');
    });

    it('should handle API failure', async () => {
      vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValue({
        success: false,
        message: 'Failed',
      });

      const result = await batch_review({
        title: 'Batch Review',
        items: [{ name: 'file.ts' }],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
    });
  });
});
