/**
 * Tests for chat ID validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid chatIds', () => {
    it('should accept oc_ prefix (Feishu group chat)', () => {
      expect(isValidChatId('oc_abc123def456')).toBe(true);
    });

    it('should accept ou_ prefix (Feishu private chat)', () => {
      expect(isValidChatId('ou_abc123def456')).toBe(true);
    });

    it('should accept cli- prefix (CLI mode)', () => {
      expect(isValidChatId('cli-session-123')).toBe(true);
    });

    it('should accept oc_ with hex chars (real format)', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });
  });

  describe('invalid chatIds', () => {
    it('should reject empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should reject very short strings', () => {
      expect(isValidChatId('oc_')).toBe(false);
      expect(isValidChatId('ab')).toBe(false);
    });

    it('should reject unknown prefixes', () => {
      expect(isValidChatId('xx_random_id')).toBe(false);
      expect(isValidChatId('random_string')).toBe(false);
    });

    it('should reject strings without prefix', () => {
      expect(isValidChatId('just_a_string')).toBe(false);
    });

    it('should reject numeric strings', () => {
      expect(isValidChatId('12345' as unknown as string)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should reject null', () => {
      expect(isValidChatId(null as unknown as string)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(isValidChatId(undefined as unknown as string)).toBe(false);
    });

    it('should reject non-string types', () => {
      expect(isValidChatId(123 as unknown as string)).toBe(false);
      expect(isValidChatId({} as unknown as string)).toBe(false);
      expect(isValidChatId([] as unknown as string)).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('null/missing values', () => {
    it('should return error for empty string', () => {
      expect(getChatIdValidationError('')).toBe('chatId is required');
    });

    it('should return error for null', () => {
      expect(getChatIdValidationError(null)).toBe('chatId is required');
    });

    it('should return error for undefined', () => {
      expect(getChatIdValidationError(undefined)).toBe('chatId is required');
    });
  });

  describe('non-string types', () => {
    it('should return error for number', () => {
      expect(getChatIdValidationError(123)).toContain('chatId must be a string');
    });

    it('should return error for object', () => {
      expect(getChatIdValidationError({})).toContain('chatId must be a string');
    });
  });

  describe('short strings', () => {
    it('should return error for 3-char string', () => {
      const error = getChatIdValidationError('abc');
      expect(error).toContain('too short');
      expect(error).toContain('3 chars');
    });
  });

  describe('unknown prefixes', () => {
    it('should mention unrecognized format for unknown prefix', () => {
      const error = getChatIdValidationError('xx_invalid_id');
      expect(error).toContain('Unrecognized chatId format');
      expect(error).toContain('xx_invalid_id');
    });

    it('should list known prefixes in error', () => {
      const error = getChatIdValidationError('random');
      expect(error).toContain('oc_');
      expect(error).toContain('ou_');
      expect(error).toContain('cli-');
    });
  });

  describe('valid chatIds return null', () => {
    it('should return null for valid oc_ chatId', () => {
      expect(getChatIdValidationError('oc_abc123')).toBe(null);
    });

    it('should return null for valid ou_ chatId', () => {
      expect(getChatIdValidationError('ou_user123')).toBe(null);
    });

    it('should return null for valid cli- chatId', () => {
      expect(getChatIdValidationError('cli-session')).toBe(null);
    });
  });
});
