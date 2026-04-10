/**
 * Tests for FeishuChannel message sending, especially thread reply support.
 *
 * Issue #1619: send_interactive 交互卡片忽略 threadId
 *
 * Tests cover:
 * - Thread reply via client.im.message.reply when threadId is provided
 * - Normal message creation via client.im.message.create when no threadId
 * - Real messageId returned from both reply and create paths
 * - File upload (image/file) with thread reply
 * - Reply API failure fallback to message.create
 * - Edge cases: done signal, unsupported type, client not initialized
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { FeishuChannel } from './feishu-channel.js';

// ─── Mock Logger ────────────────────────────────────────────────────────────

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// ─── Mock Lark SDK ──────────────────────────────────────────────────────────

/**
 * Create a mock Lark client with controllable im.message methods.
 */
function createMockClient() {
  const createMock = vi.fn().mockResolvedValue({
    data: { message_id: 'new_msg_001' },
  });

  const replyMock = vi.fn().mockResolvedValue({
    data: { message_id: 'reply_msg_001' },
  });

  /**
   * Mock image upload that properly drains and closes the provided stream
   * to avoid async ENOENT race conditions on temp file cleanup.
   */
  const imageCreateMock = vi.fn().mockImplementation(async (opts: any) => {
    const stream = opts?.data?.image;
    if (stream && typeof stream.on === 'function') {
      // Drain the stream so it closes the underlying file descriptor
      for await (const _chunk of stream) { /* intentionally empty */ }
    }
    return { image_key: 'img_key_001' };
  });

  const fileCreateMock = vi.fn().mockImplementation(async (opts: any) => {
    const stream = opts?.data?.file;
    if (stream && typeof stream.on === 'function') {
      for await (const _chunk of stream) { /* intentionally empty */ }
    }
    return { file_key: 'file_key_001' };
  });

  return {
    client: {
      im: {
        message: {
          create: createMock,
          reply: replyMock,
        },
        image: {
          create: imageCreateMock,
        },
        file: {
          create: fileCreateMock,
        },
      },
    },
    mocks: { createMock, replyMock, imageCreateMock, fileCreateMock },
  };
}

// ─── Mock Feishu platform modules ───────────────────────────────────────────

vi.mock('../platforms/feishu/index.js', () => ({
  InteractionManager: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
  WelcomeService: vi.fn(),
  createFeishuClient: vi.fn(() => {
    const { client } = createMockClient();
    return client;
  }),
}));

