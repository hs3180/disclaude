/**
 * Tests for chat ID validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid chat IDs', () => {
    it('should accept oc_ prefix with 32 hex chars', () => {
      expect(isValidChatId('oc_' + 'a'.repeat(32))).toBe(true);
    });

    it('should accept ou_ prefix with 32 hex chars', () => {
      expect(isValidChatId('ou_' + 'b'.repeat(32))).toBe(true);
    });

    it('should accept mixed case hex chars', () => {
      expect(isValidChatId('oc_' + 'aB1c2D3e4F5f6A7b8C9d0E1e2F3a4B5c')).toBe(true);
    });

    it('should accept all-zeros hex chars', () => {
      expect(isValidChatId('oc_' + '0'.repeat(32))).toBe(true);
    });

    it('should accept all-f hex chars', () => {
      expect(isValidChatId('oc_' + 'f'.repeat(32))).toBe(true);
    });
  });

  describe('invalid chat IDs', () => {
    it('should reject empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should reject plain string without prefix', () => {
      expect(isValidChatId('invalid')).toBe(false);
    });

    it('should reject oc_ with too few hex chars', () => {
      expect(isValidChatId('oc_' + 'a'.repeat(31))).toBe(false);
    });

    it('should reject oc_ with too many hex chars', () => {
      expect(isValidChatId('oc_' + 'a'.repeat(33))).toBe(false);
    });

    it('should reject oc_ with non-hex characters', () => {
      expect(isValidChatId('oc_' + 'g'.repeat(32))).toBe(false);
    });

    it('should reject oc_ prefix only', () => {
      expect(isValidChatId('oc_')).toBe(false);
    });

    it('should reject with wrong prefix', () => {
      expect(isValidChatId('xx_' + 'a'.repeat(32))).toBe(false);
    });

    it('should reject numeric-only ID', () => {
      expect(isValidChatId('12345')).toBe(false);
    });

    it('should reject UUID format', () => {
      expect(isValidChatId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('valid chat IDs', () => {
    it('should return null for valid oc_ chat ID', () => {
      expect(getChatIdValidationError('oc_' + 'a'.repeat(32))).toBeNull();
    });

    it('should return null for valid ou_ chat ID', () => {
      expect(getChatIdValidationError('ou_' + 'b'.repeat(32))).toBeNull();
    });
  });

  describe('invalid inputs', () => {
    it('should return error for null', () => {
      expect(getChatIdValidationError(null)).toContain('required');
    });

    it('should return error for undefined', () => {
      expect(getChatIdValidationError(undefined)).toContain('required');
    });

    it('should return error for empty string', () => {
      expect(getChatIdValidationError('')).toContain('required');
    });

    it('should return error for non-string', () => {
      expect(getChatIdValidationError(123)).toContain('required');
    });

    it('should return error for wrong prefix', () => {
      const err = getChatIdValidationError('invalid_id');
      expect(err).toContain('Invalid chatId format');
      expect(err).toContain('expected Feishu ID');
    });

    it('should return error for oc_ with wrong length', () => {
      const err = getChatIdValidationError('oc_' + 'a'.repeat(16));
      expect(err).toContain('Invalid chatId format');
      expect(err).toContain('pattern');
    });

    it('should return error for oc_ with non-hex chars', () => {
      const err = getChatIdValidationError('oc_' + 'g'.repeat(32));
      expect(err).toContain('Invalid chatId format');
    });
  });
});
