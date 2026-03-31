/**
 * Tests for chat ID validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 * Issue #1641: Validates chatId format before making IPC/API calls.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid chat IDs', () => {
    it('should accept valid open chat ID (oc_ prefix)', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should accept valid user ID (ou_ prefix)', () => {
      expect(isValidChatId('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should accept valid notification group ID (on_ prefix)', () => {
      expect(isValidChatId('on_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should accept all-zeros hex', () => {
      expect(isValidChatId('oc_00000000000000000000000000000000')).toBe(true);
    });

    it('should accept all-f hex', () => {
      expect(isValidChatId('oc_ffffffffffffffffffffffffffffffff')).toBe(true);
    });
  });

  describe('invalid chat IDs', () => {
    it('should reject empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should reject missing prefix', () => {
      expect(isValidChatId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should reject unknown prefix', () => {
      expect(isValidChatId('xx_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should reject too short', () => {
      expect(isValidChatId('oc_abc123')).toBe(false);
    });

    it('should reject too long', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6extra')).toBe(false);
    });

    it('should reject uppercase hex', () => {
      expect(isValidChatId('oc_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6')).toBe(false);
    });

    it('should reject non-hex characters', () => {
      expect(isValidChatId('oc_g1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should reject with spaces', () => {
      expect(isValidChatId('oc_ a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should reject prefix only', () => {
      expect(isValidChatId('oc_')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('null/empty/invalid inputs', () => {
    it('should return error for empty string', () => {
      const result = getChatIdValidationError('');
      expect(result).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for whitespace-only string', () => {
      const result = getChatIdValidationError('   ');
      expect(result).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for string with only prefix', () => {
      const result = getChatIdValidationError('oc_');
      expect(result).toContain('Invalid chatId length');
    });
  });

  describe('missing or wrong prefix', () => {
    it('should return error for missing prefix', () => {
      const result = getChatIdValidationError('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(result).toContain('Invalid chatId format');
      expect(result).toContain('oc_xxx');
    });

    it('should return error for unknown prefix', () => {
      const result = getChatIdValidationError('xx_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(result).toContain('Invalid chatId format');
    });

    it('should return error for uppercase prefix', () => {
      const result = getChatIdValidationError('OC_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(result).toContain('Invalid chatId format');
    });
  });

  describe('wrong length', () => {
    it('should return error for too short', () => {
      const result = getChatIdValidationError('oc_abc123');
      expect(result).toContain('Invalid chatId length');
      expect(result).toContain('expected 35 characters');
    });

    it('should return error for too long', () => {
      const result = getChatIdValidationError('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6extra');
      expect(result).toContain('Invalid chatId length');
    });
  });

  describe('invalid characters', () => {
    it('should return error for uppercase hex', () => {
      const result = getChatIdValidationError('oc_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6');
      expect(result).toContain('lowercase hex');
    });

    it('should return error for non-hex characters', () => {
      const result = getChatIdValidationError('oc_g1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(result).toContain('lowercase hex');
    });

    it('should return error for special characters', () => {
      const result = getChatIdValidationError('oc_@#$%^&*()_1234567890abcdef123456');
      expect(result).toContain('lowercase hex');
    });
  });

  describe('valid IDs return null', () => {
    it('should return null for valid oc_ ID', () => {
      const result = getChatIdValidationError('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(result).toBeNull();
    });

    it('should return null for valid ou_ ID', () => {
      const result = getChatIdValidationError('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(result).toBeNull();
    });

    it('should return null for valid on_ ID', () => {
      const result = getChatIdValidationError('on_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(result).toBeNull();
    });

    it('should return null for all-zeros', () => {
      const result = getChatIdValidationError('oc_00000000000000000000000000000000');
      expect(result).toBeNull();
    });
  });
});