vi.mock('./feishu/index.js', () => ({
  PassiveModeManager: vi.fn().mockImplementation(() => ({
    isPassiveModeDisabled: vi.fn().mockReturnValue(false),
    setPassiveModeDisabled: vi.fn(),
    getPassiveModeDisabledChats: vi.fn().mockReturnValue([]),
  })),
  MentionDetector: vi.fn().mockImplementation(() => ({
    setClient: vi.fn(),
    fetchBotInfo: vi.fn().mockResolvedValue(undefined),
    getBotInfo: vi.fn().mockReturnValue(undefined),
  })),
  WelcomeHandler: vi.fn().mockImplementation(() => ({
    handleP2PChatEntered: vi.fn(),
    handleChatMemberAdded: vi.fn(),
    setWelcomeService: vi.fn(),
  })),
  MessageHandler: vi.fn().mockImplementation(() => ({
    handleMessageReceive: vi.fn(),
    handleCardAction: vi.fn(),
    initialize: vi.fn(),
    clearClient: vi.fn(),
  })),
  messageLogger: { init: vi.fn().mockResolvedValue(undefined) },
  WsConnectionManager: vi.fn().mockImplementation(() => ({
    state: 'connected',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    recordMessageReceived: vi.fn(),
    getMetrics: vi.fn().mockReturnValue(undefined),
  })),
  type: {},
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a FeishuChannel and inject a mock client directly.
 * This bypasses the constructor's createFeishuClient call.
 */
function createTestChannel(mockClient: ReturnType<typeof createMockClient>['client']) {
  const channel = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });
  // Inject mock client by setting the private field
  (channel as any).client = mockClient;
  // Mark as running so sendMessage doesn't throw
  (channel as any)._status = 'running';
  return channel;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('FeishuChannel doSendMessage — Issue #1619', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('text messages', () => {
    it('should use message.create when no threadId is provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello',
      });

      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mocks.replyMock).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_001');
    });

    it('should use message.reply when threadId is provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello',
        threadId: 'root_msg_456',
      });

      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).toHaveBeenCalledWith({
        path: { message_id: 'root_msg_456' },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
        },
      });
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_001');
    });
  });

  describe('text messages with mentions (post type)', () => {
    it('should send as post type when mentions are provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const mentions = [{ openId: 'ou_user123', name: 'Alice' }];
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello @Alice',
        mentions,
      });

      // Should use message.create with post type (no threadId)
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      const [[createCall]] = mocks.createMock.mock.calls;
      expect(createCall.data.msg_type).toBe('post');
      // Content should be JSON with Feishu post structure
      const content = JSON.parse(createCall.data.content);
      expect(content.zh_cn.title).toBe('');
      expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_user123' });
      expect(content.zh_cn.content[0][1]).toEqual({ tag: 'text', text: ' Hello @Alice' });
      expect(mocks.replyMock).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_001');
    });

    it('should send post type via thread reply when mentions and threadId are both provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const mentions = [{ openId: 'ou_user456', name: 'Bob' }];
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Reply @Bob',
        mentions,
        threadId: 'root_msg_999',
      });

      // Should use message.reply with post type
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      const [[replyCall]] = mocks.replyMock.mock.calls;
      expect(replyCall.path.message_id).toBe('root_msg_999');
      expect(replyCall.data.msg_type).toBe('post');
      // Content should be JSON with Feishu post structure
      const content = JSON.parse(replyCall.data.content);
      expect(content.zh_cn.title).toBe('');
      expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_user456' });
      expect(content.zh_cn.content[0][1]).toEqual({ tag: 'text', text: ' Reply @Bob' });
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_001');
    });

    it('should fall back to create when reply fails for post type with mentions', async () => {
      const { client, mocks } = createMockClient();
      mocks.replyMock.mockRejectedValueOnce(new Error('Thread deleted'));
      const channel = createTestChannel(client);

      const mentions = [{ openId: 'ou_user789', name: 'Charlie' }];
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Fallback @Charlie',
        mentions,
        threadId: 'deleted_thread',
      });

      // Reply attempted then fell back to create
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      const [[createCall]] = mocks.createMock.mock.calls;
      expect(createCall.data.msg_type).toBe('post');
      const content = JSON.parse(createCall.data.content);
      expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_user789' });
      expect(result).toBe('new_msg_001');
    });

    it('should handle multiple mentions in a single post message', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const mentions = [
        { openId: 'ou_user_a', name: 'Alice' },
        { openId: 'ou_user_b', name: 'Bob' },
      ];
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Hello team',
        mentions,
      });

      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      const [[createCall]] = mocks.createMock.mock.calls;
      expect(createCall.data.msg_type).toBe('post');
      const content = JSON.parse(createCall.data.content);
      // Both mentions should be at tags before the text element
      expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_user_a' });
      expect(content.zh_cn.content[0][1]).toEqual({ tag: 'at', user_id: 'ou_user_b' });
      expect(content.zh_cn.content[0][2]).toEqual({ tag: 'text', text: ' Hello team' });
      expect(mocks.replyMock).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_001');
    });
  });

  describe('card messages (interactive)', () => {
    it('should use message.create for cards without threadId', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const card = { config: { wide_screen_mode: true }, elements: [] };
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'card',
        card,
      });

      expect(mocks.createMock).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat_123',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mocks.replyMock).not.toHaveBeenCalled();
      expect(result).toBe('new_msg_001');
    });

    it('should use message.reply for cards with threadId', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const card = { config: { wide_screen_mode: true }, elements: [] };
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'card',
        card,
        threadId: 'root_msg_789',
      });

      expect(mocks.replyMock).toHaveBeenCalledWith({
        path: { message_id: 'root_msg_789' },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_001');
    });
  });

  describe('messageId return value', () => {
    it('should return undefined when API returns no message_id', async () => {
      const { client, mocks } = createMockClient();
      mocks.createMock.mockResolvedValueOnce({ data: {} });
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'No ID',
      });

      expect(result).toBeUndefined();
    });

    it('should return undefined for done signal type', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'done',
        success: true,
      });

      expect(result).toBeUndefined();
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(mocks.replyMock).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should throw on unsupported message type', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);

      // 'done' is a valid type — should not throw
      await channel.sendMessage({
        chatId: 'chat_123',
        type: 'done',
        success: true,
      });

      await expect(
        channel.sendMessage({
          chatId: 'chat_123',
          type: 'unknown_type',
        } as any),
      ).rejects.toThrow('Unsupported message type');
    });

    it('should throw when client is not initialized', async () => {
      const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
      (channel as any)._status = 'running';
      // Don't inject client — it should be undefined

      await expect(
        channel.sendMessage({
          chatId: 'chat_123',
          type: 'text',
          text: 'test',
        }),
      ).rejects.toThrow('Client not initialized');
    });

    it('should fall back to message.create when reply API fails', async () => {
      const { client, mocks } = createMockClient();
      // Make reply throw an error
      mocks.replyMock.mockRejectedValueOnce(new Error('Thread message not found'));
      const channel = createTestChannel(client);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Fallback test',
        threadId: 'deleted_msg_999',
      });

      // reply was attempted
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      // then fell back to create
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(result).toBe('new_msg_001');
    });

    it('should fall back to create when reply fails for card messages', async () => {
      const { client, mocks } = createMockClient();
      mocks.replyMock.mockRejectedValueOnce(new Error('Permission denied'));
      const channel = createTestChannel(client);

      const card = { config: { wide_screen_mode: true }, elements: [] };
      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'card',
        card,
        threadId: 'root_msg_000',
      });

      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(result).toBe('new_msg_001');
    });
  });

  describe('file messages with thread reply', () => {
    // Collect temp files for cleanup after all tests in this describe block.
    // Cannot delete immediately: fs.createReadStream opens asynchronously,
    // and the mock upload API resolves without consuming the stream,
    // causing ENOENT race conditions in ESM mode.
    const tempFiles: string[] = [];

    afterAll(() => {
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    });

    it('should send image via reply when threadId is provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const testImagePath = path.join(os.tmpdir(), `test_image_${Date.now()}.png`);
      fs.writeFileSync(testImagePath, Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
        'hex',
      ));
      tempFiles.push(testImagePath);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'file',
        filePath: testImagePath,
        threadId: 'root_msg_456',
      });

      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_001');
    });

    it('should send file via reply when threadId is provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const testFilePath = path.join(os.tmpdir(), `test_file_${Date.now()}.pdf`);
      fs.writeFileSync(testFilePath, Buffer.from('%PDF-1.4 test content'));
      tempFiles.push(testFilePath);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'file',
        filePath: testFilePath,
        threadId: 'root_msg_789',
      });

      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_001');
    });

    it('should fall back to create when reply fails during file send', async () => {
      const { client, mocks } = createMockClient();
      mocks.replyMock.mockRejectedValueOnce(new Error('Thread expired'));
      const channel = createTestChannel(client);

      const testImagePath = path.join(os.tmpdir(), `test_image_fb_${Date.now()}.png`);
      fs.writeFileSync(testImagePath, Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
        'hex',
      ));
      tempFiles.push(testImagePath);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'file',
        filePath: testImagePath,
        threadId: 'deleted_root',
      });

      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(result).toBe('new_msg_001');
    });
  });

  describe('video file messages — Issue #2265', () => {
    const tempFiles: string[] = [];

    afterAll(() => {
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    });

    it('should upload mp4 as file_type:mp4 and send as file (ffmpeg unavailable fallback)', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const testMp4Path = path.join(os.tmpdir(), `test_video_${Date.now()}.mp4`);
      fs.writeFileSync(testMp4Path, Buffer.from('fake mp4 content'));
      tempFiles.push(testMp4Path);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'file',
        filePath: testMp4Path,
      });

      // Should upload video via file.create with file_type:'mp4'
      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
      const fileCallData = mocks.fileCreateMock.mock.calls[0][0].data;
      expect(fileCallData.file_type).toBe('mp4');

      // Should send as 'file' message type (fallback when ffmpeg unavailable)
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      const [[createCall]] = mocks.createMock.mock.calls;
      expect(createCall.data.msg_type).toBe('file');
      const content = JSON.parse(createCall.data.content);
      expect(content.file_key).toBe('file_key_001');

      expect(result).toBe('new_msg_001');
    });

    it('should send mp4 via thread reply when threadId provided', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const testMp4Path = path.join(os.tmpdir(), `test_video_tr_${Date.now()}.mp4`);
      fs.writeFileSync(testMp4Path, Buffer.from('fake mp4 content'));
      tempFiles.push(testMp4Path);

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'file',
        filePath: testMp4Path,
        threadId: 'root_msg_888',
      });

      // Should upload video via file.create
      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
      // Should use reply API since threadId is provided
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(result).toBe('reply_msg_001');
    });
  });
});
