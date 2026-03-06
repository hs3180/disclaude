/**
 * Tests for ask_user tool.
 *
 * @module mcp/tools/ask-user.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ask_user } from './ask-user.js';
import * as interactiveMessage from './interactive-message.js';

// Mock the send_interactive_message function
vi.mock('./interactive-message.js', () => ({
  send_interactive_message: vi.fn(),
}));

const mockSendInteractiveMessage = vi.mocked(interactiveMessage.send_interactive_message);

describe('ask_user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parameter validation', () => {
    it('should fail when question is missing', async () => {
      const result = await ask_user({
        question: '',
        options: [{ text: 'Option 1' }],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('question is required');
    });

    it('should fail when options is empty', async () => {
      const result = await ask_user({
        question: 'Test question?',
        options: [],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty array');
    });

    it('should fail when options is missing', async () => {
      const result = await ask_user({
        question: 'Test question?',
        options: undefined as unknown as [],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty array');
    });

    it('should fail when chatId is missing', async () => {
      const result = await ask_user({
        question: 'Test question?',
        options: [{ text: 'Option 1' }],
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });

    it('should fail when option text is missing', async () => {
      const result = await ask_user({
        question: 'Test question?',
        options: [{ text: '' }],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("missing 'text'");
    });
  });

  describe('successful execution', () => {
    it('should send interactive message with correct card structure', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      const result = await ask_user({
        question: 'What is your choice?',
        options: [
          { text: 'Option A', value: 'a' },
          { text: 'Option B', value: 'b' },
        ],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg_123');
      expect(mockSendInteractiveMessage).toHaveBeenCalledTimes(1);

      // Verify the call arguments
      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      expect(callArgs.chatId).toBe('oc_test');

      // Verify card structure
      expect(callArgs.card).toHaveProperty('config');
      expect(callArgs.card).toHaveProperty('header');
      expect(callArgs.card).toHaveProperty('elements');
    });

    it('should build action prompts with context', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      await ask_user({
        question: 'How to handle this PR?',
        options: [
          { text: 'Merge', value: 'merge', action: 'Execute gh pr merge' },
          { text: 'Close', value: 'close', style: 'danger', action: 'Execute gh pr close' },
        ],
        context: 'PR #123: Fix bug',
        chatId: 'oc_test',
      });

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;

      // Verify action prompts include context
      expect(callArgs.actionPrompts['merge']).toContain('PR #123: Fix bug');
      expect(callArgs.actionPrompts['merge']).toContain('Execute gh pr merge');
      expect(callArgs.actionPrompts['close']).toContain('Execute gh pr close');
    });

    it('should use default title when not provided', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      await ask_user({
        question: 'Test?',
        options: [{ text: 'OK' }],
        chatId: 'oc_test',
      });

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      const card = callArgs.card as { header: { title: { content: string } } };
      expect(card.header.title.content).toBe('🤖 Agent 提问');
    });

    it('should use custom title when provided', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      await ask_user({
        question: 'Test?',
        options: [{ text: 'OK' }],
        title: '🔔 Custom Title',
        chatId: 'oc_test',
      });

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      const card = callArgs.card as { header: { title: { content: string } } };
      expect(card.header.title.content).toBe('🔔 Custom Title');
    });

    it('should apply button styles correctly', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      await ask_user({
        question: 'Delete this file?',
        options: [
          { text: 'Confirm', value: 'confirm', style: 'primary' },
          { text: 'Delete', value: 'delete', style: 'danger' },
          { text: 'Cancel', value: 'cancel', style: 'default' },
        ],
        chatId: 'oc_test',
      });

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      const card = callArgs.card as { elements: Array<{ actions?: Array<{ type: string }> }> };
      const actions = card.elements[1].actions as Array<{ type: string }>;

      expect(actions[0].type).toBe('primary');
      expect(actions[1].type).toBe('danger');
      expect(actions[2].type).toBe('default');
    });

    it('should generate default value when not provided', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      await ask_user({
        question: 'Test?',
        options: [
          { text: 'First' },
          { text: 'Second' },
        ],
        chatId: 'oc_test',
      });

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;

      // Should have generated values based on index
      expect(callArgs.actionPrompts).toHaveProperty('option_First');
      expect(callArgs.actionPrompts).toHaveProperty('option_Second');
    });

    it('should pass parentMessageId for thread reply', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      await ask_user({
        question: 'Test?',
        options: [{ text: 'OK' }],
        chatId: 'oc_test',
        parentMessageId: 'parent_123',
      });

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      expect(callArgs.parentMessageId).toBe('parent_123');
    });
  });

  describe('error handling', () => {
    it('should propagate errors from send_interactive_message', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: false,
        message: 'Failed to send',
        error: 'Network error',
      });

      const result = await ask_user({
        question: 'Test?',
        options: [{ text: 'OK' }],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should handle exceptions', async () => {
      mockSendInteractiveMessage.mockRejectedValueOnce(new Error('Unexpected error'));

      const result = await ask_user({
        question: 'Test?',
        options: [{ text: 'OK' }],
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unexpected error');
    });
  });

  describe('action prompt generation', () => {
    it('should include context and action in prompts', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      await ask_user({
        question: 'Choose a plan:',
        options: [
          {
            text: 'Plan A',
            value: 'plan_a',
            style: 'primary',
            action: 'Implement using approach A',
          },
        ],
        context: 'Issue #789: Feature implementation',
        chatId: 'oc_test',
      });

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      const prompt = callArgs.actionPrompts['plan_a'];

      expect(prompt).toContain('[用户操作]');
      expect(prompt).toContain('Plan A');
      expect(prompt).toContain('Issue #789: Feature implementation');
      expect(prompt).toContain('Implement using approach A');
    });

    it('should work without context and action', async () => {
      mockSendInteractiveMessage.mockResolvedValueOnce({
        success: true,
        message: 'Message sent',
        messageId: 'msg_123',
      });

      await ask_user({
        question: 'Simple question?',
        options: [{ text: 'Yes', value: 'yes' }],
        chatId: 'oc_test',
      });

      const [[callArgs]] = mockSendInteractiveMessage.mock.calls;
      const prompt = callArgs.actionPrompts['yes'];

      expect(prompt).toContain('[用户操作]');
      expect(prompt).toContain('Yes');
      // Should not throw when context/action are missing
    });
  });
});
