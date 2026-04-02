/**
 * Tests for chat ID validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 * @see https://github.com/hs3180/disclaude/issues/1641
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid chat IDs', () => {
    it('should return true for oc_ prefix with 32 hex chars (standard Feishu format)', () => {
      expect(isValidChatId('oc_abcdef0123456789abcdef01234567')).toBe(true);
    });

    it('should return true for oc_ prefix with 16 hex chars (minimum)', () => {
      expect(isValidChatId('oc_abcdef0123456789')).toBe(true);
    });

    it('should return true for oc_ prefix with more than 32 hex chars', () => {
      expect(isValidChatId('oc_abcdef0123456789abcdef0123456789abcdef01')).toBe(true);
    });

    it('should return true for all-zeros hex after oc_ prefix', () => {
      expect(isValidChatId('oc_0000000000000000')).toBe(true);
    });

    it('should return true for all-f hex after oc_ prefix', () => {
      expect(isValidChatId('oc_ffffffffffffffff')).toBe(true);
    });
  });

  describe('invalid chat IDs', () => {
    it('should return false for empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should return false for oc_ prefix only (no hex chars)', () => {
      expect(isValidChatId('oc_')).toBe(false);
    });

    it('should return false for oc_ prefix with fewer than 16 hex chars', () => {
      expect(isValidChatId('oc_abc123')).toBe(false);
    });

    it('should return false for string without oc_ prefix', () => {
      expect(isValidChatId('random_string')).toBe(false);
    });

    it('should return false for ou_ prefix (user ID, not chat ID)', () => {
      expect(isValidChatId('ou_abcdef0123456789abcdef01234567')).toBe(false);
    });

    it('should return false for on_ prefix (open notification ID)', () => {
      expect(isValidChatId('on_abcdef0123456789abcdef01234567')).toBe(false);
    });

    it('should return false for uppercase hex chars after oc_ prefix', () => {
      expect(isValidChatId('oc_ABCDEF0123456789abcdef01234567')).toBe(false);
    });

    it('should return false for non-hex chars after oc_ prefix', () => {
      expect(isValidChatId('oc_ghijklmnopqrstuvwxyz')).toBe(false);
    });

    it('should return false for oc_ prefix with spaces', () => {
      expect(isValidChatId('oc_ abc1234567890')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('valid chat IDs return null', () => {
    it('should return null for valid standard format', () => {
      expect(getChatIdValidationError('oc_abcdef0123456789abcdef01234567')).toBeNull();
    });

    it('should return null for valid minimum length', () => {
      expect(getChatIdValidationError('oc_abcdef0123456789')).toBeNull();
    });
  });

  describe('invalid chat IDs return error messages', () => {
    it('should return error for empty string', () => {
      expect(getChatIdValidationError('')).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for non-string (as string input)', () => {
      expect(getChatIdValidationError('')).toContain('chatId is required');
    });

    it('should return error for string without oc_ prefix', () => {
      const result = getChatIdValidationError('invalid_chat_id');
      expect(result).toContain('must start with "oc_"');
      expect(result).toContain('invalid_chat_id');
    });

    it('should return error for ou_ prefix', () => {
      const result = getChatIdValidationError('ou_abcdef0123456789abcdef01234567');
      expect(result).toContain('must start with "oc_"');
    });

    it('should return error for oc_ prefix with too few chars', () => {
      const result = getChatIdValidationError('oc_abc123');
      expect(result).toContain('must match pattern oc_<16+ hex chars>');
      expect(result).toContain('oc_abc123');
    });

    it('should return error for oc_ prefix with non-hex chars', () => {
      const result = getChatIdValidationError('oc_hello_world_test');
      expect(result).toContain('must match pattern oc_<16+ hex chars>');
    });
  });
});
