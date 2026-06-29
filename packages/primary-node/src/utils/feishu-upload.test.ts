/**
 * Tests for shared Feishu file upload utilities.
 *
 * Issue #4132: Deduplicate Feishu file upload logic.
 *
 * Tests cover:
 * - IMAGE_EXTENSIONS membership (incl. explicit .svg exclusion — Feishu image API rejects it)
 * - EXT_TO_FEISHU_FILE_TYPE mapping (and fallback to 'stream' handled by callers)
 * - MAX_IMAGE_SIZE / MAX_FILE_SIZE constants
 * - uploadImage: success path, request shape, missing image_key, error propagation
 * - uploadFile: success path, request shape, missing file_key, error propagation
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IMAGE_EXTENSIONS,
  EXT_TO_FEISHU_FILE_TYPE,
  MAX_IMAGE_SIZE,
  MAX_FILE_SIZE,
  uploadImage,
  uploadFile,
} from './feishu-upload.js';

type CreateMock = ReturnType<typeof vi.fn>;

/**
 * Drain a read stream so its underlying file is fully opened and closed
 * before the test's afterEach deletes the temp file. Without this, the SDK
 * mock resolves instantly and the stream's lazy open fires after deletion,
 * producing spurious ENOENT errors.
 */
function consumeStream(stream: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = stream as {
      on?: (e: string, cb: (arg?: unknown) => void) => void;
      resume?: () => void;
    };
    if (!s.on) {
      resolve();
      return;
    }
    s.on('error', reject);
    s.on('end', () => resolve());
    s.on('close', () => resolve());
    s.resume?.();
  });
}

interface MockClient {
  im: {
    image: { create: CreateMock };
    file: { create: CreateMock };
  };
}

function createMockClient(): MockClient {
  return {
    im: {
      image: { create: vi.fn() },
      file: { create: vi.fn() },
    },
  };
}

