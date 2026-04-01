/**
 * Tests for chat ID validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 *
 * Issue #1641: Agent tool calls fail silently or with unclear errors.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid chat IDs', () => {
    it('should return true for a standard group chat ID (oc_ + 32 hex)', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should return true for all-zeros hex', () => {
      expect(isValidChatId('oc_00000000000000000000000000000000')).toBe(true);
    });

    it('should return true for all-f hex', () => {
      expect(isValidChatId('oc_ffffffffffffffffffffffffffffffff')).toBe(true);
    });

    it('should be case-sensitive (only lowercase)', () => {
      expect(isValidChatId('oc_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6')).toBe(false);
    });
  });

  describe('invalid chat IDs', () => {
    it('should return false for empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should return false for non-oc_ prefix', () => {
      expect(isValidChatId('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should return false for missing prefix', () => {
      expect(isValidChatId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should return false for too short hex', () => {
      expect(isValidChatId('oc_a1b2c3d4')).toBe(false);
    });

    it('should return false for too long hex', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d678')).toBe(false);
    });

    it('should return false for non-hex characters', () => {
      expect(isValidChatId('oc_g1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should return false for random string', () => {
      expect(isValidChatId('invalid-chat-id')).toBe(false);
    });

    it('should return false for oc_ prefix only', () => {
      expect(isValidChatId('oc_')).toBe(false);
    });

    it('should return false for just oc_', () => {
      expect(isValidChatId('oc_')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('null/empty input', () => {
    it('should return error for empty string', () => {
      expect(getChatIdValidationError('')).toBe('chatId is required');
    });
  });

  describe('format errors', () => {
    it('should describe expected format for wrong prefix', () => {
      const error = getChatIdValidationError('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(error).toContain('Invalid chatId format');
      expect(error).toContain('oc_');
      expect(error).toContain('32 hex chars');
    });

    it('should include the invalid value in error message', () => {
      const error = getChatIdValidationError('invalid');
      expect(error).toContain('"invalid"');
    });

    it('should include example format in error message', () => {
      const error = getChatIdValidationError('short');
      expect(error).toContain('oc_');
    });
  });

  describe('valid chat IDs', () => {
    it('should return null for valid chat ID', () => {
      expect(getChatIdValidationError('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(null);
    });
  });
});
