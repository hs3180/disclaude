/**
 * Tests for WeChat CDN utilities.
 *
 * Tests AES encryption, URL construction, and CDN upload logic.
 * Uses mocked fetch to avoid real network dependency.
 *
 * @see Issue #1475 - WeChat Channel: Media Handling
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encryptAesEcb,
  aesEcbPaddedSize,
  buildCdnUploadUrl,
  buildCdnDownloadUrl,
  uploadBufferToCdn,
} from './cdn.js';

// ─── Mock Logger ───

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

// ─── Mock Fetch ───

const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

// ═══════════════════════════════════════════════════════
// AES-128-ECB Encryption
// ═══════════════════════════════════════════════════════

describe('encryptAesEcb', () => {
  it('should encrypt and produce different output than input', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex'); // 16 bytes
    const plaintext = Buffer.from('hello world');

    const ciphertext = encryptAesEcb(plaintext, key);

    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(ciphertext.length).not.toBe(plaintext.length); // PKCS7 padding adds bytes
    expect(ciphertext.toString()).not.toBe(plaintext.toString());
  });

  it('should produce deterministic output for same input', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const plaintext = Buffer.from('test data');

    const ct1 = encryptAesEcb(plaintext, key);
    const ct2 = encryptAesEcb(plaintext, key);

    expect(ct1.equals(ct2)).toBe(true);
  });

  it('should pad to 16-byte boundary', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const plaintext = Buffer.from('a'); // 1 byte

    const ciphertext = encryptAesEcb(plaintext, key);

    expect(ciphertext.length % 16).toBe(0);
  });

  it('should handle empty buffer', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const plaintext = Buffer.alloc(0);

    const ciphertext = encryptAesEcb(plaintext, key);

    // Empty input still gets PKCS7 padding (1 block of padding)
    expect(ciphertext.length).toBe(16);
  });

  it('should handle exactly 16-byte input', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const plaintext = Buffer.from('0123456789abcdef');

    const ciphertext = encryptAesEcb(plaintext, key);

    // 16 bytes + PKCS7 padding = 32 bytes
    expect(ciphertext.length).toBe(32);
  });
});

// ═══════════════════════════════════════════════════════
// AES Padded Size
// ═══════════════════════════════════════════════════════

describe('aesEcbPaddedSize', () => {
  it('should return 16 for 0 bytes (PKCS7 always adds padding)', () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
  });

  it('should return 16 for 1 byte', () => {
    expect(aesEcbPaddedSize(1)).toBe(16);
  });

  it('should return 16 for 15 bytes', () => {
    expect(aesEcbPaddedSize(15)).toBe(16);
  });

  it('should return 32 for 16 bytes (adds full padding block)', () => {
    expect(aesEcbPaddedSize(16)).toBe(32);
  });

  it('should return 32 for 17 bytes', () => {
    expect(aesEcbPaddedSize(17)).toBe(32);
  });

  it('should return correct size for larger inputs', () => {
    expect(aesEcbPaddedSize(100)).toBe(112);
    expect(aesEcbPaddedSize(1024)).toBe(1040);
    expect(aesEcbPaddedSize(10 * 1024 * 1024)).toBe(10 * 1024 * 1024 + 16);
  });
});

// ═══════════════════════════════════════════════════════
// CDN URL Construction
// ═══════════════════════════════════════════════════════

describe('buildCdnUploadUrl', () => {
  it('should build correct upload URL', () => {
    const url = buildCdnUploadUrl({
      cdnBaseUrl: 'https://cdn.example.com/c2c',
      uploadParam: 'abc123',
      filekey: 'def456',
    });

    expect(url).toBe(
      'https://cdn.example.com/c2c/upload?encrypted_query_param=abc123&filekey=def456',
    );
  });

  it('should URL-encode special characters in params', () => {
    const url = buildCdnUploadUrl({
      cdnBaseUrl: 'https://cdn.example.com/c2c',
      uploadParam: 'abc=def&ghi',
      filekey: 'key/with:special',
    });

    expect(url).toContain('encrypted_query_param=abc%3Ddef%26ghi');
    expect(url).toContain('filekey=key%2Fwith%3Aspecial');
  });
});

describe('buildCdnDownloadUrl', () => {
  it('should build correct download URL', () => {
    const url = buildCdnDownloadUrl('downloadParam123', 'https://cdn.example.com/c2c');

    expect(url).toBe(
      'https://cdn.example.com/c2c/download?encrypted_query_param=downloadParam123',
    );
  });
});

// ═══════════════════════════════════════════════════════
// CDN Buffer Upload
// ═══════════════════════════════════════════════════════

describe('uploadBufferToCdn', () => {
  const aeskey = Buffer.from('0123456789abcdef0123456789abcdef', 'hex'); // 16 bytes

  beforeEach(() => {
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should upload buffer and return download param', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Map([['x-encrypted-param', 'download-param-xyz']]),
    });

    const result = await uploadBufferToCdn({
      buf: Buffer.from('test file content'),
      uploadParam: 'upload-abc',
      filekey: 'filekey-def',
      cdnBaseUrl: 'https://cdn.example.com/c2c',
      aeskey,
      label: 'test-upload',
    });

    expect(result.downloadParam).toBe('download-param-xyz');

    // Verify fetch was called with correct method and content type
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].headers['Content-Type']).toBe('application/octet-stream');
  });

  it('should throw on 4xx client error', async () => {
    mockFetch.mockResolvedValue({
      status: 400,
      headers: new Map([['x-error-message', 'Bad request']]),
    });

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from('test'),
        uploadParam: 'upload-abc',
        filekey: 'filekey-def',
        cdnBaseUrl: 'https://cdn.example.com/c2c',
        aeskey,
        label: 'test-upload',
      }),
    ).rejects.toThrow('CDN upload client error 400');
  });

  it('should retry on 5xx server error', async () => {
    // First two calls fail with 500, third succeeds
    mockFetch
      .mockResolvedValueOnce({
        status: 500,
        headers: new Map([['x-error-message', 'Internal server error']]),
      })
      .mockResolvedValueOnce({
        status: 500,
        headers: new Map([['x-error-message', 'Internal server error']]),
      })
      .mockResolvedValue({
        status: 200,
        headers: new Map([['x-encrypted-param', 'download-param-after-retry']]),
      });

    const result = await uploadBufferToCdn({
      buf: Buffer.from('test'),
      uploadParam: 'upload-abc',
      filekey: 'filekey-def',
      cdnBaseUrl: 'https://cdn.example.com/c2c',
      aeskey,
      label: 'test-upload',
    });

    expect(result.downloadParam).toBe('download-param-after-retry');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries exhausted', async () => {
    // All 3 calls fail with 500
    mockFetch.mockResolvedValue({
      status: 500,
      headers: new Map([['x-error-message', 'Server error']]),
    });

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from('test'),
        uploadParam: 'upload-abc',
        filekey: 'filekey-def',
        cdnBaseUrl: 'https://cdn.example.com/c2c',
        aeskey,
        label: 'test-upload',
      }),
    ).rejects.toThrow('CDN upload server error');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should throw when response is missing x-encrypted-param header', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: new Map(),
    });

    await expect(
      uploadBufferToCdn({
        buf: Buffer.from('test'),
        uploadParam: 'upload-abc',
        filekey: 'filekey-def',
        cdnBaseUrl: 'https://cdn.example.com/c2c',
        aeskey,
        label: 'test-upload',
      }),
    ).rejects.toThrow('CDN upload response missing x-encrypted-param header');
  });
});
