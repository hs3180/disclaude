/**
 * Tests for Feishu Context MCP Tools
 *
 * Tests the following functionality:
 * - isValidFeishuCard: Card structure validation (via behavior testing)
 * - getCardValidationError: Detailed validation error messages (via behavior testing)
 * - send_user_feedback: Message sending to Feishu
 * - send_file_to_feishu: File sending to Feishu
 * - update_card: Update existing card message
 * - wait_for_interaction: Wait for user card interaction
 * - resolvePendingInteraction: Resolve pending interaction
 * - setMessageSentCallback: Callback management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises before importing - must define mock inside vi.mock
vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

// Mock the lark SDK
const mockClient = {
  im: {
    message: {
      create: vi.fn(),
      reply: vi.fn(),
      patch: vi.fn(),
    },
  },
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => mockClient),
  Domain: {
    Feishu: 'https://open.feishu.cn',
  },
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock feishu-uploader
vi.mock('../file-transfer/outbound/feishu-uploader.js', () => ({
  uploadAndSendFile: vi.fn(),
}));

// Import after mocks
import * as fs from 'fs/promises';
import type * as fsStats from 'fs';
import {
  send_user_feedback,
  send_file_to_feishu,
  update_card,
  wait_for_interaction,
  resolvePendingInteraction,
  setMessageSentCallback,
  feishuContextTools,
} from './feishu-context-mcp.js';
import { uploadAndSendFile } from '../file-transfer/outbound/feishu-uploader.js';

describe('Feishu Context MCP Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset console.log mock
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Tool Definitions', () => {
    it('should have send_user_feedback tool definition', () => {
      expect(feishuContextTools.send_user_feedback).toBeDefined();
      expect(feishuContextTools.send_user_feedback.description).toContain('Send a message to a Feishu chat');
      expect(feishuContextTools.send_user_feedback.handler).toBe(send_user_feedback);
    });

    it('should have send_file_to_feishu tool definition', () => {
      expect(feishuContextTools.send_file_to_feishu).toBeDefined();
      expect(feishuContextTools.send_file_to_feishu.description).toContain('Send a file to a Feishu chat');
      expect(feishuContextTools.send_file_to_feishu.handler).toBe(send_file_to_feishu);
    });
  });

  describe('setMessageSentCallback', () => {
    it('should set and call callback on successful message send (CLI mode)', async () => {
      const mockCallback = vi.fn();
      setMessageSentCallback(mockCallback);

      const result = await send_user_feedback({
        content: 'Hello',
        format: 'text',
        chatId: 'cli-test-chat',
      });

      expect(result.success).toBe(true);
      expect(mockCallback).toHaveBeenCalledWith('cli-test-chat');
    });

    it('should handle null callback gracefully', async () => {
      setMessageSentCallback(null);

      const result = await send_user_feedback({
        content: 'Hello',
        format: 'text',
        chatId: 'cli-test-chat',
      });

      expect(result.success).toBe(true);
    });

    it('should handle callback that throws error', async () => {
      const mockCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      setMessageSentCallback(mockCallback);

      const result = await send_user_feedback({
        content: 'Hello',
        format: 'text',
        chatId: 'cli-test-chat',
      });

      // Should still succeed even if callback throws
      expect(result.success).toBe(true);
    });
  });

  describe('send_user_feedback', () => {
    describe('CLI Mode', () => {
      it('should handle CLI mode (chatId starts with "cli-")', async () => {
        const result = await send_user_feedback({
          content: 'Test message',
          format: 'text',
          chatId: 'cli-test',
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain('CLI mode');
      });

      it('should display content in CLI mode', async () => {
        const result = await send_user_feedback({
          content: 'Test content',
          format: 'text',
          chatId: 'cli-test',
        });

        expect(result.success).toBe(true);
      });
    });

    describe('Feishu API Mode', () => {
      it('should send text message successfully', async () => {
        mockClient.im.message.create.mockResolvedValueOnce({});

        const result = await send_user_feedback({
          content: 'Hello Feishu',
          format: 'text',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(true);
        expect(result.message).toContain('Feedback sent');
        expect(mockClient.im.message.create).toHaveBeenCalledWith(
          expect.objectContaining({
            params: { receive_id_type: 'chat_id' },
            data: expect.objectContaining({
              receive_id: 'chat-123',
              msg_type: 'text',
            }),
          })
        );
      });

      it('should return messageId from API response (Issue #525)', async () => {
        mockClient.im.message.create.mockResolvedValueOnce({
          data: { message_id: 'om_test_message_id' },
        });

        const result = await send_user_feedback({
          content: 'Hello Feishu',
          format: 'text',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(true);
        expect(result.messageId).toBe('om_test_message_id');
      });

      it('should return messageId for card messages (Issue #525)', async () => {
        mockClient.im.message.create.mockResolvedValueOnce({
          data: { message_id: 'om_card_message_id' },
        });

        const cardContent = {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: 'Test Card' },
            template: 'blue',
          },
          elements: [{ tag: 'markdown', content: '**Hello**' }],
        };

        const result = await send_user_feedback({
          content: cardContent,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(true);
        expect(result.messageId).toBe('om_card_message_id');
      });

      it('should return messageId for thread replies (Issue #525)', async () => {
        mockClient.im.message.reply.mockResolvedValueOnce({
          data: { message_id: 'om_reply_message_id' },
        });

        const result = await send_user_feedback({
          content: 'Thread reply',
          format: 'text',
          chatId: 'chat-123',
          parentMessageId: 'msg-456',
        });

        expect(result.success).toBe(true);
        expect(result.messageId).toBe('om_reply_message_id');
      });

      it('should send text message with thread reply', async () => {
        mockClient.im.message.reply.mockResolvedValueOnce({});

        const result = await send_user_feedback({
          content: 'Thread reply',
          format: 'text',
          chatId: 'chat-123',
          parentMessageId: 'msg-456',
        });

        expect(result.success).toBe(true);
        expect(mockClient.im.message.reply).toHaveBeenCalledWith(
          expect.objectContaining({
            path: { message_id: 'msg-456' },
          })
        );
      });

      it('should send valid card object', async () => {
        mockClient.im.message.create.mockResolvedValueOnce({});

        const cardContent = {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: 'Test Card' },
            template: 'blue',
          },
          elements: [{ tag: 'markdown', content: '**Hello**' }],
        };

        const result = await send_user_feedback({
          content: cardContent,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(true);
        expect(mockClient.im.message.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              msg_type: 'interactive',
            }),
          })
        );
      });

      it('should send valid card JSON string', async () => {
        mockClient.im.message.create.mockResolvedValueOnce({});

        const cardContent = JSON.stringify({
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: 'Test Card' },
            template: 'blue',
          },
          elements: [{ tag: 'markdown', content: '**Hello**' }],
        });

        const result = await send_user_feedback({
          content: cardContent,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(true);
      });
    });

    describe('Card Validation (via JSON string)', () => {
      it('should reject card JSON string missing config', async () => {
        const invalidCard = JSON.stringify({
          header: { title: { tag: 'plain_text', content: 'Test' } },
          elements: [],
        });

        const result = await send_user_feedback({
          content: invalidCard,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('missing required fields');
      });

      it('should reject card JSON string missing header', async () => {
        const invalidCard = JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [],
        });

        const result = await send_user_feedback({
          content: invalidCard,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('missing required fields');
      });

      it('should reject card JSON string missing elements', async () => {
        const invalidCard = JSON.stringify({
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: 'Test' } },
        });

        const result = await send_user_feedback({
          content: invalidCard,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('missing required fields');
      });

      it('should reject card JSON string missing header.title', async () => {
        const invalidCard = JSON.stringify({
          config: { wide_screen_mode: true },
          header: { template: 'blue' },
          elements: [],
        });

        const result = await send_user_feedback({
          content: invalidCard,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('header.title is missing');
      });

      it('should reject card with invalid JSON string', async () => {
        const result = await send_user_feedback({
          content: 'not valid json',
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid JSON');
      });

      it('should reject card JSON string that is an array', async () => {
        const invalidCard = JSON.stringify([
          { config: {} },
          { header: {} },
          { elements: [] },
        ]);

        const result = await send_user_feedback({
          content: invalidCard,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('array');
      });
    });

    describe('Card Validation (via object - invalid type path)', () => {
      it('should reject invalid card object (does not pass isValidFeishuCard)', async () => {
        const invalidCard = {
          config: { wide_screen_mode: true },
          // missing header and elements
        };

        const result = await send_user_feedback({
          content: invalidCard,
          format: 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        // Invalid objects fall through to "Invalid content type" path
        expect(result.error).toContain('Invalid content type');
      });
    });

    describe('Input Validation', () => {
      it('should require content (empty string)', async () => {
        const result = await send_user_feedback({
          content: '',
          format: 'text',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('content is required');
      });

      it('should require format', async () => {
        const result = await send_user_feedback({
          content: 'Hello',
          format: '' as 'text' | 'card',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('format is required');
      });

      it('should require chatId', async () => {
        const result = await send_user_feedback({
          content: 'Hello',
          format: 'text',
          chatId: '',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('chatId is required');
      });
    });

    describe('Error Handling', () => {
      it('should handle Feishu API errors', async () => {
        mockClient.im.message.create.mockRejectedValueOnce(new Error('API Error'));

        const result = await send_user_feedback({
          content: 'Hello',
          format: 'text',
          chatId: 'chat-123',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('API Error');
      });
    });
  });

  describe('send_file_to_feishu', () => {
    it('should require chatId', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as fsStats.Stats);

      const result = await send_file_to_feishu({
        filePath: '/test/file.txt',
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });

    it('should resolve relative file path to workspace directory', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as fsStats.Stats);
      vi.mocked(uploadAndSendFile).mockResolvedValueOnce(1024);

      const result = await send_file_to_feishu({
        filePath: 'relative/path/file.txt',
        chatId: 'chat-123',
      });

      expect(result.success).toBe(true);
      expect(uploadAndSendFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('/test/workspace/relative/path/file.txt'),
        'chat-123'
      );
    });

    it('should use absolute file path as-is', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as fsStats.Stats);
      vi.mocked(uploadAndSendFile).mockResolvedValueOnce(1024);

      const result = await send_file_to_feishu({
        filePath: '/absolute/path/file.txt',
        chatId: 'chat-123',
      });

      expect(result.success).toBe(true);
      expect(uploadAndSendFile).toHaveBeenCalledWith(
        expect.anything(),
        '/absolute/path/file.txt',
        'chat-123'
      );
    });

    it('should return file details on success', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as fsStats.Stats);
      vi.mocked(uploadAndSendFile).mockResolvedValueOnce(2048);

      const result = await send_file_to_feishu({
        filePath: '/test/document.pdf',
        chatId: 'chat-123',
      });

      expect(result.success).toBe(true);
      expect(result.fileName).toBe('document.pdf');
      expect(result.fileSize).toBe(2048);
      expect(result.sizeMB).toBe('0.00');
    });

    it('should handle file not found error', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await send_file_to_feishu({
        filePath: '/nonexistent/file.txt',
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('should handle directory path error', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false, size: 0 } as fsStats.Stats);

      const result = await send_file_to_feishu({
        filePath: '/some/directory',
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should handle upload errors', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as fsStats.Stats);
      vi.mocked(uploadAndSendFile).mockRejectedValueOnce(new Error('Upload failed'));

      const result = await send_file_to_feishu({
        filePath: '/test/file.txt',
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Upload failed');
    });

    it('should extract Feishu API error details', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 } as fsStats.Stats);

      const apiError = new Error('API Error') as Error & {
        response: { data: Array<{ code: number; msg: string; log_id: string }> };
      };
      apiError.response = {
        data: [{
          code: 99991663,
          msg: 'permission denied',
          log_id: 'log-123',
        }],
      };

      vi.mocked(uploadAndSendFile).mockRejectedValueOnce(apiError);

      const result = await send_file_to_feishu({
        filePath: '/test/file.txt',
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.feishuCode).toBe(99991663);
      expect(result.feishuMsg).toBe('permission denied');
      expect(result.feishuLogId).toBe('log-123');
    });
  });

  describe('update_card', () => {
    it('should have update_card tool definition', () => {
      expect(feishuContextTools.update_card).toBeDefined();
      expect(feishuContextTools.update_card.description).toContain('Update an existing interactive card');
      expect(feishuContextTools.update_card.handler).toBe(update_card);
    });

    it('should require messageId', async () => {
      const result = await update_card({
        messageId: '',
        card: { config: {}, header: {}, elements: [] },
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('messageId is required');
    });

    it('should require card', async () => {
      const result = await update_card({
        messageId: 'msg-123',
        card: null as unknown as Record<string, unknown>,
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('card is required');
    });

    it('should require chatId', async () => {
      const result = await update_card({
        messageId: 'msg-123',
        card: { config: {}, header: {}, elements: [] },
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });

    it('should validate card structure', async () => {
      const result = await update_card({
        messageId: 'msg-123',
        card: { invalid: 'structure' },
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid card structure');
    });

    it('should update card in CLI mode', async () => {
      const result = await update_card({
        messageId: 'msg-123',
        card: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: 'Updated Card' },
            template: 'blue',
          },
          elements: [{ tag: 'markdown', content: '**Updated**' }],
        },
        chatId: 'cli-test',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('CLI mode');
    });

    it('should call Feishu API patch endpoint', async () => {
      mockClient.im.message.patch.mockResolvedValueOnce({});

      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: 'Updated Card' },
          template: 'blue',
        },
        elements: [{ tag: 'markdown', content: '**Updated**' }],
      };

      const result = await update_card({
        messageId: 'msg-123',
        card,
        chatId: 'chat-123',
      });

      expect(result.success).toBe(true);
      expect(mockClient.im.message.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg-123' },
        })
      );
    });

    it('should handle API errors', async () => {
      mockClient.im.message.patch.mockRejectedValueOnce(new Error('Patch failed'));

      const result = await update_card({
        messageId: 'msg-123',
        card: {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: 'Test' }, template: 'blue' },
          elements: [],
        },
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Patch failed');
    });
  });

  describe('wait_for_interaction', () => {
    it('should have wait_for_interaction tool definition', () => {
      expect(feishuContextTools.wait_for_interaction).toBeDefined();
      expect(feishuContextTools.wait_for_interaction.description).toContain('Wait for the user to interact');
      expect(feishuContextTools.wait_for_interaction.handler).toBe(wait_for_interaction);
    });

    it('should require messageId', async () => {
      const result = await wait_for_interaction({
        messageId: '',
        chatId: 'chat-123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('messageId is required');
    });

    it('should require chatId', async () => {
      const result = await wait_for_interaction({
        messageId: 'msg-123',
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });

    it('should simulate interaction in CLI mode', async () => {
      const result = await wait_for_interaction({
        messageId: 'msg-123',
        chatId: 'cli-test',
      });

      expect(result.success).toBe(true);
      expect(result.actionValue).toBe('simulated');
      expect(result.actionType).toBe('button');
    });

    it('should resolve when interaction is received', async () => {
      // Start waiting for interaction
      const waitPromise = wait_for_interaction({
        messageId: 'msg-456',
        chatId: 'chat-123',
        timeoutSeconds: 5,
      });

      // Simulate interaction being received
      setTimeout(() => {
        resolvePendingInteraction('msg-456', 'confirm', 'button', 'user-789');
      }, 50);

      const result = await waitPromise;

      expect(result.success).toBe(true);
      expect(result.actionValue).toBe('confirm');
      expect(result.actionType).toBe('button');
      expect(result.userId).toBe('user-789');
    });

    it('should timeout if no interaction received', async () => {
      const result = await wait_for_interaction({
        messageId: 'msg-timeout',
        chatId: 'chat-123',
        timeoutSeconds: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should reject duplicate wait for same message', async () => {
      // Start first wait
      const firstWait = wait_for_interaction({
        messageId: 'msg-dup',
        chatId: 'chat-123',
        timeoutSeconds: 5,
      });

      // Try to wait again for same message
      const secondResult = await wait_for_interaction({
        messageId: 'msg-dup',
        chatId: 'chat-123',
        timeoutSeconds: 1,
      });

      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toContain('Already waiting');

      // Clean up first wait
      resolvePendingInteraction('msg-dup', 'cancel', 'button', 'user-1');
      await firstWait;
    });
  });
});
