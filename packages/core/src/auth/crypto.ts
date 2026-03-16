/**
 * Cryptographic utilities for secure token storage.
 *
 * Uses AES-256-GCM for encryption with PBKDF2 key derivation.
 */

import * as crypto from 'crypto';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AuthCrypto');

/**
 * Encryption algorithm constants.
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

/**
 * Get encryption key from environment or config.
 * Falls back to a generated key if not configured (development only).
 */
export function getEncryptionKey(): string {
  // Try environment variable first
  const envKey = process.env.AUTH_ENCRYPTION_KEY;
  if (envKey) {
    return envKey;
  }

  // Generate a warning for development
  logger.warn(
    'AUTH_ENCRYPTION_KEY not set. Using generated key. ' +
    'Set AUTH_ENCRYPTION_KEY environment variable for production.'
  );

  // Return a fixed development key (NOT for production)
  return 'dev-key-please-set-AUTH_ENCRYPTION_KEY-in-production';
}

/**
 * Derive encryption key from password using PBKDF2.
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha256'
  );
}

/**
 * Encrypted data structure.
 */
interface EncryptedData {
  /** Base64 encoded salt */
  s: string;
  /** Base64 encoded IV */
  i: string;
  /** Base64 encoded auth tag */
  t: string;
  /** Base64 encoded ciphertext */
  c: string;
}

/**
 * Encrypt a string value.
 *
 * @param plaintext - Text to encrypt
 * @param key - Encryption key (optional, uses default if not provided)
 * @returns Encrypted data as JSON string
 */
export function encrypt(plaintext: string, key?: string): string {
  const encryptionKey = key || getEncryptionKey();

  // Generate random salt and IV
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key
  const derivedKey = deriveKey(encryptionKey, salt);

  // Create cipher
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  // Encrypt
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // Get auth tag
  const authTag = cipher.getAuthTag();

  // Create encrypted data object
  const encryptedData: EncryptedData = {
    s: salt.toString('base64'),
    i: iv.toString('base64'),
    t: authTag.toString('base64'),
    c: encrypted.toString('base64'),
  };

  return JSON.stringify(encryptedData);
}

/**
 * Decrypt an encrypted string.
 *
 * @param encryptedString - Encrypted data as JSON string
 * @param key - Encryption key (optional, uses default if not provided)
 * @returns Decrypted plaintext
 * @throws Error if decryption fails
 */
export function decrypt(encryptedString: string, key?: string): string {
  const encryptionKey = key || getEncryptionKey();

  try {
    // Parse encrypted data
    const data: EncryptedData = JSON.parse(encryptedString);

    // Decode components
    const salt = Buffer.from(data.s, 'base64');
    const iv = Buffer.from(data.i, 'base64');
    const authTag = Buffer.from(data.t, 'base64');
    const encrypted = Buffer.from(data.c, 'base64');

    // Derive key
    const derivedKey = deriveKey(encryptionKey, salt);

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    // Set auth tag
    decipher.setAuthTag(authTag);

    // Decrypt
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    logger.error({ err: error }, 'Decryption failed');
    throw new Error('Failed to decrypt data. Key may be incorrect.');
  }
}

/**
 * Generate a random code verifier for PKCE.
 * RFC 7636 recommends 43-128 characters.
 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate code challenge from verifier for PKCE.
 * Uses SHA256 and base64url encoding (S256 method).
 */
export function generateCodeChallenge(verifier: string): string {
  return crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
}

/**
 * Generate a random state string for CSRF protection.
 */
export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Check if a value appears to be encrypted.
 * Simple check: encrypted values start with '{"s":'
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith('{"s":');
}
