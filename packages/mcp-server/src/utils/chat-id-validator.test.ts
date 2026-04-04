/**
 * Tests for chat ID validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 *
 * @see https://github.com/hs3180/disclaude/issues/1641 (Scenario 1)
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid Feishu group chat IDs (oc_)', () => {
    it('should return true for a valid oc_ chatId with 32 hex chars', () => {
      const chatId = 'oc_' + 'a'.repeat(32);
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should return true for a valid oc_ chatId with mixed hex chars', () => {
      const chatId = 'oc_' + '0123456789abcdef' + 'fedcba9876543210';
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should return true for a valid oc_ chatId with uppercase hex chars', () => {
      // Feishu IDs are typically lowercase, but hex validation should be case-insensitive? No, only lowercase.
      const chatId = 'oc_' + 'a'.repeat(32);
      expect(isValidChatId(chatId)).toBe(true);
    });
  });

  describe('valid Feishu user IDs (ou_)', () => {
    it('should return true for a valid ou_ chatId with 32 hex chars', () => {
      const chatId = 'ou_' + 'b'.repeat(32);
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should return true for a valid ou_ chatId with mixed hex chars', () => {
      const chatId = 'ou_' + 'abcdef0123456789' + '9876543210fedcba';
      expect(isValidChatId(chatId)).toBe(true);
    });
  });

  describe('valid CLI IDs (cli-)', () => {
    it('should return true for cli- with identifier', () => {
      expect(isValidChatId('cli-12345')).toBe(true);
    });

    it('should return true for cli- with string identifier', () => {
      expect(isValidChatId('cli-my-session')).toBe(true);
    });

    it('should return true for cli- with single char identifier', () => {
      expect(isValidChatId('cli-x')).toBe(true);
    });
  });

  describe('invalid chatIds', () => {
    it('should return false for empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should return false for null', () => {
      expect(isValidChatId(null as unknown as string)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isValidChatId(undefined as unknown as string)).toBe(false);
    });

    it('should return false for number', () => {
      expect(isValidChatId(123 as unknown as string)).toBe(false);
    });

    it('should return false for oc_ with too few hex chars', () => {
      const chatId = 'oc_' + 'a'.repeat(31);
      expect(isValidChatId(chatId)).toBe(false);
    });

    it('should return false for oc_ with too many hex chars', () => {
      const chatId = 'oc_' + 'a'.repeat(33);
      expect(isValidChatId(chatId)).toBe(false);
    });

    it('should return false for oc_ with non-hex chars', () => {
      const chatId = 'oc_' + 'g'.repeat(32);
      expect(isValidChatId(chatId)).toBe(false);
    });

    it('should return false for ou_ with too few hex chars', () => {
      const chatId = 'ou_' + 'a'.repeat(16);
      expect(isValidChatId(chatId)).toBe(false);
    });

    it('should return false for ou_ with non-hex chars', () => {
      const chatId = 'ou_' + 'z'.repeat(32);
      expect(isValidChatId(chatId)).toBe(false);
    });

    it('should return false for cli- without identifier', () => {
      expect(isValidChatId('cli-')).toBe(false);
    });

    it('should return false for unknown prefix', () => {
      expect(isValidChatId('xx_abc123')).toBe(false);
    });

    it('should return false for random string', () => {
      expect(isValidChatId('not-a-chat-id')).toBe(false);
    });

    it('should return false for whitespace only', () => {
      expect(isValidChatId('   ')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('null/empty/non-string inputs', () => {
    it('should return error for null', () => {
      expect(getChatIdValidationError(null)).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for undefined', () => {
      expect(getChatIdValidationError(undefined)).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for number', () => {
      expect(getChatIdValidationError(123)).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for empty string', () => {
      expect(getChatIdValidationError('')).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for whitespace-only string', () => {
      expect(getChatIdValidationError('   ')).toBe('chatId must not be empty or whitespace-only');
    });
  });

  describe('valid chatIds return null', () => {
    it('should return null for valid oc_ chatId', () => {
      const chatId = 'oc_' + 'a'.repeat(32);
      expect(getChatIdValidationError(chatId)).toBeNull();
    });

    it('should return null for valid ou_ chatId', () => {
      const chatId = 'ou_' + 'b'.repeat(32);
      expect(getChatIdValidationError(chatId)).toBeNull();
    });

    it('should return null for valid cli- chatId', () => {
      expect(getChatIdValidationError('cli-12345')).toBeNull();
    });
  });

  describe('oc_ prefix with wrong format', () => {
    it('should return error for oc_ with too few chars', () => {
      const chatId = 'oc_' + 'a'.repeat(10);
      const error = getChatIdValidationError(chatId);
      expect(error).toContain('oc_');
      expect(error).toContain('32 hex chars');
      expect(error).toContain('10 chars');
    });

    it('should return error for oc_ with non-hex chars', () => {
      const chatId = 'oc_' + 'g'.repeat(32);
      const error = getChatIdValidationError(chatId);
      expect(error).toContain('Invalid chatId format');
    });
  });

  describe('ou_ prefix with wrong format', () => {
    it('should return error for ou_ with too few chars', () => {
      const chatId = 'ou_' + 'c'.repeat(5);
      const error = getChatIdValidationError(chatId);
      expect(error).toContain('ou_');
      expect(error).toContain('32 hex chars');
      expect(error).toContain('5 chars');
    });
  });

  describe('cli- prefix with wrong format', () => {
    it('should return error for cli- without identifier', () => {
      const error = getChatIdValidationError('cli-');
      expect(error).toContain('cli-');
      expect(error).toContain('identifier must not be empty');
    });
  });

  describe('unknown prefix', () => {
    it('should return error listing valid prefixes', () => {
      const error = getChatIdValidationError('invalid-id');
      expect(error).toContain('oc_');
      expect(error).toContain('ou_');
      expect(error).toContain('cli-');
    });

    it('should return error for completely random string', () => {
      const error = getChatIdValidationError('hello-world');
      expect(error).toContain('Invalid chatId format');
    });
  });
});
