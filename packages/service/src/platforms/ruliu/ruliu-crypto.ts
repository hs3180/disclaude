/**
 * Ruliu (如流) Crypto Utilities.
 *
 * AES encryption/decryption for Ruliu message handling.
 * Uses AES-256-CBC with PKCS7 padding.
 *
 * @see https://github.com/chbo297/openclaw-infoflow
 */

import * as crypto from 'crypto';
import { createLogger } from '@disclaude/core';

const logger = createLogger('RuliuCrypto');

/**
 * PKCS7 padding.
 */
function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
  const padLen = blockSize - (data.length % blockSize);
  const pad = Buffer.alloc(padLen, padLen);
  return Buffer.concat([data, pad]);
}

/**
 * PKCS7 unpadding.
 */
function pkcs7Unpad(data: Buffer): Buffer {
  const padLen = data[data.length - 1];
  return data.subarray(0, data.length - padLen);
}

/**
 * Decode Base64 AES key to Buffer.
 * The key is 43 characters, Base64 decoded to 32 bytes + 11 bytes = 43 bytes.
 * We need the first 32 bytes as AES key.
 *
 * @param encodingAESKey - Base64 encoded AES key
 * @returns Object with key and iv
 */
export function decodeAESKey(encodingAESKey: string): { key: Buffer; iv: Buffer } {
  // Add padding if needed (Base64 needs length divisible by 4)
  let key = encodingAESKey;
  while (key.length % 4 !== 0) {
    key += '=';
  }

  const decoded = Buffer.from(key, 'base64');

  // First 32 bytes are the AES key, last 16 bytes are IV
  return {
    key: decoded.subarray(0, 32),
    iv: decoded.subarray(32, 48),
  };
}

/**
 * Decrypt Ruliu encrypted message.
 *
 * @param encryptedBase64 - Base64 encoded encrypted content
 * @param encodingAESKey - AES key for decryption
 * @returns Decrypted content
 */
export function decryptMessage(
  encryptedBase64: string,
  encodingAESKey: string
): string {
  try {
    const { key, iv } = decodeAESKey(encodingAESKey);
    const encrypted = Buffer.from(encryptedBase64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);

    const decryptedRaw = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    const decrypted = pkcs7Unpad(decryptedRaw);

    // Remove random bytes (first 16 bytes) and length prefix
    // Format: random(16) + msgLen(4) + msg + appId
    const msgLen = decrypted.readUInt32BE(16);
    const msg = decrypted.subarray(20, 20 + msgLen).toString('utf8');

    logger.debug({ msgLen, totalLen: decrypted.length }, 'Message decrypted');
    return msg;
  } catch (error) {
    logger.error({ err: error }, 'Failed to decrypt message');
    throw new Error('Failed to decrypt Ruliu message');
  }
}

/**
 * Encrypt message for Ruliu.
 *
 * @param content - Content to encrypt
 * @param encodingAESKey - AES key for encryption
 * @param appId - Application ID (appKey)
 * @returns Base64 encoded encrypted content
 */
export function encryptMessage(
  content: string,
  encodingAESKey: string,
  appId: string
): string {
  try {
    const { key, iv } = decodeAESKey(encodingAESKey);

    // Format: random(16) + msgLen(4) + msg + appId
    const random = crypto.randomBytes(16);
    const msgBuffer = Buffer.from(content, 'utf8');
    const msgLenBuffer = Buffer.alloc(4);
    msgLenBuffer.writeUInt32BE(msgBuffer.length, 0);
    const appIdBuffer = Buffer.from(appId, 'utf8');

    const data = Buffer.concat([random, msgLenBuffer, msgBuffer, appIdBuffer]);
    const padded = pkcs7Pad(data, 32);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);

    const encrypted = Buffer.concat([
      cipher.update(padded),
      cipher.final(),
    ]);

    return encrypted.toString('base64');
  } catch (error) {
    logger.error({ err: error }, 'Failed to encrypt message');
    throw new Error('Failed to encrypt Ruliu message');
  }
}

/**
 * Generate signature for webhook verification.
 *
 * @param token - Check token
 * @param timestamp - Timestamp string
 * @param nonce - Nonce string
 * @param encrypted - Encrypted content
 * @returns SHA1 signature
 */
export function generateSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string
): string {
  const arr = [token, timestamp, nonce, encrypted].sort();
  const str = arr.join('');
  return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * Verify webhook signature.
 *
 * @param signature - Signature to verify
 * @param token - Check token
 * @param timestamp - Timestamp string
 * @param nonce - Nonce string
 * @param encrypted - Encrypted content
 * @returns Whether signature is valid
 */
export function verifySignature(
  signature: string,
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string
): boolean {
  const expected = generateSignature(token, timestamp, nonce, encrypted);
  return signature === expected;
}
