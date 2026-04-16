/**
 * Tests for file utility functions.
 *
 * Issue #1637: File extension detection for uploaded images.
 * Enhancement: headers-based detection, SVG optimization, async path-based API.
 *
 * All tests are pure — no file system side effects.
 * The ensureFileExtensionFromPath tests mock fs/promises to verify
 * I/O behavior without touching the disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectFileExtension,
  mimeToExtension,
  getContentTypeFromHeaders,
  ensureFileExtension,
  ensureFileExtensionFromPath,
  fsOps,
} from './file-utils.js';

describe('detectFileExtension', () => {
  it('should detect PNG from magic bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.png');
  });

  it('should detect JPEG from magic bytes', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    expect(detectFileExtension(buffer)).toBe('.jpg');
  });

  it('should detect GIF from magic bytes (GIF87a)', () => {
    expect(detectFileExtension(Buffer.from('GIF87a', 'ascii'))).toBe('.gif');
  });

  it('should detect GIF from magic bytes (GIF89a)', () => {
    expect(detectFileExtension(Buffer.from('GIF89a', 'ascii'))).toBe('.gif');
  });

  it('should detect WebP from magic bytes', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectFileExtension(buffer)).toBe('.webp');
  });

  it('should detect BMP from magic bytes', () => {
    expect(detectFileExtension(Buffer.from([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00]))).toBe('.bmp');
  });

  it('should detect PDF from magic bytes', () => {
    expect(detectFileExtension(Buffer.from('%PDF-1.4', 'ascii'))).toBe('.pdf');
  });

  it('should detect ZIP from magic bytes', () => {
    expect(detectFileExtension(Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]))).toBe('.zip');
  });

  it('should detect TIFF (little-endian) from magic bytes', () => {
    expect(detectFileExtension(Buffer.from([0x49, 0x49, 0x2A, 0x00]))).toBe('.tiff');
  });

  it('should detect TIFF (big-endian) from magic bytes', () => {
    expect(detectFileExtension(Buffer.from([0x4D, 0x4D, 0x00, 0x2A]))).toBe('.tiff');
  });

  it('should detect SVG from XML declaration', () => {
    const buffer = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg">', 'utf-8');
    expect(detectFileExtension(buffer)).toBe('.svg');
  });

  it('should detect SVG from <svg tag', () => {
    expect(detectFileExtension(Buffer.from('<svg width="100" height="100">', 'utf-8'))).toBe('.svg');
  });

  // Enhancement: SVG detection only uses first 100 bytes
  it('should detect SVG even with long content (100-byte optimization)', () => {
    const content = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">'.concat('x'.repeat(200));
    expect(detectFileExtension(Buffer.from(content, 'utf-8'))).toBe('.svg');
  });

  it('should return undefined for unrecognized format', () => {
    expect(detectFileExtension(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))).toBeUndefined();
  });

  it('should return undefined for empty buffer', () => {
    expect(detectFileExtension(Buffer.alloc(0))).toBeUndefined();
  });

  it('should return undefined for too-short buffer', () => {
    expect(detectFileExtension(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });

  // Issue #1966: Audio format detection tests
  it('should detect MP3 from ID3v2 header', () => {
    const buffer = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.mp3');
  });

  it('should detect MP3 from sync word (without ID3)', () => {
    const buffer = Buffer.from([0xFF, 0xFB, 0x90, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.mp3');
  });

  it('should detect MP3 from F3 sync word variant', () => {
    const buffer = Buffer.from([0xFF, 0xF3, 0x90, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.mp3');
  });

  it('should detect WAV from RIFF...WAVE header', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(detectFileExtension(buffer)).toBe('.wav');
  });

  it('should detect OGG from OggS header', () => {
    const buffer = Buffer.from([0x4F, 0x67, 0x67, 0x53, 0x00, 0x00, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.ogg');
  });

  it('should detect FLAC from fLaC header', () => {
    const buffer = Buffer.from([0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.flac');
  });

  it('should detect M4A from ftyp box with M4A brand', () => {
    const buffer = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41, 0x20,
    ]);
    expect(detectFileExtension(buffer)).toBe('.m4a');
  });

  // Issue #2411: Video format detection tests
  it('should detect MOV from ftyp box with qt brand', () => {
    // QuickTime MOV: ftyp + "qt  " brand
    const buffer = Buffer.from([
      0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
    ]);
    expect(detectFileExtension(buffer)).toBe('.mov');
  });

  it('should detect MP4 from ftyp box with isom brand', () => {
    const buffer = Buffer.from([
      0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D,
    ]);
    expect(detectFileExtension(buffer)).toBe('.mp4');
  });

  it('should detect MP4 from ftyp box with mp42 brand', () => {
    const buffer = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32,
    ]);
    expect(detectFileExtension(buffer)).toBe('.mp4');
  });

  it('should detect MP4 from ftyp box with avc1 brand', () => {
    const buffer = Buffer.from([
      0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x63, 0x31,
    ]);
    expect(detectFileExtension(buffer)).toBe('.mp4');
  });

  it('should detect M4A from ftyp box with mhp1 brand', () => {
    const buffer = Buffer.from([
      0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x68, 0x70, 0x31,
    ]);
    expect(detectFileExtension(buffer)).toBe('.m4a');
  });

  it('should detect MKV from Matroska header', () => {
    const buffer = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x00, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.mkv');
  });

  it('should detect AVI from RIFF...AVI header', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
    ]);
    expect(detectFileExtension(buffer)).toBe('.avi');
  });

  it('should detect FLV from FLV header', () => {
    const buffer = Buffer.from([0x46, 0x4C, 0x56, 0x01, 0x00, 0x00, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.flv');
  });

  it('should detect AMR from #!AMR header', () => {
    const buffer = Buffer.from([0x23, 0x21, 0x41, 0x4D, 0x52, 0x00, 0x00, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.amr');
  });

  it('should detect WMA from ASF header GUID', () => {
    const buffer = Buffer.from([
      0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
    ]);
    expect(detectFileExtension(buffer)).toBe('.wma');
  });

  it('should detect AAC from ADTS header (not matched by MP3 sync word first)', () => {
    // FF F1 has bits 1:0 = 01 (AAC-LC), so (buf[1] & 0x06) !== 0x00 is true
    // This must match AAC, not the MP3 sync word detector which comes after
    const buffer = Buffer.from([0xFF, 0xF1, 0x90, 0x00]);
    expect(detectFileExtension(buffer)).toBe('.aac');
  });
});

describe('mimeToExtension', () => {
  it('should map image/png to .png', () => {
    expect(mimeToExtension('image/png')).toBe('.png');
  });

  it('should map image/jpeg to .jpg', () => {
    expect(mimeToExtension('image/jpeg')).toBe('.jpg');
  });

  it('should map image/gif to .gif', () => {
    expect(mimeToExtension('image/gif')).toBe('.gif');
  });

  it('should map image/webp to .webp', () => {
    expect(mimeToExtension('image/webp')).toBe('.webp');
  });

  it('should map image/svg+xml to .svg', () => {
    expect(mimeToExtension('image/svg+xml')).toBe('.svg');
  });

  it('should return undefined for unknown MIME type', () => {
    expect(mimeToExtension('application/unknown')).toBeUndefined();
  });

  // Issue #1966: Audio MIME type mapping tests
  it('should map audio/mpeg to .mp3', () => {
    expect(mimeToExtension('audio/mpeg')).toBe('.mp3');
  });

  it('should map audio/mp3 to .mp3', () => {
    expect(mimeToExtension('audio/mp3')).toBe('.mp3');
  });

  it('should map audio/wav to .wav', () => {
    expect(mimeToExtension('audio/wav')).toBe('.wav');
  });

  it('should map audio/ogg to .ogg', () => {
    expect(mimeToExtension('audio/ogg')).toBe('.ogg');
  });

  it('should map audio/x-m4a to .m4a', () => {
    expect(mimeToExtension('audio/x-m4a')).toBe('.m4a');
  });

  it('should map audio/amr to .amr', () => {
    expect(mimeToExtension('audio/amr')).toBe('.amr');
  });

  it('should map audio/flac to .flac', () => {
    expect(mimeToExtension('audio/flac')).toBe('.flac');
  });

  it('should map audio/aac to .aac', () => {
    expect(mimeToExtension('audio/aac')).toBe('.aac');
  });

  // Issue #2411: Video MIME type mapping tests
  it('should map video/mp4 to .mp4', () => {
    expect(mimeToExtension('video/mp4')).toBe('.mp4');
  });

  it('should map video/quicktime to .mov', () => {
    expect(mimeToExtension('video/quicktime')).toBe('.mov');
  });

  it('should map video/webm to .webm', () => {
    expect(mimeToExtension('video/webm')).toBe('.webm');
  });

  it('should map video/x-msvideo to .avi', () => {
    expect(mimeToExtension('video/x-msvideo')).toBe('.avi');
  });

  it('should map video/matroska to .mkv', () => {
    expect(mimeToExtension('video/matroska')).toBe('.mkv');
  });

  it('should map video/x-matroska to .mkv', () => {
    expect(mimeToExtension('video/x-matroska')).toBe('.mkv');
  });

  it('should map video/x-flv to .flv', () => {
    expect(mimeToExtension('video/x-flv')).toBe('.flv');
  });
});

describe('getContentTypeFromHeaders', () => {
  it('extracts content-type from lowercase headers', () => {
    expect(getContentTypeFromHeaders({ 'content-type': 'image/png' })).toBe('image/png');
  });

  it('extracts content-type from mixed-case headers', () => {
    expect(getContentTypeFromHeaders({ 'Content-Type': 'image/jpeg; charset=utf-8' })).toBe('image/jpeg');
  });

  it('strips parameters from content-type', () => {
    expect(getContentTypeFromHeaders({ 'content-type': 'image/gif; boundary=something' })).toBe('image/gif');
  });

  it('returns undefined for undefined headers', () => {
    expect(getContentTypeFromHeaders(undefined)).toBeUndefined();
  });

  it('returns undefined for empty headers', () => {
    expect(getContentTypeFromHeaders({})).toBeUndefined();
  });

  it('returns undefined when content-type is not string', () => {
    expect(getContentTypeFromHeaders({ 'content-type': 123 })).toBeUndefined();
  });
});

describe('ensureFileExtension', () => {
  it('should not modify path if known extension already exists', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(ensureFileExtension('/tmp/photo.png', buffer)).toBe('/tmp/photo.png');
  });

  it('should correct path when unknown extension exists', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(ensureFileExtension('/tmp/photo.dat', buffer)).toBe('/tmp/photo.dat.png');
  });

  it('should append detected extension to extensionless path', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(ensureFileExtension('/tmp/image_v3_abc123', buffer)).toBe('/tmp/image_v3_abc123.png');
  });

  it('should append .jpg for JPEG files without extension', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    expect(ensureFileExtension('/tmp/downloads/image_key', buffer)).toBe('/tmp/downloads/image_key.jpg');
  });

  it('should append .webp for WebP files without extension', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(ensureFileExtension('/tmp/workspace/downloads/img_file', buffer)).toBe('/tmp/workspace/downloads/img_file.webp');
  });

  it('should return original path if extension cannot be detected', () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(ensureFileExtension('/tmp/unknown_file', buffer)).toBe('/tmp/unknown_file');
  });

  it('should handle paths with dots in directory names', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(ensureFileExtension('/tmp/workspace.v2/downloads/image_key', buffer)).toBe('/tmp/workspace.v2/downloads/image_key.png');
  });
});

// Enhancement: ensureFileExtensionFromPath (async, path-based API)
// Uses vi.spyOn on fsOps to intercept file I/O — zero file system side effects
describe('ensureFileExtensionFromPath', () => {
   
  let openSpy: any;
   
  let renameSpy: any;
   
  let copyFileSpy: any;
   
  let unlinkSpy: any;

  beforeEach(() => {
    openSpy = vi.spyOn(fsOps, 'open');
    renameSpy = vi.spyOn(fsOps, 'rename');
    copyFileSpy = vi.spyOn(fsOps, 'copyFile');
    unlinkSpy = vi.spyOn(fsOps, 'unlink');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return original path if file has a known extension', async () => {
    const result = await ensureFileExtensionFromPath('/tmp/photo.png');
    expect(result).toBe('/tmp/photo.png');
    expect(openSpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('should add extension from content-type header without file I/O', async () => {
    renameSpy.mockResolvedValue(undefined);

    const result = await ensureFileExtensionFromPath('/tmp/image_no_ext', { 'content-type': 'image/png' });
    expect(result).toBe('/tmp/image_no_ext.png');
    // Headers detection should skip file I/O entirely
    expect(openSpy).not.toHaveBeenCalled();
    // Should rename via fs.rename
    expect(renameSpy).toHaveBeenCalledWith('/tmp/image_no_ext', '/tmp/image_no_ext.png');
  });

  it('should add extension from content-type with charset parameter', async () => {
    renameSpy.mockResolvedValue(undefined);

    const result = await ensureFileExtensionFromPath('/tmp/image_no_ext', { 'Content-Type': 'image/jpeg; charset=binary' });
    expect(result).toBe('/tmp/image_no_ext.jpg');
    expect(renameSpy).toHaveBeenCalledWith('/tmp/image_no_ext', '/tmp/image_no_ext.jpg');
  });

  it('should fall back to magic bytes when headers are missing', async () => {
    // Mock fsOps.open to return a fake file handle that reads PNG header
    const mockHandle = {
      read: vi.fn().mockImplementation((buf: Buffer, offset: number, _length: number, _position: number) => {
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(buf, offset);
        return Promise.resolve({ bytesRead: 12 });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    openSpy.mockResolvedValue(mockHandle as never);
    renameSpy.mockResolvedValue(undefined);

    const result = await ensureFileExtensionFromPath('/tmp/image_no_ext');
    expect(result).toBe('/tmp/image_no_ext.png');
    expect(openSpy).toHaveBeenCalledWith('/tmp/image_no_ext', 'r');
    expect(mockHandle.read).toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalledWith('/tmp/image_no_ext', '/tmp/image_no_ext.png');
  });

  it('should prefer headers over magic bytes', async () => {
    renameSpy.mockResolvedValue(undefined);

    // With PNG content-type but JPEG magic bytes, headers should win
    openSpy.mockResolvedValue({
      read: vi.fn().mockImplementation((buf: Buffer, offset: number) => {
        Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]).copy(buf, offset);
        return Promise.resolve({ bytesRead: 12 });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    const result = await ensureFileExtensionFromPath('/tmp/image_no_ext', { 'content-type': 'image/png' });
    expect(result).toBe('/tmp/image_no_ext.png');
    // Headers path should have been taken, no magic bytes fallback
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('should fall back to magic bytes when content-type is unknown', async () => {
    openSpy.mockResolvedValue({
      read: vi.fn().mockImplementation((buf: Buffer, offset: number) => {
        Buffer.from('GIF87a').copy(buf, offset);
        return Promise.resolve({ bytesRead: 12 });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    renameSpy.mockResolvedValue(undefined);

    const result = await ensureFileExtensionFromPath('/tmp/image_no_ext', { 'content-type': 'application/unknown' });
    expect(result).toBe('/tmp/image_no_ext.gif');
    expect(openSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalledWith('/tmp/image_no_ext', '/tmp/image_no_ext.gif');
  });

  it('should return original path when extension cannot be determined', async () => {
    // Mock fsOps.open to return unrecognized bytes
    openSpy.mockResolvedValue({
      read: vi.fn().mockImplementation((buf: Buffer, offset: number) => {
        Buffer.from([0x00, 0x01, 0x02, 0x03]).copy(buf, offset);
        return Promise.resolve({ bytesRead: 12 });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    const result = await ensureFileExtensionFromPath('/tmp/unknown_file');
    expect(result).toBe('/tmp/unknown_file');
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('should return original path and not attempt rename when fs.open throws', async () => {
    openSpy.mockRejectedValue(new Error('ENOENT'));

    const result = await ensureFileExtensionFromPath('/tmp/nonexistent');
    expect(result).toBe('/tmp/nonexistent');
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it('should fall back to copy+delete when rename fails', async () => {
    openSpy.mockResolvedValue({
      read: vi.fn().mockImplementation((buf: Buffer, offset: number) => {
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(buf, offset);
        return Promise.resolve({ bytesRead: 12 });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    renameSpy.mockRejectedValue(new Error('EXDEV: cross-device link'));
    copyFileSpy.mockResolvedValue(undefined);
    unlinkSpy.mockResolvedValue(undefined);

    const result = await ensureFileExtensionFromPath('/tmp/image_no_ext');
    expect(result).toBe('/tmp/image_no_ext.png');
    expect(renameSpy).toHaveBeenCalled();
    expect(copyFileSpy).toHaveBeenCalledWith('/tmp/image_no_ext', '/tmp/image_no_ext.png');
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/image_no_ext');
  });

  it('should return original path when both rename and copy+delete fail', async () => {
    openSpy.mockResolvedValue({
      read: vi.fn().mockImplementation((buf: Buffer, offset: number) => {
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(buf, offset);
        return Promise.resolve({ bytesRead: 12 });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    renameSpy.mockRejectedValue(new Error('EXDEV'));
    copyFileSpy.mockRejectedValue(new Error('EACCES'));

    const result = await ensureFileExtensionFromPath('/tmp/image_no_ext');
    expect(result).toBe('/tmp/image_no_ext');
  });

  it('should handle the real Feishu scenario', async () => {
    openSpy.mockResolvedValue({
      read: vi.fn().mockImplementation((buf: Buffer, offset: number) => {
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(buf, offset);
        return Promise.resolve({ bytesRead: 12 });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    renameSpy.mockResolvedValue(undefined);

    const result = await ensureFileExtensionFromPath(
      '/tmp/image_img_v3_02104_b73cd122-662d-4ea5-a184-82f1dabc3e2g',
    );
    expect(result).toBe('/tmp/image_img_v3_02104_b73cd122-662d-4ea5-a184-82f1dabc3e2g.png');
    expect(renameSpy).toHaveBeenCalledWith(
      '/tmp/image_img_v3_02104_b73cd122-662d-4ea5-a184-82f1dabc3e2g',
      '/tmp/image_img_v3_02104_b73cd122-662d-4ea5-a184-82f1dabc3e2g.png',
    );
  });
});
