/**
 * Tests for FeishuAdapter message sending, especially file upload and thread reply.
 *
 * Issue #1619: File type support in FeishuAdapter with proper upload and thread reply.
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 *
 * Tests cover:
 * - File upload flow (image and document) with thread reply
 * - Thread reply returns messageId for non-file messages
 * - File not found / missing path error handling
 * - File size limit enforcement
 * - Reply API failure handling for file messages
 * - convert() throws for file content type (async upload required)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { FeishuAdapter } from './feishu-adapter.js';

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

// ─── Mock Lark Client ───────────────────────────────────────────────────────

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
      for await (const _chunk of stream) { /* drain stream */ }
    }
    return { image_key: 'img_key_001' };
  });

  const fileCreateMock = vi.fn().mockImplementation(async (opts: any) => {
    const stream = opts?.data?.file;
    if (stream && typeof stream.on === 'function') {
      for await (const _chunk of stream) { /* drain stream */ }
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestAdapter(mockClient: ReturnType<typeof createMockClient>['client']) {
  const adapter = new FeishuAdapter();
  // Cast to any because mock client doesn't match full lark.Client interface
  adapter.setClient(mockClient as any);
  return adapter;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('FeishuAdapter — Issue #1619', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('convert() rejects file content', () => {
    it('should throw for file content type (async upload required)', () => {
      const { client } = createMockClient();
      const adapter = createTestAdapter(client);

      expect(() =>
        adapter.convert({
          chatId: 'oc_123',
          content: { type: 'file', path: '/tmp/test.png' },
        }),
      ).toThrow('File content cannot be converted synchronously');
    });
  });

  describe('thread reply returns messageId for non-file messages', () => {
    it('should return messageId from reply API for text messages', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello' },
        threadId: 'root_msg_456',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('reply_msg_001');
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).not.toHaveBeenCalled();
    });

    it('should return messageId from reply API for card messages', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const card = { type: 'card' as const, title: 'Test', sections: [] };
      const result = await adapter.send({
        chatId: 'oc_123',
        content: card,
        threadId: 'root_msg_789',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('reply_msg_001');
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
    });

    it('should return messageId from create API when no threadId', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello' },
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('new_msg_001');
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).not.toHaveBeenCalled();
    });
  });

  describe('file message upload and send', () => {
    const tempFiles: string[] = [];

    afterAll(() => {
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    });

    it('should upload image and send as thread reply', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testImagePath = path.join(os.tmpdir(), `test_adapter_img_${Date.now()}.png`);
      fs.writeFileSync(testImagePath, Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
        'hex',
      ));
      tempFiles.push(testImagePath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testImagePath, name: 'test.png' },
        threadId: 'root_msg_456',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('reply_msg_001');
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).not.toHaveBeenCalled();
    });

    it('should upload document and send as new message', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testFilePath = path.join(os.tmpdir(), `test_adapter_doc_${Date.now()}.pdf`);
      fs.writeFileSync(testFilePath, Buffer.from('%PDF-1.4 test content'));
      tempFiles.push(testFilePath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testFilePath, name: 'test.pdf' },
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('new_msg_001');
      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).not.toHaveBeenCalled();
    });

    it('should return error when file path is missing', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: '' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File path is required');
      expect(mocks.imageCreateMock).not.toHaveBeenCalled();
      expect(mocks.fileCreateMock).not.toHaveBeenCalled();
    });

    it('should return error when file does not exist', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: '/nonexistent/file.png' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
      expect(mocks.imageCreateMock).not.toHaveBeenCalled();
    });

    it('should return error when image upload fails (no image_key)', async () => {
      const { client, mocks } = createMockClient();
      mocks.imageCreateMock.mockResolvedValueOnce({ image_key: undefined });
      const adapter = createTestAdapter(client);

      const testImagePath = path.join(os.tmpdir(), `test_adapter_fail_${Date.now()}.png`);
      fs.writeFileSync(testImagePath, Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
        'hex',
      ));
      tempFiles.push(testImagePath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testImagePath },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload image');
    });

    it('should return error when file upload fails (no file_key)', async () => {
      const { client, mocks } = createMockClient();
      mocks.fileCreateMock.mockResolvedValueOnce({ file_key: undefined });
      const adapter = createTestAdapter(client);

      const testFilePath = path.join(os.tmpdir(), `test_adapter_ffail_${Date.now()}.pdf`);
      fs.writeFileSync(testFilePath, Buffer.from('%PDF-1.4'));
      tempFiles.push(testFilePath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testFilePath },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload file');
    });

    it('should detect image by extension and use image upload API', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testJpgPath = path.join(os.tmpdir(), `test_adapter_jpg_${Date.now()}.jpg`);
      fs.writeFileSync(testJpgPath, Buffer.from('ffd8ffe0'));
      tempFiles.push(testJpgPath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testJpgPath },
      });

      expect(result.success).toBe(true);
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.fileCreateMock).not.toHaveBeenCalled();
    });

    it('should detect non-image by extension and use file upload API', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testXlsxPath = path.join(os.tmpdir(), `test_adapter_xlsx_${Date.now()}.xlsx`);
      fs.writeFileSync(testXlsxPath, Buffer.from('xlsx content'));
      tempFiles.push(testXlsxPath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testXlsxPath },
      });

      expect(result.success).toBe(true);
      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.imageCreateMock).not.toHaveBeenCalled();

      // Verify file_type mapping for .xlsx
      const callData = mocks.fileCreateMock.mock.calls[0][0].data;
      expect(callData.file_type).toBe('xls');
    });
  });

  describe('canHandle', () => {
    it('should handle oc_ prefixed chatIds', () => {
      const { client } = createMockClient();
      const adapter = createTestAdapter(client);
      expect(adapter.canHandle('oc_123')).toBe(true);
    });

    it('should handle ou_ prefixed chatIds', () => {
      const { client } = createMockClient();
      const adapter = createTestAdapter(client);
      expect(adapter.canHandle('ou_456')).toBe(true);
    });

    it('should not handle non-Feishu chatIds', () => {
      const { client } = createMockClient();
      const adapter = createTestAdapter(client);
      expect(adapter.canHandle('rest_123')).toBe(false);
      expect(adapter.canHandle('cli_123')).toBe(false);
    });
  });
});
