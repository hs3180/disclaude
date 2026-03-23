/**
 * Tests for start_discussion tool implementation.
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type, original, fallback) => fallback || `Error: ${original || type || 'unknown'}`),
}));

vi.mock('./interactive-message.js', () => ({
  send_interactive_message: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(() => ({ appId: 'test-app-id', appSecret: 'test-secret' })),
}));

import { start_discussion } from './start-discussion.js';
import { isIpcAvailable } from './ipc-utils.js';
import { send_interactive_message } from './interactive-message.js';
import { getIpcClient } from '@disclaude/core';

const mockIsIpcAvailable = isIpcAvailable as ReturnType<typeof vi.fn>;
const mockSendInteractive = send_interactive_message as ReturnType<typeof vi.fn>;
const mockGetIpcClient = getIpcClient as ReturnType<typeof vi.fn>;

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsIpcAvailable.mockResolvedValue(true);
  });

  describe('validation', () => {
    it('should return error when context is empty', async () => {
      const result = await start_discussion({ context: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('context');
    });

    it('should return error when context is not provided', async () => {
      const result = await start_discussion({ context: undefined as unknown as string });
      expect(result.success).toBe(false);
    });

    it('should return error when IPC is unavailable', async () => {
      mockIsIpcAvailable.mockResolvedValue(false);
      const result = await start_discussion({ context: 'test discussion' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC');
    });
  });

  describe('using existing chatId', () => {
    it('should send discussion card to existing group', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_123',
      });

      const result = await start_discussion({
        context: 'Should we automate code formatting?',
        topic: 'Code Formatting Discussion',
        chatId: 'oc_existing_group',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_existing_group');
      expect(result.messageId).toBe('msg_123');

      // Should have called send_interactive_message with the existing chatId
      expect(mockSendInteractive).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_existing_group',
        })
      );
    });

    it('should include topic in card header', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_456',
      });

      const result = await start_discussion({
        context: 'Discussion content here',
        topic: 'My Topic',
        chatId: 'oc_group',
      });

      expect(result.success).toBe(true);
      const callArgs = mockSendInteractive.mock.calls[0][0];
      const card = callArgs.card as Record<string, unknown>;
      const header = card.header as Record<string, unknown>;
      const title = header.title as Record<string, unknown>;
      expect(title.content).toContain('My Topic');
    });

    it('should handle send failure', async () => {
      mockSendInteractive.mockResolvedValue({
        success: false,
        error: 'Card validation failed',
        message: '❌ Card validation failed',
      });

      const result = await start_discussion({
        context: 'Test content',
        chatId: 'oc_group',
      });

      expect(result.success).toBe(false);
      expect(result.chatId).toBe('oc_group');
    });
  });

  describe('creating new group', () => {
    it('should create group and send discussion', async () => {
      const mockFeishuCreateGroup = vi.fn().mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Discussion Topic',
      });
      mockGetIpcClient.mockReturnValue({
        feishuCreateGroup: mockFeishuCreateGroup,
      });
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_789',
      });

      const result = await start_discussion({
        context: 'Discussion about architecture',
        topic: 'Architecture Discussion',
        members: ['ou_user1', 'ou_user2'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_group');
      expect(mockFeishuCreateGroup).toHaveBeenCalledWith('Architecture Discussion', ['ou_user1', 'ou_user2']);

      // Should have sent card to the new group
      expect(mockSendInteractive).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_new_group',
        })
      );
    });

    it('should handle group creation failure', async () => {
      const mockFeishuCreateGroup = vi.fn().mockResolvedValue({
        success: false,
        error: 'Permission denied',
        errorType: 'ipc_request_failed',
      });
      mockGetIpcClient.mockReturnValue({
        feishuCreateGroup: mockFeishuCreateGroup,
      });

      const result = await start_discussion({
        context: 'Test content',
        topic: 'Test Topic',
        members: ['ou_user1'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should create group without members', async () => {
      const mockFeishuCreateGroup = vi.fn().mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Auto Topic',
      });
      mockGetIpcClient.mockReturnValue({
        feishuCreateGroup: mockFeishuCreateGroup,
      });
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_no_members',
      });

      const result = await start_discussion({
        context: 'Open discussion',
        topic: 'Auto Topic',
      });

      expect(result.success).toBe(true);
      expect(mockFeishuCreateGroup).toHaveBeenCalledWith('Auto Topic', undefined);
    });
  });

  describe('with options', () => {
    it('should include action buttons when options provided', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_with_options',
      });

      await start_discussion({
        context: 'Should we proceed?',
        chatId: 'oc_group',
        options: [
          { text: 'Yes', value: 'yes', action: 'Proceed with the plan' },
          { text: 'No', value: 'no', style: 'danger' },
          { text: 'Need more info', value: 'more' },
        ],
      });

      const callArgs = mockSendInteractive.mock.calls[0][0];
      const actionPrompts = callArgs.actionPrompts as Record<string, string>;

      // Should have action prompts for each option
      expect(actionPrompts.yes).toContain('Yes');
      expect(actionPrompts.yes).toContain('Proceed with the plan');
      expect(actionPrompts.no).toContain('No');
      expect(actionPrompts.more).toContain('Need more info');
    });

    it('should not include action buttons when no options', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_no_options',
      });

      await start_discussion({
        context: 'Just informing',
        chatId: 'oc_group',
      });

      const callArgs = mockSendInteractive.mock.calls[0][0];
      expect(Object.keys(callArgs.actionPrompts)).toHaveLength(0);
    });
  });

  describe('card structure', () => {
    it('should produce valid card structure', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_card',
      });

      await start_discussion({
        context: 'Test **markdown** content',
        topic: 'Test',
        chatId: 'oc_group',
      });

      const callArgs = mockSendInteractive.mock.calls[0][0];
      const card = callArgs.card as Record<string, unknown>;

      // Card should have config, header, and elements
      expect(card.config).toBeDefined();
      expect(card.header).toBeDefined();
      expect(card.elements).toBeDefined();

      // Header should have title with tag: plain_text
      const header = card.header as Record<string, unknown>;
      expect(header.template).toBe('blue');

      // Elements should have at least a markdown element
      const elements = card.elements as Array<Record<string, unknown>>;
      expect(elements[0].tag).toBe('markdown');
    });
  });
});
