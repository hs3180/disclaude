/**
 * Tests for chatId validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 *
 * Issue #1641: Validates chatId format before making IPC calls to prevent
 * unhelpful HTTP 400 errors from the Feishu API.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid chatIds', () => {
    it('should return true for a valid chatId with all lowercase hex', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should return true for a valid chatId with all zeros', () => {
      expect(isValidChatId('oc_00000000000000000000000000000000')).toBe(true);
    });

    it('should return true for a valid chatId with all f\'s', () => {
      expect(isValidChatId('oc_ffffffffffffffffffffffffffffffff')).toBe(true);
    });

    it('should return true for a valid chatId with mixed hex chars', () => {
      expect(isValidChatId('oc_abcdef0123456789abcdef0123456789')).toBe(true);
    });
  });

  describe('invalid chatIds - wrong prefix', () => {
    it('should return false for empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should return false for ou_ prefix (user ID)', () => {
      expect(isValidChatId('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should return false for on_ prefix', () => {
      expect(isValidChatId('on_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should return false for OC_ uppercase prefix', () => {
      expect(isValidChatId('OC_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should return false for no prefix', () => {
      expect(isValidChatId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });
  });

  describe('invalid chatIds - wrong length', () => {
    it('should return false for chatId that is too short', () => {
      expect(isValidChatId('oc_a1b2c3d4')).toBe(false);
    });

    it('should return false for chatId that is too long', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6extra')).toBe(false);
    });

    it('should return false for just the prefix', () => {
      expect(isValidChatId('oc_')).toBe(false);
    });
  });

  describe('invalid chatIds - wrong hex characters', () => {
    it('should return false for uppercase hex chars', () => {
      expect(isValidChatId('oc_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6')).toBe(false);
    });

    it('should return false for non-hex characters', () => {
      expect(isValidChatId('oc_gggggggggggggggggggggggggggggggg')).toBe(false);
    });

    it('should return false for chatId with spaces', () => {
      expect(isValidChatId('oc_a1b2c3d4 e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should return false for chatId with special characters', () => {
      expect(isValidChatId('oc_a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('valid chatIds', () => {
    it('should return null for a valid chatId', () => {
      expect(getChatIdValidationError('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBeNull();
    });
  });

  describe('null/undefined/empty inputs', () => {
    it('should return error for empty string', () => {
      const error = getChatIdValidationError('');
      expect(error).toBe('chatId must be a non-empty string');
    });

    it('should return error for undefined (treated as falsy)', () => {
      const error = getChatIdValidationError(undefined as unknown as string);
      expect(error).toBe('chatId is required');
    });

    it('should return error for null (treated as falsy)', () => {
      const error = getChatIdValidationError(null as unknown as string);
      expect(error).toBe('chatId is required');
    });
  });

  describe('wrong prefix', () => {
    it('should return prefix error for ou_ prefix', () => {
      const error = getChatIdValidationError('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(error).toContain('expected "oc_" prefix');
      expect(error).toContain('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
    });
  });

  describe('wrong length', () => {
    it('should return length error for too-short chatId', () => {
      const error = getChatIdValidationError('oc_abc123');
      expect(error).toContain('Invalid chatId length');
      expect(error).toContain('expected 35');
    });

    it('should return length error for too-long chatId', () => {
      const longId = 'oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6extra';
      const error = getChatIdValidationError(longId);
      expect(error).toContain('Invalid chatId length');
    });
  });

  describe('wrong characters', () => {
    it('should return format error for uppercase hex', () => {
      const error = getChatIdValidationError('OC_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6');
      // 'OC_' doesn't start with 'oc_' so it hits the prefix check first
      expect(error).toContain('expected "oc_" prefix');
    });

    it('should return format error for non-hex chars with correct prefix', () => {
      const error = getChatIdValidationError('oc_gggggggggggggggggggggggggggggggg');
      expect(error).toContain('expected oc_<32 hex chars>');
    });
  });
});
