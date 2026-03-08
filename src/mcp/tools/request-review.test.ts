/**
 * Tests for request_review tool.
 *
 * @module mcp/tools/request-review.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request_review, request_quick_review, request_batch_review } from './request-review.js';
import * as interactiveMessage from './interactive-message.js';

// Mock send_interactive_message
vi.mock('./interactive-message.js', () => ({
  send_interactive_message: vi.fn(),
}));

describe('request_review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error when title is missing', async () => {
    const result = await request_review({
      title: '',
      summary: 'test',
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('title is required');
  });

  it('should return error when summary is missing', async () => {
    const result = await request_review({
      title: 'Test',
      summary: '',
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('summary is required');
  });

  it('should return error when chatId is missing', async () => {
    const result = await request_review({
      title: 'Test',
      summary: 'test summary',
      chatId: '',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('chatId is required');
  });

  it('should send review card with default modern theme', async () => {
    vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValueOnce({
      success: true,
      message: 'Interactive message sent',
      messageId: 'msg_123',
    });

    const result = await request_review({
      title: 'Test Review',
      summary: 'Please review this change',
      chatId: 'oc_test',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_123');
    expect(interactiveMessage.send_interactive_message).toHaveBeenCalledTimes(1);

    const [[callArgs]] = vi.mocked(interactiveMessage.send_interactive_message).mock.calls;
    expect(callArgs.chatId).toBe('oc_test');
    expect(callArgs.card).toBeDefined();
    expect(callArgs.actionPrompts).toBeDefined();
    expect(callArgs.actionPrompts.approve).toBeDefined();
    expect(callArgs.actionPrompts.reject).toBeDefined();
    expect(callArgs.actionPrompts.request_changes).toBeDefined();
  });

  it('should send review card with imperial theme', async () => {
    vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValueOnce({
      success: true,
      message: 'Interactive message sent',
      messageId: 'msg_123',
    });

    const result = await request_review({
      title: '奏折',
      summary: '请陛下批阅',
      chatId: 'oc_test',
      theme: 'imperial',
    });

    expect(result.success).toBe(true);

    const [[callArgs]] = vi.mocked(interactiveMessage.send_interactive_message).mock.calls;
    expect(callArgs.actionPrompts.approve).toContain('准奏');
    expect(callArgs.actionPrompts.reject).toContain('驳回');
  });

  it('should include changes in review card', async () => {
    vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValueOnce({
      success: true,
      message: 'Interactive message sent',
      messageId: 'msg_123',
    });

    const result = await request_review({
      title: 'Code Review',
      summary: 'Please review the changes',
      chatId: 'oc_test',
      changes: [
        { path: 'src/auth.ts', type: 'modified', additions: 10, deletions: 5 },
        { path: 'tests/auth.test.ts', type: 'added', additions: 30 },
      ],
    });

    expect(result.success).toBe(true);
    expect(interactiveMessage.send_interactive_message).toHaveBeenCalledTimes(1);
  });

  it('should include diff content in review card', async () => {
    vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValueOnce({
      success: true,
      message: 'Interactive message sent',
      messageId: 'msg_123',
    });

    const result = await request_review({
      title: 'Code Review',
      summary: 'Please review the diff',
      chatId: 'oc_test',
      diffContent: 'diff --git a/file.ts\n+new line\n-old line',
    });

    expect(result.success).toBe(true);
    expect(interactiveMessage.send_interactive_message).toHaveBeenCalledTimes(1);
  });

  it('should handle send_interactive_message failure', async () => {
    vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValueOnce({
      success: false,
      message: 'Failed to send',
      error: 'Network error',
    });

    const result = await request_review({
      title: 'Test',
      summary: 'test',
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });
});

describe('request_quick_review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error when required params are missing', async () => {
    const result = await request_quick_review({
      title: '',
      message: 'test',
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
  });

  it('should send quick review card', async () => {
    vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValueOnce({
      success: true,
      message: 'Interactive message sent',
      messageId: 'msg_456',
    });

    const result = await request_quick_review({
      title: 'Confirm Action',
      message: 'Do you want to proceed?',
      chatId: 'oc_test',
      theme: 'imperial',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_456');
  });
});

describe('request_batch_review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return error when items are missing', async () => {
    const result = await request_batch_review({
      title: 'Batch Review',
      items: [],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
  });

  it('should send batch review card', async () => {
    vi.mocked(interactiveMessage.send_interactive_message).mockResolvedValueOnce({
      success: true,
      message: 'Interactive message sent',
      messageId: 'msg_789',
    });

    const result = await request_batch_review({
      title: 'Batch File Approval',
      items: [
        { name: 'file1.ts', description: 'New feature' },
        { name: 'file2.ts', description: 'Bug fix' },
      ],
      chatId: 'oc_test',
      theme: 'modern',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_789');
    expect(result.message).toContain('2 items');
  });
});
