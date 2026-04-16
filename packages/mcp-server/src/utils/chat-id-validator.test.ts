/**
 * Tests for chat ID validation utilities.
 *
 * @see https://github.com/hs3180/disclaude/issues/1641
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('Feishu group chat IDs (oc_)', () => {
    it('should accept a valid oc_ group chat ID', () => {
      const chatId = `oc_${'a'.repeat(32)}`;
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should accept an oc_ ID with mixed hex chars', () => {
      const chatId = `oc_${'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'}`;
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should reject an oc_ ID that is too short', () => {
      const chatId = 'oc_abc';
      expect(isValidChatId(chatId)).toBe(false);
    });

    it('should reject an oc_ ID with spaces', () => {
      const chatId = `oc_${'a'.repeat(32)} `;
      expect(isValidChatId(chatId)).toBe(false);
    });
  });

  describe('Feishu user IDs (ou_)', () => {
    it('should accept a valid ou_ user chat ID', () => {
      const chatId = `ou_${'f'.repeat(32)}`;
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should reject an ou_ ID that is too short', () => {
      const chatId = 'ou_123';
      expect(isValidChatId(chatId)).toBe(false);
    });
  });

  describe('CLI session IDs (cli-)', () => {
    it('should accept a valid cli- session ID', () => {
      expect(isValidChatId('cli-abc123')).toBe(true);
    });

    it('should accept a minimal cli- ID', () => {
      expect(isValidChatId('cli-x')).toBe(true);
    });

    it('should reject a bare cli- prefix with nothing after it', () => {
      expect(isValidChatId('cli-')).toBe(false);
    });
  });

  describe('invalid formats', () => {
    it('should reject test- prefix (Issue #2389: test patterns removed from production)', () => {
      expect(isValidChatId('test-use-case-2-files-12345')).toBe(false);
      expect(isValidChatId('test-abcde')).toBe(false);
      expect(isValidChatId('test-multimodal-12345')).toBe(false);
    });

    it('should reject an empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should reject a random string', () => {
      expect(isValidChatId('not-a-valid-id')).toBe(false);
    });

    it('should reject a numeric string', () => {
      expect(isValidChatId('1234567890')).toBe(false);
    });

    it('should reject a string with unknown prefix', () => {
      expect(isValidChatId('xx_abcdef1234567890')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  it('should return null for a valid oc_ chat ID', () => {
    const chatId = `oc_${'a'.repeat(32)}`;
    expect(getChatIdValidationError(chatId)).toBeNull();
  });

  it('should return null for a valid ou_ chat ID', () => {
    const chatId = `ou_${'b'.repeat(32)}`;
    expect(getChatIdValidationError(chatId)).toBeNull();
  });

  it('should return null for a valid cli- session ID', () => {
    expect(getChatIdValidationError('cli-session-42')).toBeNull();
  });

  it('should return an error for an empty string', () => {
    const error = getChatIdValidationError('');
    expect(error).not.toBeNull();
    expect(error).toContain('required');
  });

  it('should return an error describing the expected formats', () => {
    const error = getChatIdValidationError('invalid-id');
    expect(error).not.toBeNull();
    expect(error).toContain('oc_');
    expect(error).toContain('ou_');
    expect(error).toContain('cli-');
  });

  it('should truncate long chatIds in error messages', () => {
    const longId = `invalid_${'x'.repeat(50)}`;
    const error = getChatIdValidationError(longId);
    expect(error).not.toBeNull();
    // The error should not contain the full 60-char string
    expect(error).not.toContain(longId);
    expect(error).toContain('...');
  });
});
