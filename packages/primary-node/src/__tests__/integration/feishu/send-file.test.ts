/**
 * Feishu Integration Test: File upload end-to-end.
 *
 * Tests the uploadFile IPC flow through the channel handler layer:
 * - File upload delegation to channel.sendMessage
 * - Synthetic file metadata return
 * - Thread support for file uploads
 * - Error propagation
 * - Various file path formats
 *
 * P1 priority per Issue #1626.
 *
 * @module integration/feishu/send-file
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChannelApiHandlers } from '../../../utils/channel-handlers.js';
import { createMockChannel, getSentMessages, describeIfFeishu, getTestChatId } from './helpers.js';

// ============================================================================
// Tests: uploadFile handler integration with mock channel
// ============================================================================

describe('uploadFile: handler integration', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    mockChannel = createMockChannel();
    vi.clearAllMocks();
  });

  it('should upload file and return synthetic metadata', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    const result = await handlers.uploadFile('oc_test_chat', '/tmp/reports/monthly-report.pdf');

    // Verify the file was sent via channel.sendMessage
    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      chatId: 'oc_test_chat',
      type: 'file',
      filePath: '/tmp/reports/monthly-report.pdf',
      threadId: undefined,
    });

    // Verify synthetic metadata
    expect(result).toEqual({
      fileKey: '',
      fileType: 'file',
      fileName: 'monthly-report.pdf',
      fileSize: 0,
    });
  });

  it('should upload file with thread reply', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    const result = await handlers.uploadFile('oc_test_chat', '/tmp/data.csv', 'thread_456');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(1);
    expect(sent[0].threadId).toBe('thread_456');

    expect(result.fileName).toBe('data.csv');
  });

  it('should extract filename from nested path', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    const result = await handlers.uploadFile('oc_test', '/a/b/c/d/deeply/nested/file.txt');

    expect(result.fileName).toBe('file.txt');
  });

  it('should handle filename with no directory', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    const result = await handlers.uploadFile('oc_test', 'simple.txt');

    expect(result.fileName).toBe('simple.txt');
  });

  it('should handle filename with multiple dots', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    const result = await handlers.uploadFile('oc_test', '/tmp/archive.tar.gz');

    expect(result.fileName).toBe('archive.tar.gz');
  });

  it('should handle filename with special characters', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    const result = await handlers.uploadFile('oc_test', '/tmp/report_2024-03-15_v2.1 (final).pdf');

    expect(result.fileName).toBe('report_2024-03-15_v2.1 (final).pdf');
  });

  it('should handle CJK characters in filename', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    // Use unicode escapes to avoid encoding issues in test source
    const cjkPath = '/tmp/' + '\u6D4B\u8BD5\u6587\u4EF6.txt'; // 测试文件.txt
    const expectedName = '\u6D4B\u8BD5\u6587\u4EF6.txt';
    const result = await handlers.uploadFile('oc_test', cjkPath);

    expect(result.fileName).toBe(expectedName);
  });

  it('should log debug about incomplete metadata', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await handlers.uploadFile('oc_test', '/tmp/doc.pdf');

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'oc_test',
        channel: 'Feishu',
      }),
      'uploadFile: using channel.sendMessage \u2014 file metadata may be incomplete'
    );
  });

  it('should propagate channel errors', async () => {
    const errorChannel = createMockChannel({
      sendMessage: async () => { throw new Error('File too large (max 30MB)'); },
    } as any);

    const handlers = createChannelApiHandlers(errorChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    await expect(handlers.uploadFile('oc_test', '/tmp/huge.zip'))
      .rejects.toThrow('File too large (max 30MB)');

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'oc_test',
        handler: 'uploadFile',
      }),
      'IPC handler failed'
    );
  });

  it('should upload multiple files in sequence', async () => {
    const handlers = createChannelApiHandlers(mockChannel, {
      logger: mockLogger,
      channelName: 'Feishu',
    });

    const result1 = await handlers.uploadFile('oc_test', '/tmp/file1.pdf');
    const result2 = await handlers.uploadFile('oc_test', '/tmp/file2.csv');
    const result3 = await handlers.uploadFile('oc_test', '/tmp/file3.png');

    const sent = getSentMessages(mockChannel);
    expect(sent).toHaveLength(3);

    expect(result1.fileName).toBe('file1.pdf');
    expect(result2.fileName).toBe('file2.csv');
    expect(result3.fileName).toBe('file3.png');

    expect(sent.map((m) => m.type)).toEqual(['file', 'file', 'file']);
  });
});

// ============================================================================
// Tests: Real Feishu API (gated behind FEISHU_INTEGRATION_TEST)
// ============================================================================

describeIfFeishu('uploadFile: real Feishu API', () => {
  it('should verify test chat ID is configured', () => {
    const chatId = getTestChatId();
    expect(chatId).toBeTruthy();
    expect(chatId).toMatch(/^oc_/);
  });
});
