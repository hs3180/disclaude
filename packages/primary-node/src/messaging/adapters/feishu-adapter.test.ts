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
      const adapter = new FeishuAdapter();
      expect(adapter.canHandle('oc_123')).toBe(true);
    });

    it('should handle ou_ prefixed chatIds', () => {
      const adapter = new FeishuAdapter();
      expect(adapter.canHandle('ou_456')).toBe(true);
    });

    it('should handle on_ prefixed chatIds (bot)', () => {
      const adapter = new FeishuAdapter();
      expect(adapter.canHandle('on_bot123')).toBe(true);
    });

    it('should not handle non-Feishu chatIds', () => {
      const adapter = new FeishuAdapter();
      expect(adapter.canHandle('rest_123')).toBe(false);
      expect(adapter.canHandle('cli_123')).toBe(false);
      expect(adapter.canHandle('abc')).toBe(false);
      expect(adapter.canHandle('')).toBe(false);
    });
  });

  describe('convert() — text content', () => {
    it('should convert text content to Feishu text message', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello World' },
      }) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('text');
      expect(JSON.parse(result.content)).toEqual({ text: 'Hello World' });
    });
  });

  describe('convert() — markdown content', () => {
    it('should convert markdown content to Feishu interactive card', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: { type: 'markdown', text: '**bold text**' },
      }) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('interactive');
      const parsed = JSON.parse(result.content);
      expect(parsed.config.wide_screen_mode).toBe(true);
      expect(parsed.elements).toHaveLength(1);
      expect(parsed.elements[0].tag).toBe('markdown');
      expect(parsed.elements[0].content).toBe('**bold text**');
    });
  });

  describe('convert() — done content', () => {
    it('should convert done content with success=true', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: { type: 'done', success: true, message: 'All done' },
      }) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('text');
      const parsed = JSON.parse(result.content);
      expect(parsed.text).toContain('✅');
      expect(parsed.text).toContain('All done');
    });

    it('should convert done content with success=false', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: { type: 'done', success: false, error: 'Something broke' },
      }) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('text');
      const parsed = JSON.parse(result.content);
      expect(parsed.text).toContain('❌');
      expect(parsed.text).toContain('Something broke');
    });

    it('should use default messages when message/error not provided', () => {
      const adapter = new FeishuAdapter();

      const successResult = adapter.convert({
        chatId: 'oc_123',
        content: { type: 'done', success: true },
      }) as { msg_type: string; content: string };
      expect(JSON.parse(successResult.content).text).toContain('Task completed');

      const failResult = adapter.convert({
        chatId: 'oc_123',
        content: { type: 'done', success: false },
      }) as { msg_type: string; content: string };
      expect(JSON.parse(failResult.content).text).toContain('Task failed');
    });
  });

  describe('convert() — card content', () => {
    it('should convert card with text section', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Test Card',
          sections: [{ type: 'text', content: 'Hello section' }],
        },
      }) as { msg_type: string; content: string };

      expect(result.msg_type).toBe('interactive');
      const parsed = JSON.parse(result.content);
      expect(parsed.header.title.content).toBe('Test Card');
      expect(parsed.header.title.tag).toBe('plain_text');
      expect(parsed.header.template).toBe('blue');
      expect(parsed.elements[0].tag).toBe('div');
      expect(parsed.elements[0].text.tag).toBe('plain_text');
      expect(parsed.elements[0].text.content).toBe('Hello section');
    });

    it('should convert card with markdown section', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'MD Card',
          sections: [{ type: 'markdown', content: '**bold** text' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.elements[0].tag).toBe('markdown');
      expect(parsed.elements[0].content).toBe('**bold** text');
    });

    it('should convert card with divider section', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Divider',
          sections: [{ type: 'divider' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.elements[0].tag).toBe('hr');
    });

    it('should convert card with fields section', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Fields',
          sections: [{
            type: 'fields',
            fields: [
              { label: 'Name', value: 'Alice' },
              { label: 'Age', value: '30' },
            ],
          }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      const [field] = parsed.elements;
      expect(field.tag).toBe('div');
      expect(field.fields).toHaveLength(2);
      expect(field.fields[0].is_short).toBe(true);
      expect(field.fields[0].text.tag).toBe('lark_md');
      expect(field.fields[0].text.content).toBe('**Name**\nAlice');
      expect(field.fields[1].text.content).toBe('**Age**\n30');
    });

    it('should filter out fields section with empty fields', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Empty Fields',
          sections: [{ type: 'fields', fields: [] }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.elements).toHaveLength(0);
    });

    it('should convert card with image section', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Image',
          sections: [{ type: 'image', imageUrl: 'img_v3_abc123' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.elements[0].tag).toBe('img');
      expect(parsed.elements[0].img_key).toBe('img_v3_abc123');
      expect(parsed.elements[0].alt.tag).toBe('plain_text');
    });

    it('should filter out unknown section types', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Unknown',
          sections: [{ type: 'unknown_type' as any }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.elements).toHaveLength(0);
    });

    it('should handle null/empty content in text and markdown sections', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Empty',
          sections: [
            { type: 'text', content: '' },
            { type: 'markdown', content: '' },
          ],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.elements[0].text.content).toBe('');
      expect(parsed.elements[1].content).toBe('');
    });
  });

  describe('convert() — card themes', () => {
    it('should use specified theme when valid', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Themed',
          theme: 'red',
          sections: [],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.header.template).toBe('red');
    });

    it('should default to blue theme when not specified', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Default Theme',
          sections: [],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.header.template).toBe('blue');
    });

    it('should default to blue theme when unknown theme provided', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Unknown Theme',
          theme: 'nonexistent',
          sections: [],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.header.template).toBe('blue');
    });
  });

  describe('convert() — card subtitle', () => {
    it('should include subtitle when provided', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'With Subtitle',
          subtitle: 'A subtitle',
          sections: [],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.header.subtitle.content).toBe('A subtitle');
      expect(parsed.header.subtitle.tag).toBe('plain_text');
    });

    it('should not include subtitle when not provided', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'No Subtitle',
          sections: [],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.header.subtitle).toBeUndefined();
    });
  });

  describe('convert() — card actions', () => {
    it('should convert button action with primary style', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Actions',
          sections: [],
          actions: [{ type: 'button', label: 'Click Me', value: 'btn1', style: 'primary' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link.tag).toBe('button');
      expect(parsed.card_link.text.content).toBe('Click Me');
      expect(parsed.card_link.value).toEqual({ action: 'btn1' });
      expect(parsed.card_link.type).toBe('primary');
    });

    it('should convert button action with secondary style', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Actions',
          sections: [],
          actions: [{ type: 'button', label: 'Secondary', value: 'btn2', style: 'secondary' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link.type).toBe('default');
    });

    it('should convert button action with danger style', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Actions',
          sections: [],
          actions: [{ type: 'button', label: 'Delete', value: 'del', style: 'danger' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link.type).toBe('danger');
    });

    it('should default button style to primary when style not provided', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Actions',
          sections: [],
          actions: [{ type: 'button', label: 'Default', value: 'def' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link.type).toBe('primary');
    });

    it('should convert select action with options', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Select',
          sections: [],
          actions: [{
            type: 'select',
            label: 'Choose one',
            value: 'sel',
            options: [
              { label: 'Option A', value: 'a' },
              { label: 'Option B', value: 'b' },
            ],
          }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      const action = parsed.card_link;
      expect(action.tag).toBe('select_static');
      expect(action.placeholder.content).toBe('Choose one');
      expect(action.options).toHaveLength(2);
      expect(action.options[0].text.content).toBe('Option A');
      expect(action.options[0].value).toBe('a');
    });

    it('should convert select action with empty options', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Empty Select',
          sections: [],
          actions: [{ type: 'select', label: 'Pick', value: 's', options: [] }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link.options).toEqual([]);
    });

    it('should convert link action', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Link',
          sections: [],
          actions: [{ type: 'link', label: 'Visit', value: 'lnk', url: 'https://example.com' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link.tag).toBe('action');
      expect(parsed.card_link.actions[0].tag).toBe('button');
      expect(parsed.card_link.actions[0].url).toBe('https://example.com');
      expect(parsed.card_link.actions[0].text.content).toBe('Visit');
    });

    it('should set card_link to first action when multiple actions present', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Multi',
          sections: [],
          actions: [
            { type: 'button', label: 'First', value: 'v1', style: 'primary' },
            { type: 'button', label: 'Second', value: 'v2', style: 'danger' },
          ],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link.text.content).toBe('First');
    });

    it('should not set card_link when actions are empty', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'No Actions',
          sections: [],
          actions: [],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link).toBeUndefined();
    });

    it('should handle unknown action type as default button', () => {
      const adapter = new FeishuAdapter();
      const result = adapter.convert({
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Unknown Action',
          sections: [],
          actions: [{ type: 'custom' as any, label: 'Custom', value: 'c' }],
        },
      }) as { msg_type: string; content: string };

      const parsed = JSON.parse(result.content);
      expect(parsed.card_link.tag).toBe('button');
      expect(parsed.card_link.text.content).toBe('Custom');
      expect(parsed.card_link.value).toEqual({ action: 'c' });
    });
  });

  describe('convert() — unknown content type', () => {
    it('should throw for unknown content type', () => {
      const adapter = new FeishuAdapter();
      expect(() =>
        adapter.convert({
          chatId: 'oc_123',
          content: { type: 'audio' } as any,
        }),
      ).toThrow('Unsupported content type: audio');
    });
  });

  describe('update()', () => {
    it('should return success when updating card message', async () => {
      const { client } = createMockClient();
      const patchMock = vi.fn().mockResolvedValue({});
      (client.im.message as any).patch = patchMock;
      const adapter = createTestAdapter(client);

      const result = await adapter.update('msg_001', {
        chatId: 'oc_123',
        content: {
          type: 'card',
          title: 'Updated',
          sections: [{ type: 'text', content: 'New text' }],
        },
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg_001');
      expect(patchMock).toHaveBeenCalledTimes(1);
    });

    it('should reject non-card content type', async () => {
      const { client } = createMockClient();
      const adapter = createTestAdapter(client);

      const result = await adapter.update('msg_001', {
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Only card messages can be updated');
    });

    it('should return error when client throws', async () => {
      const { client } = createMockClient();
      const patchMock = vi.fn().mockRejectedValue(new Error('API error'));
      (client.im.message as any).patch = patchMock;
      const adapter = createTestAdapter(client);

      const result = await adapter.update('msg_001', {
        chatId: 'oc_123',
        content: { type: 'card', title: 'Test', sections: [] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });

    it('should return error when no client is configured', async () => {
      const adapter = new FeishuAdapter();

      const result = await adapter.update('msg_001', {
        chatId: 'oc_123',
        content: { type: 'card', title: 'Test', sections: [] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('client provider');
    });
  });

  describe('send() — error handling', () => {
    it('should catch error when no client is configured', async () => {
      const adapter = new FeishuAdapter();

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('client provider');
    });

    it('should catch create API errors', async () => {
      const { client, mocks } = createMockClient();
      mocks.createMock.mockRejectedValueOnce(new Error('Network error'));
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should catch reply API errors', async () => {
      const { client, mocks } = createMockClient();
      mocks.replyMock.mockRejectedValueOnce(new Error('Reply failed'));
      const adapter = createTestAdapter(client);

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello' },
        threadId: 'root_msg_456',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Reply failed');
    });
  });

  describe('constructor and client provider', () => {
    it('should accept clientProvider via constructor', () => {
      const mockClient = { im: { message: { create: vi.fn() } } };
      const provider = { getClient: vi.fn().mockReturnValue(mockClient) };
      const adapter = new FeishuAdapter({ clientProvider: provider as any });
      expect(adapter.name).toBe('feishu');
    });

    it('should create adapter with no options', () => {
      const adapter = new FeishuAdapter();
      expect(adapter.name).toBe('feishu');
      expect(adapter.capabilities.supportsCard).toBe(true);
      expect(adapter.capabilities.supportsThread).toBe(true);
      expect(adapter.capabilities.supportsFile).toBe(true);
    });

    it('should use clientProvider when sending', async () => {
      const { client } = createMockClient();
      const provider = { getClient: vi.fn().mockReturnValue(client) };
      const adapter = new FeishuAdapter({ clientProvider: provider as any });

      const result = await adapter.send({
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello' },
      });

      expect(provider.getClient).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('createFeishuAdapter factory should return adapter instance', async () => {
      const { createFeishuAdapter } = await import('./feishu-adapter.js');
      const adapter = createFeishuAdapter();
      expect(adapter).toBeInstanceOf(FeishuAdapter);
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
});
