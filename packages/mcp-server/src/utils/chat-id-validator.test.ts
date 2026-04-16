/**
 * Tests for chat ID validation utilities.
 *
 * @see https://github.com/hs3180/disclaude/issues/1641
 * @see https://github.com/hs3180/disclaude/issues/2389
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid formats', () => {
    it('should accept Feishu group chat IDs (oc_)', () => {
      const chatId = `oc_${'a'.repeat(32)}`;
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should accept Feishu user IDs (ou_)', () => {
      const chatId = `ou_${'f'.repeat(32)}`;
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should accept CLI session IDs (cli-)', () => {
      expect(isValidChatId('cli-abc123')).toBe(true);
    });

    it('should accept test session IDs (test-)', () => {
      expect(isValidChatId('test-use-case-2-files-12345')).toBe(true);
    });

    it('should accept any non-empty string >= 3 chars', () => {
      expect(isValidChatId('abc')).toBe(true);
      expect(isValidChatId('some-random-id')).toBe(true);
      expect(isValidChatId('uuid-like-1234')).toBe(true);
    });

    it('should accept UUID format chatIds', () => {
      expect(isValidChatId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });
  });

  describe('invalid formats', () => {
    it('should reject an empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should reject strings shorter than 3 characters', () => {
      expect(isValidChatId('ab')).toBe(false);
      expect(isValidChatId('x')).toBe(false);
    });

    it('should reject a string with leading whitespace', () => {
      expect(isValidChatId(` oc_${'a'.repeat(32)}`)).toBe(false);
    });

    it('should reject a string with trailing whitespace', () => {
      expect(isValidChatId(`oc_${'a'.repeat(32)} `)).toBe(false);
    });

    it('should reject a bare cli- prefix with nothing after it', () => {
      expect(isValidChatId('cl')).toBe(false);
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

  it('should return null for a valid test- ID', () => {
    expect(getChatIdValidationError('test-mcp-send-text-12345')).toBeNull();
  });

  it('should return null for any string >= 3 chars', () => {
    expect(getChatIdValidationError('abc')).toBeNull();
  });

  it('should return an error for an empty string', () => {
    const error = getChatIdValidationError('');
    expect(error).not.toBeNull();
    expect(error).toContain('required');
  });

  it('should return an error for strings shorter than 3 characters', () => {
    const error = getChatIdValidationError('ab');
    expect(error).not.toBeNull();
    expect(error).toContain('at least 3 characters');
  });

  it('should return an error for whitespace-padded strings', () => {
    const error = getChatIdValidationError(' abc ');
    expect(error).not.toBeNull();
    expect(error).toContain('whitespace');
  });

  it('should truncate long chatIds in error messages', () => {
    const longId = ` ${'x'.repeat(50)}`; // 51 chars but has leading whitespace
    const error = getChatIdValidationError(longId);
    expect(error).not.toBeNull();
    // The error should not contain the full string
    expect(error).not.toContain(longId);
    expect(error).toContain('...');
  });
});
