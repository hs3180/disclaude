/**
 * Extended tests for FeishuChannel — uploadImage, file validation,
 * doStop lifecycle, and checkHealth delegation.
 *
 * Related: #1617
 *
 * These tests cover areas NOT already tested in:
 * - feishu-channel-send.test.ts (text/card/file/thread reply)
 * - feishu-channel-mentions.test.ts (post type with @mention)
 * - PR #3673 (extractChatIdFromEvent, offline queue, capabilities, bot info)
 */

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

function createMockClient() {
  const createMock = vi.fn().mockResolvedValue({
    data: { message_id: 'new_msg_001' },
  });

  const replyMock = vi.fn().mockResolvedValue({
    data: { message_id: 'reply_msg_001' },
  });

  const imageCreateMock = vi.fn().mockImplementation(async (opts: any) => {
    const stream = opts?.data?.image;
    if (stream && typeof stream.on === 'function') {
      for await (const _chunk of stream) { /* drain */ }
    }
    return { image_key: 'img_key_001' };
  });

  const fileCreateMock = vi.fn().mockImplementation(async (opts: any) => {
    const stream = opts?.data?.file;
    if (stream && typeof stream.on === 'function') {
      for await (const _chunk of stream) { /* drain */ }
    }
    return { file_key: 'file_key_001' };
  });

  return {
    client: {
      im: {
        message: { create: createMock, reply: replyMock },
        image: { create: imageCreateMock },
        file: { create: fileCreateMock },
      },
    },
    mocks: { createMock, replyMock, imageCreateMock, fileCreateMock },
  };
}

// ─── Mock video-cover-extractor ─────────────────────────────────────────────

vi.mock('../utils/video-cover-extractor.js', () => ({
  VIDEO_EXTENSIONS: new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']),
  extractVideoCover: vi.fn().mockReturnValue({ success: false, error: 'ffmpeg not available' }),
}));

// ─── Mock Feishu platform modules ───────────────────────────────────────────

