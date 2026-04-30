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

    it('should return error when image exceeds 10MB size limit', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testLargeImgPath = path.join(os.tmpdir(), `test_adapter_large_img_${Date.now()}.png`);
      // Write exactly 10MB + 1 byte
      const largeBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 0x00);
      largeBuffer[0] = 0x89; largeBuffer[1] = 0x50; largeBuffer[2] = 0x4e; largeBuffer[3] = 0x47; // PNG header
      fs.writeFileSync(testLargeImgPath, largeBuffer);
      tempFiles.push(testLargeImgPath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testLargeImgPath },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Image file too large');
      expect(mocks.imageCreateMock).not.toHaveBeenCalled();
      expect(mocks.fileCreateMock).not.toHaveBeenCalled();
    });

    it('should return error when document exceeds 30MB size limit', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testLargeDocPath = path.join(os.tmpdir(), `test_adapter_large_doc_${Date.now()}.pdf`);
      // Write exactly 30MB + 1 byte
      const largeBuffer = Buffer.alloc(30 * 1024 * 1024 + 1, 0x25);
      fs.writeFileSync(testLargeDocPath, largeBuffer);
      tempFiles.push(testLargeDocPath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testLargeDocPath },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File too large');
      expect(mocks.imageCreateMock).not.toHaveBeenCalled();
      expect(mocks.fileCreateMock).not.toHaveBeenCalled();
    });

    it('should accept image at exactly 10MB', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testExactImgPath = path.join(os.tmpdir(), `test_adapter_exact_img_${Date.now()}.png`);
      const exactBuffer = Buffer.alloc(10 * 1024 * 1024, 0x00);
      exactBuffer[0] = 0x89; exactBuffer[1] = 0x50; exactBuffer[2] = 0x4e; exactBuffer[3] = 0x47;
      fs.writeFileSync(testExactImgPath, exactBuffer);
      tempFiles.push(testExactImgPath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testExactImgPath },
      });

      expect(result.success).toBe(true);
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
    });

    it('should accept document at exactly 30MB', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testExactDocPath = path.join(os.tmpdir(), `test_adapter_exact_doc_${Date.now()}.pdf`);
      const exactBuffer = Buffer.alloc(30 * 1024 * 1024, 0x25);
      fs.writeFileSync(testExactDocPath, exactBuffer);
      tempFiles.push(testExactDocPath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testExactDocPath },
      });

      expect(result.success).toBe(true);
      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
    });

    it('should detect SVG as image type', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testSvgPath = path.join(os.tmpdir(), `test_adapter_svg_${Date.now()}.svg`);
      fs.writeFileSync(testSvgPath, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
      tempFiles.push(testSvgPath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testSvgPath },
      });

      expect(result.success).toBe(true);
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
      expect(mocks.fileCreateMock).not.toHaveBeenCalled();
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

  describe('video file upload — Issue #2265', () => {
    const tempFiles: string[] = [];

    afterAll(() => {
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    });

    it('should upload mp4 as file_type:mp4 and send via video path', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testMp4Path = path.join(os.tmpdir(), `test_adapter_video_${Date.now()}.mp4`);
      fs.writeFileSync(testMp4Path, Buffer.from('fake mp4 content'));
      tempFiles.push(testMp4Path);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testMp4Path, name: 'video.mp4' },
      });

      expect(result.success).toBe(true);
      // Should upload via file.create with file_type:'mp4'
      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
      const fileCallData = mocks.fileCreateMock.mock.calls[0][0].data;
      expect(fileCallData.file_type).toBe('mp4');

      // In test env without ffmpeg, it falls back to 'file' msg_type
      // or if cover extraction works, uses 'media' msg_type
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(mocks.replyMock).not.toHaveBeenCalled();
    });

    it('should upload mov file via video path', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testMovPath = path.join(os.tmpdir(), `test_adapter_video_${Date.now()}.mov`);
      fs.writeFileSync(testMovPath, Buffer.from('fake mov content'));
      tempFiles.push(testMovPath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'file', path: testMovPath, name: 'video.mov' },
      });

      expect(result.success).toBe(true);
      expect(mocks.fileCreateMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Issue #2951: Auto-translate local image paths in cards ──────────

  describe('isLocalImagePath — Issue #2951', () => {
    // Import the helper for direct testing
    let isLocalImagePath: (value: string) => boolean;

    beforeAll(async () => {
      const mod = await import('./feishu-adapter.js');
      ({ isLocalImagePath } = mod);
    });

    it('should detect absolute Unix paths', () => {
      expect(isLocalImagePath('/tmp/chart.png')).toBe(true);
      expect(isLocalImagePath('/home/user/image.jpg')).toBe(true);
    });

    it('should detect relative paths', () => {
      expect(isLocalImagePath('./chart.png')).toBe(true);
      expect(isLocalImagePath('../images/photo.jpeg')).toBe(true);
    });

    it('should detect bare filenames with image extensions', () => {
      expect(isLocalImagePath('chart.png')).toBe(true);
      expect(isLocalImagePath('photo.jpg')).toBe(true);
      expect(isLocalImagePath('image.webp')).toBe(true);
    });

    it('should NOT detect Feishu image_keys', () => {
      expect(isLocalImagePath('img_v3_02ab_xxxx')).toBe(false);
      expect(isLocalImagePath('img_v2_abc123')).toBe(false);
    });

    it('should NOT detect HTTP URLs', () => {
      expect(isLocalImagePath('https://example.com/image.png')).toBe(false);
      expect(isLocalImagePath('http://cdn.example.com/chart.jpg')).toBe(false);
    });

    it('should NOT detect non-image extensions', () => {
      expect(isLocalImagePath('document.pdf')).toBe(false);
      expect(isLocalImagePath('data.csv')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isLocalImagePath('')).toBe(false);
      expect(isLocalImagePath('no_extension')).toBe(false);
    });
  });

  describe('card image path resolution — Issue #2951', () => {
    const tempFiles: string[] = [];

    afterAll(() => {
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    });

    it('should upload local image in card section and replace with image_key', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testImagePath = path.join(os.tmpdir(), `test_card_img_${Date.now()}.png`);
      fs.writeFileSync(testImagePath, Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
        'hex',
      ));
      tempFiles.push(testImagePath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Test Card',
          sections: [
            { type: 'text', content: 'Here is an image:' },
            { type: 'image', imageUrl: testImagePath },
          ],
        },
      });

      expect(result.success).toBe(true);
      // Image should have been uploaded
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
      // The card should have been sent via message.create
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      // Verify the sent content contains the uploaded image_key
      const sentContent = JSON.parse(mocks.createMock.mock.calls[0][0].data.content);
      const imgElement = sentContent.elements.find((el: any) => el.tag === 'img');
      expect(imgElement.img_key).toBe('img_key_001');
    });

    it('should NOT upload non-local image URLs (pass through as-is)', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Test Card',
          sections: [
            { type: 'image', imageUrl: 'img_v3_02ab_xxxx' },
          ],
        },
      });

      expect(result.success).toBe(true);
      // No upload should happen for Feishu image_keys
      expect(mocks.imageCreateMock).not.toHaveBeenCalled();
      const sentContent = JSON.parse(mocks.createMock.mock.calls[0][0].data.content);
      const imgElement = sentContent.elements.find((el: any) => el.tag === 'img');
      expect(imgElement.img_key).toBe('img_v3_02ab_xxxx');
    });

    it('should convert missing image to text placeholder', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Test Card',
          sections: [
            { type: 'image', imageUrl: '/nonexistent/image.png' },
          ],
        },
      });

      expect(result.success).toBe(true);
      // No upload attempt for missing files
      expect(mocks.imageCreateMock).not.toHaveBeenCalled();
      // Verify placeholder text is in the card
      const sentContent = JSON.parse(mocks.createMock.mock.calls[0][0].data.content);
      const textElement = sentContent.elements.find((el: any) => el.tag === 'div');
      expect(textElement.text.content).toContain('Image not found');
    });

    it('should handle image upload failure gracefully', async () => {
      const { client, mocks } = createMockClient();
      mocks.imageCreateMock.mockResolvedValueOnce({ image_key: undefined });
      const adapter = createTestAdapter(client);

      const testImagePath = path.join(os.tmpdir(), `test_card_fail_${Date.now()}.png`);
      fs.writeFileSync(testImagePath, Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000a49444154789c62000100000500010d0a2db40000000049454e44ae426082',
        'hex',
      ));
      tempFiles.push(testImagePath);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Test Card',
          sections: [
            { type: 'image', imageUrl: testImagePath },
          ],
        },
      });

      expect(result.success).toBe(true);
      const sentContent = JSON.parse(mocks.createMock.mock.calls[0][0].data.content);
      const textElement = sentContent.elements.find((el: any) => el.tag === 'div');
      expect(textElement.text.content).toContain('Image upload failed');
    });

    it('should handle multiple images in one card', async () => {
      const { client, mocks } = createMockClient();
      // Return different image_keys for each upload
      mocks.imageCreateMock
        .mockResolvedValueOnce({ image_key: 'img_key_alpha' })
        .mockResolvedValueOnce({ image_key: 'img_key_beta' });
      const adapter = createTestAdapter(client);

      const testImage1 = path.join(os.tmpdir(), `test_card_multi1_${Date.now()}.png`);
      const testImage2 = path.join(os.tmpdir(), `test_card_multi2_${Date.now()}.jpg`);
      fs.writeFileSync(testImage1, Buffer.from('89504e470d0a1a0a', 'hex'));
      fs.writeFileSync(testImage2, Buffer.from('ffd8ffe0', 'hex'));
      tempFiles.push(testImage1, testImage2);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Multi Image Card',
          sections: [
            { type: 'image', imageUrl: testImage1 },
            { type: 'text', content: 'separator' },
            { type: 'image', imageUrl: testImage2 },
          ],
        },
      });

      expect(result.success).toBe(true);
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(2);
      const sentContent = JSON.parse(mocks.createMock.mock.calls[0][0].data.content);
      const imgElements = sentContent.elements.filter((el: any) => el.tag === 'img');
      expect(imgElements).toHaveLength(2);
      expect(imgElements[0].img_key).toBe('img_key_alpha');
      expect(imgElements[1].img_key).toBe('img_key_beta');
    });

    it('should resolve image paths in card update (patch)', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const testImagePath = path.join(os.tmpdir(), `test_card_update_${Date.now()}.png`);
      fs.writeFileSync(testImagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
      tempFiles.push(testImagePath);

      const patchMock = vi.fn().mockResolvedValue({});
      (client.im.message as any).patch = patchMock;

      const result = await adapter.update('msg_001', {
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Updated Card',
          sections: [
            { type: 'image', imageUrl: testImagePath },
          ],
        },
      });

      expect(result.success).toBe(true);
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
      expect(patchMock).toHaveBeenCalledTimes(1);
      // Verify patched content has image_key
      const patchedContent = JSON.parse(patchMock.mock.calls[0][0].data.content);
      const imgElement = patchedContent.elements.find((el: any) => el.tag === 'img');
      expect(imgElement.img_key).toBe('img_key_001');
    });
  });

  describe('markdown image path resolution — Issue #2951', () => {
    let fileCounter = 0;

    beforeEach(() => { fileCounter++; });

    // Note: temp files are intentionally NOT cleaned up in this block.
    // The mock's createReadStream drains asynchronously after the test,
    // so deleting files immediately causes unhandled ENOENT errors.
    // Files in /tmp will be cleaned by the OS.

    it('should upload local images referenced in markdown and replace paths', async () => {
      const { client, mocks } = createMockClient();
      mocks.imageCreateMock.mockResolvedValueOnce({ image_key: 'img_md_key_001' });
      const adapter = createTestAdapter(client);

      const testImagePath = path.join(os.tmpdir(), `test_md_img_${Date.now()}_${fileCounter}.png`);
      fs.writeFileSync(testImagePath, Buffer.from('89504e470d0a1a0a', 'hex'));

      const result = await adapter.send({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Markdown Card',
          sections: [
            { type: 'markdown', content: `Here is a chart:\n\n![Chart](${testImagePath})\n\nEnd.` },
          ],
        },
      });

      expect(result.success).toBe(true);
      expect(mocks.imageCreateMock).toHaveBeenCalledTimes(1);
      // Verify the markdown content has been updated with image_key
      const sentContent = JSON.parse(mocks.createMock.mock.calls[0][0].data.content);
      const mdElement = sentContent.elements.find((el: any) => el.tag === 'markdown');
      expect(mdElement.content).toContain('img_md_key_001');
      expect(mdElement.content).not.toContain(testImagePath);
    });

    it('should NOT modify HTTP URLs in markdown images', async () => {
      const { client, mocks } = createMockClient();
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'URL Card',
          sections: [
            { type: 'markdown', content: '![Chart](https://example.com/chart.png)' },
          ],
        },
      });

      expect(result.success).toBe(true);
      expect(mocks.imageCreateMock).not.toHaveBeenCalled();
      const sentContent = JSON.parse(mocks.createMock.mock.calls[0][0].data.content);
      const mdElement = sentContent.elements.find((el: any) => el.tag === 'markdown');
      expect(mdElement.content).toBe('![Chart](https://example.com/chart.png)');
    });

    it('should keep original path when markdown image upload fails', async () => {
      const { client, mocks } = createMockClient();
      mocks.imageCreateMock.mockRejectedValueOnce(new Error('Upload failed'));
      const adapter = createTestAdapter(client);

      const testImagePath = path.join(os.tmpdir(), `test_md_fail_${Date.now()}_${fileCounter}.png`);
      fs.writeFileSync(testImagePath, Buffer.from('89504e470d0a1a0a', 'hex'));

      const result = await adapter.send({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Fail Card',
          sections: [
            { type: 'markdown', content: `![Chart](${testImagePath})` },
          ],
        },
      });

      expect(result.success).toBe(true);
      const sentContent = JSON.parse(mocks.createMock.mock.calls[0][0].data.content);
      const mdElement = sentContent.elements.find((el: any) => el.tag === 'markdown');
      // Original path should be kept when upload fails
      expect(mdElement.content).toContain(testImagePath);
    });
  });
});
