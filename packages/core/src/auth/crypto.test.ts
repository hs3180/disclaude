/**
 * Tests for auth/crypto.ts
 *
 * Tests cryptographic utilities:
 * - encrypt/decrypt round-trip
 * - PKCE code generation (verifier + challenge)
 * - State generation for CSRF protection
 * - isEncrypted detection
 * - getEncryptionKey behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encrypt,
  decrypt,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  isEncrypted,
  getEncryptionKey,
} from './crypto.js';

describe('crypto', () => {
  const originalEnv = process.env.AUTH_ENCRYPTION_KEY;

  beforeEach(() => {
    delete process.env.AUTH_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AUTH_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.AUTH_ENCRYPTION_KEY;
    }
  });

  describe('encrypt / decrypt', () => {
    it('should encrypt and decrypt a string round-trip', () => {
      const plaintext = 'hello world';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt with a custom key', () => {
      const plaintext = 'sensitive data';
      const key = 'my-custom-encryption-key-12345';
      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertexts for the same plaintext', () => {
      const plaintext = 'same input';
      const encrypted1 = encrypt(plaintext, 'key-a');
      const encrypted2 = encrypt(plaintext, 'key-a');

      // Random IV and salt mean ciphertext differs each time
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should fail to decrypt with wrong key', () => {
      const encrypted = encrypt('secret', 'correct-key');

      expect(() => decrypt(encrypted, 'wrong-key')).toThrow(
        'Failed to decrypt data'
      );
    });

    it('should handle empty string', () => {
      const encrypted = encrypt('', 'key');
      expect(decrypt(encrypted, 'key')).toBe('');
    });

    it('should handle unicode content', () => {
      const plaintext = '你好世界 🌍 こんにちは';
      const encrypted = encrypt(plaintext, 'key');
      expect(decrypt(encrypted, 'key')).toBe(plaintext);
    });

    it('should handle long strings', () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = encrypt(plaintext, 'key');
      expect(decrypt(encrypted, 'key')).toBe(plaintext);
    });

    it('should produce valid JSON output', () => {
      const encrypted = encrypt('test', 'key');
      const parsed = JSON.parse(encrypted);

      expect(parsed).toHaveProperty('s');
      expect(parsed).toHaveProperty('i');
      expect(parsed).toHaveProperty('t');
      expect(parsed).toHaveProperty('c');
    });

    it('should throw on invalid JSON input to decrypt', () => {
      expect(() => decrypt('not-json')).toThrow('Failed to decrypt data');
    });

    it('should throw on malformed encrypted data', () => {
      expect(() => decrypt('{"s":"x","i":"x","t":"x","c":"x"}')).toThrow(
        'Failed to decrypt data'
      );
    });
  });

  describe('generateCodeVerifier', () => {
    it('should return a string of expected length', () => {
      const verifier = generateCodeVerifier();
      // 32 random bytes → base64url → 43 characters
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
    });

    it('should return different values on each call', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();
      expect(verifier1).not.toBe(verifier2);
    });

    it('should only contain base64url-safe characters', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('generateCodeChallenge', () => {
    it('should produce a valid S256 challenge', () => {
      const verifier = generateCodeVerifier();
      const challenge = generateCodeChallenge(verifier);

      // S256 challenge is base64url-encoded SHA-256 hash
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(challenge.length).toBe(43); // SHA-256 → 32 bytes → base64url → 43 chars
    });

    it('should produce consistent challenge for same verifier', () => {
      const verifier = 'test-verifier-value';
      const challenge1 = generateCodeChallenge(verifier);
      const challenge2 = generateCodeChallenge(verifier);

      expect(challenge1).toBe(challenge2);
    });

    it('should produce different challenge for different verifiers', () => {
      const challenge1 = generateCodeChallenge('verifier-one');
      const challenge2 = generateCodeChallenge('verifier-two');

      expect(challenge1).not.toBe(challenge2);
    });
  });

  describe('generateState', () => {
    it('should return a hex string of expected length', () => {
      const state = generateState();
      // 16 random bytes → hex → 32 characters
      expect(state).toHaveLength(32);
    });

    it('should return different values on each call', () => {
      const state1 = generateState();
      const state2 = generateState();
      expect(state1).not.toBe(state2);
    });

    it('should only contain hex characters', () => {
      const state = generateState();
      expect(state).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe('isEncrypted', () => {
    it('should return true for valid encrypted data', () => {
      const encrypted = encrypt('test', 'key');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for plain text', () => {
      expect(isEncrypted('hello world')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isEncrypted('')).toBe(false);
    });

    it('should return false for JSON that is not encrypted data', () => {
      expect(isEncrypted('{"foo":"bar"}')).toBe(false);
    });

    it('should return true for JSON starting with {"s":', () => {
      expect(isEncrypted('{"s":"value"}')).toBe(true);
    });
  });

  describe('getEncryptionKey', () => {
    it('should return AUTH_ENCRYPTION_KEY env var when set', () => {
      process.env.AUTH_ENCRYPTION_KEY = 'my-production-key';
      expect(getEncryptionKey()).toBe('my-production-key');
    });

    it('should return default key when env var is not set', () => {
      expect(getEncryptionKey()).toBe(
        'dev-key-please-set-AUTH_ENCRYPTION_KEY-in-production'
      );
    });
  });
});
