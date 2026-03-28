/**
 * Tests for chatId validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 *
 * Issue #1641: Agent tool calls fail silently or with unclear errors.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('valid chatIds', () => {
    it('should accept Feishu chat ID (oc_ prefix, 32 hex chars)', () => {
      expect(isValidChatId('oc_abcdef0123456789abcdef01234567')).toBe(true);
    });

    it('should accept Feishu user ID (ou_ prefix)', () => {
      expect(isValidChatId('ou_abcdef0123456789abcdef01234567')).toBe(true);
    });

    it('should accept Feishu bot ID (on_ prefix)', () => {
      expect(isValidChatId('on_abcdef0123456789abcdef01234567')).toBe(true);
    });

    it('should accept IDs with mixed case after prefix', () => {
      expect(isValidChatId('oc_AbCdEf0123456789abcdef01234567')).toBe(true);
    });

    it('should accept IDs with hyphens', () => {
      expect(isValidChatId('oc_abc-def0123456789abcdef01234567')).toBe(true);
    });

    it('should accept IDs with underscores in the identifier part', () => {
      expect(isValidChatId('oc_abc_def0123456789abcdef01234567')).toBe(true);
    });

    it('should accept shorter identifiers (5 chars)', () => {
      expect(isValidChatId('oc_abcde')).toBe(true);
    });

    it('should accept longer identifiers (64 chars)', () => {
      const id = 'oc_' + 'a'.repeat(64);
      expect(isValidChatId(id)).toBe(true);
    });

    it('should accept single-letter prefix', () => {
      expect(isValidChatId('a_abcdef0123456789')).toBe(true);
    });

    it('should accept 4-letter prefix', () => {
      expect(isValidChatId('chat_abcdef0123456789')).toBe(true);
    });
  });

  describe('invalid chatIds', () => {
    it('should reject empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should reject whitespace-only string', () => {
      expect(isValidChatId('   ')).toBe(false);
    });

    it('should reject string with spaces', () => {
      expect(isValidChatId('oc_abc 123')).toBe(false);
    });

    it('should reject string without underscore', () => {
      expect(isValidChatId('ocabcdef0123456789abcdef01234567')).toBe(false);
    });

    it('should reject URL', () => {
      expect(isValidChatId('https://example.com/chat/123')).toBe(false);
    });

    it('should reject plain random text', () => {
      expect(isValidChatId('randomtext')).toBe(false);
    });

    it('should reject too-short identifier (less than 5 chars after prefix)', () => {
      expect(isValidChatId('oc_ab')).toBe(false);
    });

    it('should reject too-long identifier (more than 64 chars after prefix)', () => {
      const id = 'oc_' + 'a'.repeat(65);
      expect(isValidChatId(id)).toBe(false);
    });

    it('should reject uppercase prefix', () => {
      expect(isValidChatId('OC_abcdef0123456789')).toBe(false);
    });

    it('should reject numeric prefix', () => {
      expect(isValidChatId('12_abcdef0123456789')).toBe(false);
    });

    it('should reject prefix longer than 4 chars', () => {
      expect(isValidChatId('extra_abcdef0123456789')).toBe(false);
    });

    it('should reject null', () => {
      expect(isValidChatId(null as unknown as string)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(isValidChatId(undefined as unknown as string)).toBe(false);
    });

    it('should reject number', () => {
      expect(isValidChatId(12345 as unknown as string)).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('valid chatIds return null', () => {
    it('should return null for valid Feishu chat ID', () => {
      expect(getChatIdValidationError('oc_abcdef0123456789abcdef01234567')).toBeNull();
    });

    it('should return null for valid user ID', () => {
      expect(getChatIdValidationError('ou_abcdef0123456789abcdef01234567')).toBeNull();
    });
  });

  describe('invalid chatIds return descriptive errors', () => {
    it('should return error for empty string', () => {
      expect(getChatIdValidationError('')).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for null', () => {
      expect(getChatIdValidationError(null as unknown as string)).toBe('chatId is required and must be a non-empty string');
    });

    it('should return error for leading/trailing whitespace', () => {
      expect(getChatIdValidationError(' oc_abcde ')).toContain('leading/trailing whitespace');
    });

    it('should return error for string with spaces', () => {
      expect(getChatIdValidationError('oc_abc def')).toContain('contains spaces');
    });

    it('should return URL-specific error for URLs', () => {
      expect(getChatIdValidationError('https://example.com')).toContain('looks like a URL');
    });

    it('should return prefix_identifier error for strings without underscore', () => {
      expect(getChatIdValidationError('randomtext')).toContain('prefix_identifier format');
    });

    it('should return prefix-specific error for long/invalid prefix', () => {
      expect(getChatIdValidationError('toolong_abcde')).toContain('prefix "toolong"');
    });

    it('should return generic format error for other invalid formats', () => {
      const error = getChatIdValidationError('oc_ab');
      expect(error).toContain('Invalid chatId format');
      expect(error).toBeTruthy();
    });
  });
});
