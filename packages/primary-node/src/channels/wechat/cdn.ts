/**
 * WeChat CDN Upload Utilities.
 *
 * Handles CDN upload/download operations for the WeChat channel:
 * - AES-128-ECB encryption for file content
 * - CDN URL construction
 * - Buffer upload with retry logic
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/cdn
 * @see Issue #1475 - WeChat Channel: Media Handling
 */

import { createCipheriv } from 'node:crypto';
import { createLogger } from '@disclaude/core';

const logger = createLogger('WeChatCdn');

/** Default CDN base URL for WeChat iLink. */
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// AES-128-ECB encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt buffer with AES-128-ECB (PKCS7 padding).
 *
 * @param plaintext - Data to encrypt
 * @param key - 16-byte AES key
 * @returns Encrypted ciphertext
 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary).
 *
 * @param plaintextSize - Size of the plaintext in bytes
 * @returns Size after padding
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ---------------------------------------------------------------------------
// CDN URL construction
// ---------------------------------------------------------------------------

/**
 * Build a CDN upload URL from upload param and filekey.
 *
 * @param params - URL components
 * @returns Full CDN upload URL
 */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

/**
 * Build a CDN download URL from encrypted query param.
 *
 * @param encryptedQueryParam - Encrypted param from CDN upload response
 * @param cdnBaseUrl - CDN base URL
 * @returns Full CDN download URL
 */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

// ---------------------------------------------------------------------------
// CDN buffer upload
// ---------------------------------------------------------------------------

/**
 * Upload an encrypted buffer to the WeChat CDN.
 *
 * POSTs the encrypted content to the CDN upload URL and extracts
 * the `x-encrypted-param` header from the response for download reference.
 *
 * Retries up to UPLOAD_MAX_RETRIES times on server errors (5xx);
 * client errors (4xx) abort immediately.
 *
 * @param params - Upload parameters
 * @returns Download encrypted query param from CDN response
 */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });

  logger.debug(
    { cdnUrl, ciphertextSize: ciphertext.length },
    `${label}: Uploading encrypted buffer to CDN`,
  );

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);

      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text());
        logger.error(
          { attempt, status: res.status, errMsg },
          `${label}: CDN client error`,
        );
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`;
        logger.error(
          { attempt, status: res.status, errMsg },
          `${label}: CDN server error`,
        );
        throw new Error(`CDN upload server error: ${errMsg}`);
      }

      downloadParam = res.headers.get('x-encrypted-param') ?? undefined;
      if (!downloadParam) {
        logger.error(
          { attempt },
          `${label}: CDN response missing x-encrypted-param header`,
        );
        throw new Error('CDN upload response missing x-encrypted-param header');
      }

      logger.debug({ attempt }, `${label}: CDN upload success`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes('client error')) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.error({ attempt, err: String(err) }, `${label}: upload failed, retrying...`);
      } else {
        logger.error({ attempt, err: String(err) }, `${label}: all retries failed`);
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }

  return { downloadParam };
}