const mockWsManager = vi.hoisted(() => ({
  state: 'connected',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  isHealthy: vi.fn().mockReturnValue(true),
  on: vi.fn(),
  getMetrics: vi.fn().mockReturnValue(undefined),
}));

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
  TriggerModeManager: vi.fn().mockImplementation(() => ({
    isTriggerEnabled: vi.fn().mockReturnValue(false),
    setTriggerEnabled: vi.fn(),
    getTriggerEnabledChats: vi.fn().mockReturnValue([]),
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
  WsConnectionManager: vi.fn().mockImplementation(() => mockWsManager),
  type: {},
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestChannel(mockClient: ReturnType<typeof createMockClient>['client']) {
  const channel = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });
  (channel as any).client = mockClient;
  (channel as any)._status = 'running';
  return channel;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('FeishuChannel extended tests (#1617)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset wsManager state
    mockWsManager.state = 'connected';
    mockWsManager.isHealthy.mockReturnValue(true);
  });

  // ─── uploadImage() ──────────────────────────────────────────────────────

  describe('uploadImage()', () => {
    const tempFiles: string[] = [];

    afterAll(() => {
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    });

    it('should upload image and return imageKey on success', async () => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const testImage = path.join(os.tmpdir(), `upload_test_${Date.now()}.png`);
      fs.writeFileSync(testImage, Buffer.from('fake png content'));
      tempFiles.push(testImage);

      const result = await channel.uploadImage(testImage);

      expect(result.imageKey).toBe('img_key_001');
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
    });

    it('should throw when client not initialized', async () => {
      const channel = new FeishuChannel({ appId: 'test', appSecret: 'test' });
      // Don't inject client

      const testImage = path.join(os.tmpdir(), `no_client_${Date.now()}.png`);
      fs.writeFileSync(testImage, Buffer.from('x'));
      tempFiles.push(testImage);

      await expect(channel.uploadImage(testImage)).rejects.toThrow(
        'Feishu client not initialized — call start() first',
      );
    });

    it('should throw when image file exceeds 10MB', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);

      const bigImage = path.join(os.tmpdir(), `big_image_${Date.now()}.png`);
      // Create a file > 10MB (write a sparse-like small file then mock stat)
      fs.writeFileSync(bigImage, Buffer.alloc(100));
      tempFiles.push(bigImage);

      // Mock fs.stat to report file as > 10MB
      const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce({
        size: 11 * 1024 * 1024,
      } as fs.Stats);

      await expect(channel.uploadImage(bigImage)).rejects.toThrow(
        'Image file too large',
      );

      statSpy.mockRestore();
    });

    it('should throw when upload returns no image_key', async () => {
      const { client, mocks } = createMockClient();
      mocks.imageCreateMock.mockImplementation(async (opts: any) => {
        const stream = opts?.data?.image;
        if (stream && typeof stream.on === 'function') {
          for await (const _chunk of stream) { /* drain */ }
        }
        return {}; // No image_key
      });
      const channel = createTestChannel(client);

      const testImage = path.join(os.tmpdir(), `no_key_${Date.now()}.png`);
      fs.writeFileSync(testImage, Buffer.from('fake png'));
      tempFiles.push(testImage);

      await expect(channel.uploadImage(testImage)).rejects.toThrow(
        'Failed to upload image',
      );
    });
  });

  // ─── File size validation in doSendMessage ──────────────────────────────
  // Note: These tests create actual large files since vi.spyOn cannot
  // redefine ESM module exports. The files are small enough for CI but
  // large enough to trigger the size limits.

  describe('file size validation in doSendMessage', () => {
    const tempFiles: string[] = [];

    afterAll(() => {
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    });

    it('should throw when image file exceeds 10MB', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);

      // Create a file > 10MB
      const bigImage = path.join(os.tmpdir(), `big_send_${Date.now()}.png`);
      const fd = fs.openSync(bigImage, 'w');
      fs.truncateSync(fd, 11 * 1024 * 1024);
      fs.closeSync(fd);
      tempFiles.push(bigImage);

      await expect(
        channel.sendMessage({ chatId: 'chat_123', type: 'file', filePath: bigImage }),
      ).rejects.toThrow('Image file too large');
    });

    it('should throw when generic file exceeds 30MB', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);

      const bigFile = path.join(os.tmpdir(), `big_file_${Date.now()}.pdf`);
      const fd = fs.openSync(bigFile, 'w');
      fs.truncateSync(fd, 31 * 1024 * 1024);
      fs.closeSync(fd);
      tempFiles.push(bigFile);

      await expect(
        channel.sendMessage({ chatId: 'chat_123', type: 'file', filePath: bigFile }),
      ).rejects.toThrow('File too large');
    });

    it('should throw when video file exceeds 30MB', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);

      const bigVideo = path.join(os.tmpdir(), `big_video_${Date.now()}.mp4`);
      const fd = fs.openSync(bigVideo, 'w');
      fs.truncateSync(fd, 31 * 1024 * 1024);
      fs.closeSync(fd);
      tempFiles.push(bigVideo);

      await expect(
        channel.sendMessage({ chatId: 'chat_123', type: 'file', filePath: bigVideo }),
      ).rejects.toThrow('File too large');
    });
  });

  // ─── File type mapping ──────────────────────────────────────────────────

  describe('file type mapping in doSendMessage', () => {
    const tempFiles: string[] = [];

    afterAll(() => {
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    });

    it.each([
      { ext: '.pdf', expectedType: 'pdf' },
      { ext: '.doc', expectedType: 'doc' },
      { ext: '.docx', expectedType: 'doc' },
      { ext: '.xls', expectedType: 'xls' },
      { ext: '.xlsx', expectedType: 'xls' },
      { ext: '.csv', expectedType: 'xls' },
      { ext: '.ppt', expectedType: 'ppt' },
      { ext: '.pptx', expectedType: 'ppt' },
      { ext: '.opus', expectedType: 'opus' },
      { ext: '.zip', expectedType: 'stream' },
      { ext: '.txt', expectedType: 'stream' },
    ])('should map $ext to file_type $expectedType', async ({ ext, expectedType }) => {
      const { client, mocks } = createMockClient();
      const channel = createTestChannel(client);

      const testFile = path.join(os.tmpdir(), `type_test_${Date.now()}${ext}`);
      fs.writeFileSync(testFile, Buffer.from('test content'));
      tempFiles.push(testFile);

      await channel.sendMessage({ chatId: 'chat_123', type: 'file', filePath: testFile });

      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.fileCreateMock.mock.calls[0][0].data.file_type).toBe(expectedType);
    });
  });

  // ─── checkHealth() ──────────────────────────────────────────────────────

  describe('checkHealth()', () => {
    it('should return true when wsConnectionManager is healthy', () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);
      // Inject wsConnectionManager (normally set in doStart)
      (channel as any).wsConnectionManager = mockWsManager;
      mockWsManager.isHealthy.mockReturnValue(true);

      expect((channel as any).checkHealth()).toBe(true);
    });

    it('should return false when wsConnectionManager is unhealthy', () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);
      (channel as any).wsConnectionManager = mockWsManager;
      mockWsManager.isHealthy.mockReturnValue(false);

      expect((channel as any).checkHealth()).toBe(false);
    });

    it('should return false when wsConnectionManager is undefined', () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);
      // wsConnectionManager is undefined by default (not started)
      (channel as any).wsConnectionManager = undefined;

      expect((channel as any).checkHealth()).toBe(false);
    });
  });

  // ─── doStop() lifecycle ─────────────────────────────────────────────────

  describe('doStop() lifecycle', () => {
    it('should stop wsConnectionManager and clear resources', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);

      // Simulate running state with a wsManager injected
      (channel as any).wsConnectionManager = mockWsManager;
      (channel as any).offlineQueue = [
        { message: { chatId: 'c1', type: 'text', text: 'queued' }, queuedAt: Date.now() },
      ];

      await channel.stop();

      expect(mockWsManager.stop).toHaveBeenCalledTimes(1);
      // Offline queue should be cleared
      expect((channel as any).offlineQueue).toEqual([]);
    });

    it('should handle stop when wsConnectionManager is undefined', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);
      (channel as any).wsConnectionManager = undefined;

      // Should not throw
      await channel.stop();
    });
  });

  // ─── File message without filePath ──────────────────────────────────────

  describe('file message validation', () => {
    it('should throw when file message has no filePath', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);

      await expect(
        channel.sendMessage({ chatId: 'chat_123', type: 'file' } as any),
      ).rejects.toThrow('File path is required for file messages');
    });
  });

  // ─── Offline queue integration ──────────────────────────────────────────

  describe('offline queue during doSendMessage', () => {
    it('should queue message when WebSocket is reconnecting', async () => {
      const { client } = createMockClient();
      const channel = createTestChannel(client);
      // Simulate reconnecting state
      (channel as any).wsConnectionManager = mockWsManager;
      mockWsManager.state = 'reconnecting';

      const result = await channel.sendMessage({
        chatId: 'chat_123',
        type: 'text',
        text: 'Queued message',
      });

      // Message should be queued, not sent
      expect(result).toBeUndefined();
      expect((channel as any).offlineQueue).toHaveLength(1);
      expect((channel as any).offlineQueue[0].message.text).toBe('Queued message');
    });
  });
});
