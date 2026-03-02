/**
 * Tests for ChannelMessageService.
 *
 * @see Issue #445
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelMessageService, type ChannelMessageServiceConfig } from './channel-message-service.js';
import type { ChannelManager } from '../nodes/channel-manager.js';
import type { IChannel } from '../channels/types.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock console.log
vi.spyOn(console, 'log').mockImplementation(() => {});

/**
 * Create a mock channel for testing.
 */
function createMockChannel(id: string, name: string): IChannel {
  return {
    id,
    name,
    status: 'running',
    onMessage: vi.fn(),
    onControl: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

/**
 * Create a mock ChannelManager for testing.
 */
function createMockChannelManager(channels: IChannel[] = []): ChannelManager {
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]));

  return {
    register: vi.fn(),
    setupHandlers: vi.fn(),
    get: vi.fn((id: string) => channelMap.get(id)),
    getAll: vi.fn(() => channels),
    getIds: vi.fn(() => Array.from(channelMap.keys())),
    has: vi.fn((id: string) => channelMap.has(id)),
    size: vi.fn(() => channelMap.size),
    broadcast: vi.fn().mockResolvedValue(undefined),
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    getStatusInfo: vi.fn(),
    clear: vi.fn(),
  } as unknown as ChannelManager;
}

describe('ChannelMessageService', () => {
  let mockChannelManager: ChannelManager;
  let mockFeishuChannel: IChannel;
  let mockRestChannel: IChannel;
  let onMessageSent: ReturnType<typeof vi.fn>;
  let service: ChannelMessageService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFeishuChannel = createMockChannel('feishu', 'Feishu');
    mockRestChannel = createMockChannel('rest', 'REST');
    mockChannelManager = createMockChannelManager([mockFeishuChannel, mockRestChannel]);
    onMessageSent = vi.fn();

    const config: ChannelMessageServiceConfig = {
      channelManager: mockChannelManager,
      onMessageSent,
    };

    service = new ChannelMessageService(config);
  });

  describe('sendMessage', () => {
    describe('validation', () => {
      it('should return error when content is missing', async () => {
        const result = await service.sendMessage('', '', 'text');
        expect(result.success).toBe(false);
        expect(result.error).toBe('content_required');
      });

      it('should return error when format is missing', async () => {
        const result = await service.sendMessage('oc_test', 'content', '' as 'text');
        expect(result.success).toBe(false);
        expect(result.error).toBe('format_required');
      });

      it('should return error when chatId is missing', async () => {
        const result = await service.sendMessage('', 'content', 'text');
        expect(result.success).toBe(false);
        expect(result.error).toBe('chatid_required');
      });
    });

    describe('CLI mode', () => {
      it('should handle cli-* chatId with text format', async () => {
        const result = await service.sendMessage('cli-test', 'Hello CLI', 'text');

        expect(result.success).toBe(true);
        expect(result.message).toContain('CLI mode');
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Hello CLI'));
        expect(onMessageSent).toHaveBeenCalledWith('cli-test');
      });

      it('should handle cli-* chatId with card format', async () => {
        const card = { config: {}, header: { title: 'Test' }, elements: [] };
        const result = await service.sendMessage('cli-test', card, 'card');

        expect(result.success).toBe(true);
        expect(result.message).toContain('CLI mode');
        expect(console.log).toHaveBeenCalled();
        expect(onMessageSent).toHaveBeenCalledWith('cli-test');
      });
    });

    describe('Feishu channel routing', () => {
      it('should route oc_* chatId to Feishu channel', async () => {
        const result = await service.sendMessage('oc_group123', 'Hello group', 'text');

        expect(result.success).toBe(true);
        expect(mockFeishuChannel.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'oc_group123',
            type: 'text',
            text: 'Hello group',
          })
        );
        expect(mockRestChannel.sendMessage).not.toHaveBeenCalled();
        expect(onMessageSent).toHaveBeenCalledWith('oc_group123');
      });

      it('should route ou_* chatId to Feishu channel', async () => {
        const result = await service.sendMessage('ou_user123', 'Hello user', 'text');

        expect(result.success).toBe(true);
        expect(mockFeishuChannel.sendMessage).toHaveBeenCalled();
      });

      it('should route on_* chatId to Feishu channel', async () => {
        const result = await service.sendMessage('on_bot123', 'Hello bot', 'text');

        expect(result.success).toBe(true);
        expect(mockFeishuChannel.sendMessage).toHaveBeenCalled();
      });

      it('should send card message to Feishu channel', async () => {
        const card = { config: {}, header: { title: 'Test' }, elements: [] };
        const result = await service.sendMessage('oc_group123', card, 'card');

        expect(result.success).toBe(true);
        expect(mockFeishuChannel.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'oc_group123',
            type: 'card',
            card,
          })
        );
      });

      it('should include parentMessageId as threadId', async () => {
        const result = await service.sendMessage('oc_group123', 'Reply', 'text', 'msg_parent');

        expect(result.success).toBe(true);
        expect(mockFeishuChannel.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: 'msg_parent',
          })
        );
      });
    });

    describe('REST channel routing', () => {
      it('should route UUID chatId to REST channel', async () => {
        const uuidChatId = '123e4567-e89b-12d3-a456-426614174000';
        const result = await service.sendMessage(uuidChatId, 'Hello REST', 'text');

        expect(result.success).toBe(true);
        expect(mockRestChannel.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: uuidChatId,
            type: 'text',
            text: 'Hello REST',
          })
        );
        expect(mockFeishuChannel.sendMessage).not.toHaveBeenCalled();
      });
    });

    describe('broadcast mode', () => {
      it('should broadcast to all channels for unknown chatId format', async () => {
        const result = await service.sendMessage('unknown-format', 'Hello', 'text');

        expect(result.success).toBe(true);
        expect(mockChannelManager.broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'unknown-format',
            type: 'text',
            text: 'Hello',
          })
        );
      });
    });

    describe('error handling', () => {
      it('should return error when channel fails to send', async () => {
        (mockFeishuChannel.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('API error')
        );

        const result = await service.sendMessage('oc_group123', 'Hello', 'text');

        expect(result.success).toBe(false);
        expect(result.error).toBe('API error');
        expect(onMessageSent).not.toHaveBeenCalled();
      });
    });
  });

  describe('sendFile', () => {
    it('should validate required parameters', async () => {
      const result = await service.sendFile('', '');
      expect(result.success).toBe(false);
      // filePath is checked first in the implementation
      expect(result.error).toBe('filepath_required');
    });

    it('should validate filePath', async () => {
      const result = await service.sendFile('oc_test', '');
      expect(result.success).toBe(false);
      expect(result.error).toBe('filepath_required');
    });

    it('should handle CLI mode', async () => {
      const result = await service.sendFile('cli-test', '/path/to/file.txt');

      expect(result.success).toBe(true);
      expect(result.message).toContain('CLI mode');
    });

    it('should send file to correct channel', async () => {
      const result = await service.sendFile('oc_group123', '/path/to/file.txt');

      expect(result.success).toBe(true);
      expect(mockFeishuChannel.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_group123',
          type: 'file',
          filePath: '/path/to/file.txt',
        })
      );
    });
  });

  describe('updateCard', () => {
    it('should validate required parameters', async () => {
      const result = await service.updateCard('', '', {});
      expect(result.success).toBe(false);
      // messageId is checked first in the implementation
      expect(result.error).toBe('messageid_required');
    });

    it('should validate messageId', async () => {
      const result = await service.updateCard('oc_test', '', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('messageid_required');
    });

    it('should validate card', async () => {
      const result = await service.updateCard('oc_test', 'msg_123', null as unknown as Record<string, unknown>);
      expect(result.success).toBe(false);
      expect(result.error).toBe('card_required');
    });

    it('should handle CLI mode', async () => {
      const result = await service.updateCard('cli-test', 'msg_123', { config: {} });

      expect(result.success).toBe(true);
      expect(result.message).toContain('CLI mode');
    });
  });

  describe('channel detection', () => {
    it('should correctly identify Feishu group chat IDs', async () => {
      await service.sendMessage('oc_d1e2f3g4h5i6', 'test', 'text');
      expect(mockFeishuChannel.sendMessage).toHaveBeenCalled();
    });

    it('should correctly identify Feishu user chat IDs', async () => {
      await service.sendMessage('ou_a1b2c3d4e5f6', 'test', 'text');
      expect(mockFeishuChannel.sendMessage).toHaveBeenCalled();
    });

    it('should correctly identify UUID chat IDs', async () => {
      await service.sendMessage('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'test', 'text');
      expect(mockRestChannel.sendMessage).toHaveBeenCalled();
    });
  });
});
