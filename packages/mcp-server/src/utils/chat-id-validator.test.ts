/**
 * Tests for chatId validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid chat IDs', () => {
    it('should accept oc_ prefix with 32 hex chars', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should accept ou_ prefix (user IDs)', () => {
      expect(isValidChatId('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should accept on_ prefix (group node IDs)', () => {
      expect(isValidChatId('on_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should accept op_ prefix (person IDs)', () => {
      expect(isValidChatId('op_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should accept uppercase hex chars', () => {
      expect(isValidChatId('oc_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6')).toBe(true);
    });

    it('should accept mixed case hex chars', () => {
      expect(isValidChatId('oc_Aa1b2C3d4E5f6a7B8c9D0e1F2a3b4C5d')).toBe(true);
    });
  });

  describe('invalid chat IDs', () => {
    it('should reject empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should reject random string', () => {
      expect(isValidChatId('invalid-chat-id')).toBe(false);
    });

    it('should reject oc_ prefix with wrong length (too short)', () => {
      expect(isValidChatId('oc_abc123')).toBe(false);
    });

    it('should reject oc_ prefix with wrong length (too long)', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7')).toBe(false);
    });

    it('should reject without prefix', () => {
      expect(isValidChatId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should reject with unknown prefix', () => {
      expect(isValidChatId('xx_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
    });

    it('should reject with special characters in the ID part', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5-')).toBe(false);
    });

    it('should reject with spaces', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5 ')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('non-string inputs', () => {
    it('should return error for null', () => {
      expect(getChatIdValidationError(null)).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for undefined', () => {
      expect(getChatIdValidationError(undefined)).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for empty string', () => {
      expect(getChatIdValidationError('')).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for number', () => {
      expect(getChatIdValidationError(123)).toBe('chatId is required and must be a non-empty string');
    });
  });

  describe('invalid format', () => {
    it('should return format error for random string', () => {
      const result = getChatIdValidationError('invalid-id');
      expect(result).toContain('Invalid chatId format');
      expect(result).toContain('invalid-id');
    });

    it('should return format error for wrong prefix', () => {
      const result = getChatIdValidationError('xx_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
      expect(result).toContain('Invalid chatId format');
    });

    it('should return format error for wrong length', () => {
      const result = getChatIdValidationError('oc_tooshort');
      expect(result).toContain('Invalid chatId format');
    });
  });

  describe('valid chat IDs', () => {
    it('should return null for valid oc_ chatId', () => {
      expect(getChatIdValidationError('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBeNull();
    });

    it('should return null for valid ou_ chatId', () => {
      expect(getChatIdValidationError('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBeNull();
    });
  });
});
