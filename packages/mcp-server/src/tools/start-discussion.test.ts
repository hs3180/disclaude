/**
 * Tests for start_discussion tool with SOUL.md integration.
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 * Issue #1228: 讨论焦点保持 - 基于 SOUL.md 系统的讨论人格定义
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
  SoulLoader: vi.fn(),
  resolveSoulPath: vi.fn(),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type, original, fallback) => fallback || `Error: ${original || type || 'unknown'}`),
}));

vi.mock('./interactive-message.js', () => ({
  send_interactive_message: vi.fn(),
}));

import { start_discussion } from './start-discussion.js';
import { isIpcAvailable } from './ipc-utils.js';
import { send_interactive_message } from './interactive-message.js';
import { getIpcClient, resolveSoulPath } from '@disclaude/core';
import { SoulLoader } from '@disclaude/core';

const mockIsIpcAvailable = isIpcAvailable as ReturnType<typeof vi.fn>;
const mockSendInteractive = send_interactive_message as ReturnType<typeof vi.fn>;
const mockGetIpcClient = getIpcClient as ReturnType<typeof vi.fn>;
const mockResolveSoulPath = resolveSoulPath as ReturnType<typeof vi.fn>;

describe('start_discussion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsIpcAvailable.mockResolvedValue(true);
    // Default: soul not found (graceful degradation)
    mockResolveSoulPath.mockReturnValue(null);
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
      expect(result.error).toContain('context');
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
        topic: 'Test Topic',
        chatId: 'oc_group',
      });

      expect(result.success).toBe(true);

      // Verify card header contains topic
      const callArgs = mockSendInteractive.mock.calls[0][0];
      const card = callArgs.card as Record<string, unknown>;
      const header = card.header as Record<string, unknown>;
      const title = (header.title as Record<string, unknown>).content;
      expect(title).toBe('💬 Test Topic');
    });

    it('should use default header when no topic provided', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_789',
      });

      await start_discussion({
        context: 'Some discussion',
        chatId: 'oc_group',
      });

      const callArgs = mockSendInteractive.mock.calls[0][0];
      const card = callArgs.card as Record<string, unknown>;
      const header = card.header as Record<string, unknown>;
      const title = (header.title as Record<string, unknown>).content;
      expect(title).toBe('💬 讨论话题');
    });
  });

  describe('creating new group', () => {
    it('should create group and send card when no chatId provided', async () => {
      mockGetIpcClient.mockReturnValue({
        feishuCreateGroup: vi.fn().mockResolvedValue({
          success: true,
          chatId: 'oc_new_group',
          name: 'Test Discussion',
        }),
      });
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_new',
      });

      const result = await start_discussion({
        context: 'New discussion content',
        topic: 'Test Discussion',
        members: ['ou_user1'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_group');
      expect(mockSendInteractive).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_new_group',
        })
      );
    });

    it('should return error when group creation fails', async () => {
      mockGetIpcClient.mockReturnValue({
        feishuCreateGroup: vi.fn().mockResolvedValue({
          success: false,
          error: 'Permission denied',
          errorType: 'ipc_request_failed',
        }),
      });

      const result = await start_discussion({
        context: 'Discussion content',
        topic: 'Test',
        members: ['ou_user1'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('创建讨论群失败');
    });
  });

  describe('soul integration (Issue #1228)', () => {
    it('should report soulLoaded=false when soul file not found', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_soul1',
      });
      mockResolveSoulPath.mockReturnValue(null);

      const result = await start_discussion({
        context: 'Test discussion',
        chatId: 'oc_group',
      });

      expect(result.success).toBe(true);
      expect(result.soulLoaded).toBe(false);
    });

    it('should report soulLoaded=false when soul loading fails gracefully', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_soul2',
      });
      // resolveSoulPath returns a path but SoulLoader.load() fails
      mockResolveSoulPath.mockReturnValue('/fake/path/souls/discussion.md');

      const result = await start_discussion({
        context: 'Test discussion',
        chatId: 'oc_group',
      });

      expect(result.success).toBe(true);
      expect(result.soulLoaded).toBe(false);
    });

    it('should include soul content in card when soul is loaded', async () => {
      const soulContent = '# Discussion SOUL\nStay on topic.';
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_soul3',
      });

      // Mock SoulLoader to return loaded content
      mockResolveSoulPath.mockReturnValue('/fake/path/souls/discussion.md');
      const MockSoulLoader = SoulLoader as ReturnType<typeof vi.fn>;
      MockSoulLoader.mockImplementation(() => ({
        load: vi.fn().mockResolvedValue({
          loaded: true,
          path: '/fake/path/souls/discussion.md',
          content: soulContent,
        }),
      }));

      const result = await start_discussion({
        context: 'Discussion context',
        chatId: 'oc_group',
      });

      expect(result.success).toBe(true);
      expect(result.soulLoaded).toBe(true);

      // Verify card contains soul content
      const callArgs = mockSendInteractive.mock.calls[0][0];
      const card = callArgs.card as Record<string, unknown>;
      const elements = card.elements as Array<Record<string, unknown>>;
      const firstElement = elements[0];
      expect(firstElement.tag).toBe('markdown');
      const markdownContent = firstElement.content as string;
      expect(markdownContent).toContain('讨论规则');
      expect(markdownContent).toContain(soulContent);
    });

    it('should include hr between soul guidelines and context', async () => {
      const soulContent = '# Discussion SOUL\nStay on topic.';
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_soul4',
      });

      mockResolveSoulPath.mockReturnValue('/fake/path/souls/discussion.md');
      const MockSoulLoader = SoulLoader as ReturnType<typeof vi.fn>;
      MockSoulLoader.mockImplementation(() => ({
        load: vi.fn().mockResolvedValue({
          loaded: true,
          path: '/fake/path/souls/discussion.md',
          content: soulContent,
        }),
      }));

      await start_discussion({
        context: 'Main discussion content',
        chatId: 'oc_group',
      });

      const callArgs = mockSendInteractive.mock.calls[0][0];
      const card = callArgs.card as Record<string, unknown>;
      const elements = card.elements as Array<Record<string, unknown>>;

      // Elements: [soul markdown, hr, context markdown]
      expect(elements.length).toBeGreaterThanOrEqual(3);
      expect(elements[0].tag).toBe('markdown');
      expect(elements[1].tag).toBe('hr');
      expect(elements[2].tag).toBe('markdown');
      expect((elements[2].content as string)).toBe('Main discussion content');
    });

    it('should accept custom soul name', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_custom_soul',
      });
      mockResolveSoulPath.mockReturnValue('/fake/path/souls/custom-soul.md');

      const MockSoulLoader = SoulLoader as ReturnType<typeof vi.fn>;
      MockSoulLoader.mockImplementation(() => ({
        load: vi.fn().mockResolvedValue({
          loaded: true,
          path: '/fake/path/souls/custom-soul.md',
          content: '# Custom Soul\nCustom behavior.',
        }),
      }));

      const result = await start_discussion({
        context: 'Discussion',
        chatId: 'oc_group',
        soul: 'custom-soul',
      });

      expect(result.soulLoaded).toBe(true);
      expect(mockResolveSoulPath).toHaveBeenCalledWith('custom-soul');
    });

    it('should not block discussion when soul loading throws', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_err',
      });
      // resolveSoulPath throws an error
      mockResolveSoulPath.mockImplementation(() => {
        throw new Error('Soul resolution failed');
      });

      const result = await start_discussion({
        context: 'Discussion despite soul error',
        chatId: 'oc_group',
      });

      // Discussion should still succeed
      expect(result.success).toBe(true);
      expect(result.soulLoaded).toBe(false);
    });
  });

  describe('action buttons', () => {
    it('should include action buttons when options provided', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_opts',
      });

      await start_discussion({
        context: 'Choose an option',
        chatId: 'oc_group',
        options: [
          { text: 'Yes', value: 'yes', action: 'Do something' },
          { text: 'No', value: 'no' },
        ],
      });

      const callArgs = mockSendInteractive.mock.calls[0][0];
      const actionPrompts = callArgs.actionPrompts as Record<string, string>;

      expect(actionPrompts).toHaveProperty('yes');
      expect(actionPrompts).toHaveProperty('no');
      expect(actionPrompts.yes).toContain('Yes');
      expect(actionPrompts.yes).toContain('Do something');
      expect(actionPrompts.no).toContain('No');
    });

    it('should not include action buttons when no options', async () => {
      mockSendInteractive.mockResolvedValue({
        success: true,
        message: 'Card sent',
        messageId: 'msg_no_opts',
      });

      await start_discussion({
        context: 'Simple discussion',
        chatId: 'oc_group',
      });

      const callArgs = mockSendInteractive.mock.calls[0][0];
      const actionPrompts = callArgs.actionPrompts as Record<string, string>;
      expect(Object.keys(actionPrompts)).toHaveLength(0);
    });
  });
});
