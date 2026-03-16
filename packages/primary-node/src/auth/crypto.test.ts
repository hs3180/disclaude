/**
 * Tests for auth/crypto.ts
 */

import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  isEncrypted,
} from '@disclaude/core';

describe('Crypto', () => {
  describe('encrypt and decrypt', () => {
    it('should encrypt and decrypt a string', () => {
      const plaintext = 'my-secret-token';
      const key = 'test-encryption-key';

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for same plaintext', () => {
      const plaintext = 'my-secret-token';
      const key = 'test-encryption-key';

      const encrypted1 = encrypt(plaintext, key);
      const encrypted2 = encrypt(plaintext, key);

      expect(encrypted1).not.toBe(encrypted2);
      expect(decrypt(encrypted1, key)).toBe(plaintext);
      expect(decrypt(encrypted2, key)).toBe(plaintext);
    });

    it('should fail to decrypt with wrong key', () => {
      const plaintext = 'my-secret-token';
      const key1 = 'test-encryption-key-1';
      const key2 = 'test-encryption-key-2';

      const encrypted = encrypt(plaintext, key1);

      expect(() => decrypt(encrypted, key2)).toThrow();
    });

    it('should handle empty strings', () => {
      const plaintext = '';
      const key = 'test-encryption-key';

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle unicode characters', () => {
      const plaintext = '你好世界 🎉';
      const key = 'test-encryption-key';

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('isEncrypted', () => {
    it('should return true for encrypted values', () => {
      const encrypted = encrypt('test', 'key');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for plain strings', () => {
      expect(isEncrypted('hello world')).toBe(false);
      expect(isEncrypted('{"foo":"bar"}')).toBe(false);
    });
  });

  describe('PKCE', () => {
    it('should generate valid code verifier', () => {
      const verifier = generateCodeVerifier();

      // Should be 43 characters (32 bytes base64url encoded)
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);

      // Should only contain base64url characters
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate different verifiers', () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();

      expect(verifier1).not.toBe(verifier2);
    });

    it('should generate valid code challenge', () => {
      const verifier = generateCodeVerifier();
      const challenge = generateCodeChallenge(verifier);

      // Should be 43 characters (SHA256 base64url encoded)
      expect(challenge.length).toBe(43);

      // Should only contain base64url characters
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should generate deterministic challenge', () => {
      const verifier = 'test-verifier';

      const challenge1 = generateCodeChallenge(verifier);
      const challenge2 = generateCodeChallenge(verifier);

      expect(challenge1).toBe(challenge2);
    });
  });

  describe('generateState', () => {
    it('should generate 32 character hex string', () => {
      const state = generateState();

      expect(state.length).toBe(32);
      expect(state).toMatch(/^[0-9a-f]+$/);
    });

    it('should generate different states', () => {
      const state1 = generateState();
      const state2 = generateState();

      expect(state1).not.toBe(state2);
    });
  });
});
