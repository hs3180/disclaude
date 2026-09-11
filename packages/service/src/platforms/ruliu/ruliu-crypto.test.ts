/**
 * Tests for Ruliu Crypto Utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  encryptMessage,
  decryptMessage,
  generateSignature,
  verifySignature,
  decodeAESKey,
} from './ruliu-crypto.js';

describe('RuliuCrypto', () => {
  // Test key (43 characters, Base64)
  const testKey = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const testAppId = 'test-app-id';

  describe('decodeAESKey', () => {
    it('should decode AES key to correct length', () => {
      const { key, iv } = decodeAESKey(testKey);
      expect(key.length).toBe(32); // AES-256 key
      expect(iv.length).toBe(16);  // IV is 16 bytes
    });
  });

  describe('encrypt and decrypt', () => {
    it('should encrypt and decrypt message correctly', () => {
      const message = JSON.stringify({
        content: 'Hello, Ruliu!',
        fromUsername: 'user123',
        msgType: 'text',
        chatId: 'chat456',
        msgId: 'msg789',
        createTime: Date.now(),
      });

      const encrypted = encryptMessage(message, testKey, testAppId);
      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');

      const decrypted = decryptMessage(encrypted, testKey);
      expect(decrypted).toBe(message);
    });

    it('should throw error for invalid key', () => {
      expect(() => {
        decryptMessage('invalid-base64', testKey);
      }).toThrow();
    });
  });

  describe('signature', () => {
    it('should generate and verify signature correctly', () => {
      const token = 'test-token';
      const timestamp = '1234567890';
      const nonce = 'random-nonce';
      const encrypted = 'encrypted-content';

      const signature = generateSignature(token, timestamp, nonce, encrypted);

      expect(verifySignature(signature, token, timestamp, nonce, encrypted)).toBe(true);
      expect(verifySignature('wrong-sig', token, timestamp, nonce, encrypted)).toBe(false);
    });
  });
});