describe('feishu-upload constants', () => {
  describe('IMAGE_EXTENSIONS', () => {
    it('recognizes common image extensions', () => {
      for (const ext of [
        '.jpg',
        '.jpeg',
        '.png',
        '.webp',
        '.gif',
        '.tiff',
        '.bmp',
        '.ico',
      ]) {
        expect(IMAGE_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it('excludes .svg (Feishu im.image.create rejects it → routed to file upload)', () => {
      // Feishu's image API accepts only png/jpg/jpeg/webp/gif/tiff/bmp/ico.
      // SVG must fall through to im.file.create ('stream') to upload successfully.
      expect(IMAGE_EXTENSIONS.has('.svg')).toBe(false);
    });

    it('rejects non-image extensions', () => {
      expect(IMAGE_EXTENSIONS.has('.pdf')).toBe(false);
      expect(IMAGE_EXTENSIONS.has('.mp4')).toBe(false);
      expect(IMAGE_EXTENSIONS.has('.docx')).toBe(false);
    });

    it('is case-sensitive lowercase (matches the lowercased ext produced by callers)', () => {
      expect(IMAGE_EXTENSIONS.has('.PNG')).toBe(false);
      expect(IMAGE_EXTENSIONS.has('.png')).toBe(true);
    });
  });

  describe('EXT_TO_FEISHU_FILE_TYPE', () => {
    it('maps document extensions to the correct Feishu file_type', () => {
      expect(EXT_TO_FEISHU_FILE_TYPE['.opus']).toBe('opus');
      expect(EXT_TO_FEISHU_FILE_TYPE['.pdf']).toBe('pdf');
      expect(EXT_TO_FEISHU_FILE_TYPE['.doc']).toBe('doc');
      expect(EXT_TO_FEISHU_FILE_TYPE['.docx']).toBe('doc');
      expect(EXT_TO_FEISHU_FILE_TYPE['.xls']).toBe('xls');
      expect(EXT_TO_FEISHU_FILE_TYPE['.xlsx']).toBe('xls');
      expect(EXT_TO_FEISHU_FILE_TYPE['.csv']).toBe('xls');
      expect(EXT_TO_FEISHU_FILE_TYPE['.ppt']).toBe('ppt');
      expect(EXT_TO_FEISHU_FILE_TYPE['.pptx']).toBe('ppt');
    });

    it('returns undefined for unmapped extensions (callers fall back to "stream")', () => {
      expect(EXT_TO_FEISHU_FILE_TYPE['.zip']).toBeUndefined();
      expect(EXT_TO_FEISHU_FILE_TYPE['.mp3']).toBeUndefined();
    });
  });

  it('exposes the documented size limits', () => {
    expect(MAX_IMAGE_SIZE).toBe(10 * 1024 * 1024);
    expect(MAX_FILE_SIZE).toBe(30 * 1024 * 1024);
    expect(MAX_FILE_SIZE).toBeGreaterThan(MAX_IMAGE_SIZE);
  });
});

describe('uploadImage', () => {
  let client: MockClient;
  let tmpFile: string;

  beforeEach(() => {
    client = createMockClient();
    tmpFile = path.join(os.tmpdir(), `feishu-upload-img-${process.pid}-${Date.now()}.png`);
    fs.writeFileSync(tmpFile, Buffer.from('not-a-real-png'));
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it('calls im.image.create with image_type "message" and a read stream, returns image_key', async () => {
    client.im.image.create.mockImplementation(async (opts: any) => {
      await consumeStream(opts.data.image);
      return { image_key: 'img_v3_001' };
    });

    const imageKey = await uploadImage(client as any, tmpFile);

    expect(client.im.image.create).toHaveBeenCalledTimes(1);
    expect(client.im.image.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        image_type: 'message',
        image: expect.any(fs.ReadStream),
      }),
    });
    expect(imageKey).toBe('img_v3_001');
  });

  it('returns undefined when the response has no image_key', async () => {
    client.im.image.create.mockImplementation(async (opts: any) => {
      await consumeStream(opts.data.image);
      return { image_key: undefined };
    });

    const imageKey = await uploadImage(client as any, tmpFile);

    expect(imageKey).toBeUndefined();
  });

  it('propagates errors thrown by im.image.create', async () => {
    const err = new Error('image upload failed');
    client.im.image.create.mockImplementation(async (opts: any) => {
      await consumeStream(opts.data.image);
      throw err;
    });

    await expect(uploadImage(client as any, tmpFile)).rejects.toBe(err);
  });
});

describe('uploadFile', () => {
  let client: MockClient;
  let tmpFile: string;

  beforeEach(() => {
    client = createMockClient();
    tmpFile = path.join(os.tmpdir(), `feishu-upload-doc-${process.pid}-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, Buffer.from('not-a-real-pdf'));
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it('calls im.file.create with file_type/file_name/file, returns file_key', async () => {
    client.im.file.create.mockImplementation(async (opts: any) => {
      await consumeStream(opts.data.file);
      return { file_key: 'file_v3_001' };
    });

    const fileKey = await uploadFile(client as any, tmpFile, 'report.pdf', 'pdf');

    expect(client.im.file.create).toHaveBeenCalledTimes(1);
    expect(client.im.file.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        file_type: 'pdf',
        file_name: 'report.pdf',
        file: expect.any(fs.ReadStream),
      }),
    });
    expect(fileKey).toBe('file_v3_001');
  });

  it('passes through arbitrary file_type values (e.g. "stream", "mp4")', async () => {
    client.im.file.create.mockImplementation(async (opts: any) => {
      await consumeStream(opts.data.file);
      return { file_key: 'file_v3_002' };
    });

    await uploadFile(client as any, tmpFile, 'clip.mp4', 'mp4');
    expect(client.im.file.create.mock.calls[0][0].data.file_type).toBe('mp4');

    await uploadFile(client as any, tmpFile, 'archive.zip', 'stream');
    expect(client.im.file.create.mock.calls[1][0].data.file_type).toBe('stream');
  });

  it('returns undefined when the response has no file_key', async () => {
    client.im.file.create.mockImplementation(async (opts: any) => {
      await consumeStream(opts.data.file);
      return { file_key: undefined };
    });

    const fileKey = await uploadFile(client as any, tmpFile, 'report.pdf', 'pdf');

    expect(fileKey).toBeUndefined();
  });

  it('propagates errors thrown by im.file.create', async () => {
    const err = new Error('file upload failed');
    client.im.file.create.mockImplementation(async (opts: any) => {
      await consumeStream(opts.data.file);
      throw err;
    });

    await expect(uploadFile(client as any, tmpFile, 'report.pdf', 'pdf')).rejects.toBe(err);
  });
});
