/**
 * Integration Test: File upload flow.
 *
 * Tests the IPC uploadFile → FeishuChannel.doSendMessage chain,
 * verifying that file messages are correctly dispatched.
 *
 * This test is gated by FEISHU_INTEGRATION_TEST env var.
 * When not set, all tests are automatically skipped.
 *
 * @see Issue #1626 — Optional Feishu integration tests (skip by default)
 */

import { it, expect, vi, beforeEach } from 'vitest';
import { describeIfFeishu } from './helpers.js';
import { createChannelApiHandlers } from '../../../utils/channel-handlers.js';
import type { IChannel, OutgoingMessage } from '@disclaude/core';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual<typeof import('@disclaude/core')>('@disclaude/core');
  return {
    ...actual,
    createLogger: () => mockLogger,
  };
});

function createMockChannel() {
  const sentMessages: OutgoingMessage[] = [];

  const channel: IChannel = {
    id: 'test-feishu',
    name: 'Test Feishu',
    type: 'feishu',
    capabilities: {
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: true,
    },
    isRunning: false,
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn(async (msg: OutgoingMessage) => {
      sentMessages.push(msg);
    }),
    onMessage: vi.fn(),
    onControl: vi.fn(),
    checkHealth: vi.fn(() => true),
  } as unknown as IChannel;

  return { channel, sentMessages };
}

describeIfFeishu('IPC uploadFile — file upload flow', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let handlers: ReturnType<typeof createChannelApiHandlers>;

  beforeEach(() => {
    mockChannel = createMockChannel();
    handlers = createChannelApiHandlers(mockChannel.channel, {
      logger: mockLogger as any,
      channelName: 'Feishu',
    });
    vi.clearAllMocks();
  });

  it('should send a file message via IPC handler', async () => {
    const result = await handlers.uploadFile('oc_test_chat', '/tmp/test-report.pdf');

    // Verify the channel received a file message
    expect(mockChannel.channel.sendMessage).toHaveBeenCalledTimes(1);
    const sentMsg = mockChannel.sentMessages[0];
    expect(sentMsg.chatId).toBe('oc_test_chat');
    expect(sentMsg.type).toBe('file');
    expect(sentMsg.filePath).toBe('/tmp/test-report.pdf');

    // Verify return metadata (synthetic)
    expect(result.fileKey).toBe('');
    expect(result.fileName).toBe('test-report.pdf');
    expect(result.fileType).toBe('file');
  });

  it('should send a file message with threadId', async () => {
    await handlers.uploadFile('oc_test_chat', '/tmp/image.png', 'om_thread_789');

    const sentMsg = mockChannel.sentMessages[0];
    expect(sentMsg.threadId).toBe('om_thread_789');
  });

  it('should extract filename from file path', async () => {
    const result = await handlers.uploadFile(
      'oc_test_chat',
      '/some/deep/path/to/document-v2.pdf'
    );
    expect(result.fileName).toBe('document-v2.pdf');
  });

  it('should propagate uploadFile errors', async () => {
    const errorChannel = createMockChannel();
    const errorHandlers = createChannelApiHandlers(errorChannel.channel, {
      logger: mockLogger as any,
      channelName: 'Feishu',
    });

    (errorChannel.channel.sendMessage as any).mockRejectedValueOnce(
      new Error('Upload failed')
    );

    await expect(
      errorHandlers.uploadFile('oc_test_chat', '/tmp/big-file.zip')
    ).rejects.toThrow('Upload failed');

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'uploadFile' }),
      'IPC handler failed'
    );
  });
});
