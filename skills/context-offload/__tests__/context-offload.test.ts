/**
 * Tests for skills/context-offload/context-offload.ts
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 *
 * Tests cover:
 * - Input validation (chat ID, open ID, required fields)
 * - Group name truncation (CJK-safe)
 * - Regex patterns for valid/invalid IDs
 */

import { describe, it, expect } from 'vitest';
import {
  validateRequired,
  validateChatId,
  validateOpenId,
  truncateGroupName,
  ValidationError,
  CHAT_ID_REGEX,
  OPEN_ID_REGEX,
  MAX_GROUP_NAME_LENGTH,
} from '../context-offload.js';

describe('context-offload validation', () => {
  describe('validateRequired', () => {
    it('should return the value when present', () => {
      expect(validateRequired('hello', 'TEST_VAR')).toBe('hello');
    });

    it('should throw ValidationError when value is undefined', () => {
      expect(() => validateRequired(undefined, 'TEST_VAR')).toThrow(ValidationError);
      expect(() => validateRequired(undefined, 'TEST_VAR')).toThrow('TEST_VAR environment variable is required');
    });

    it('should throw ValidationError when value is empty string', () => {
      expect(() => validateRequired('', 'TEST_VAR')).toThrow(ValidationError);
    });
  });

  describe('validateChatId', () => {
    it('should accept valid oc_xxx format', () => {
      expect(() => validateChatId('oc_abc123')).not.toThrow();
      expect(() => validateChatId('oc_ABC123')).not.toThrow();
      expect(() => validateChatId('oc_1234567890')).not.toThrow();
    });

    it('should reject invalid chat IDs', () => {
      expect(() => validateChatId('invalid')).toThrow(ValidationError);
      expect(() => validateChatId('invalid')).toThrow('oc_xxx format');
    });

    it('should reject plain strings without oc_ prefix', () => {
      expect(() => validateChatId('abc123')).toThrow();
    });

    it('should reject oc_ with special characters', () => {
      expect(() => validateChatId('oc_abc-123')).toThrow();
      expect(() => validateChatId('oc_abc.123')).toThrow();
      expect(() => validateChatId('oc_')).toThrow();
    });
  });

  describe('validateOpenId', () => {
    it('should accept valid ou_xxx format', () => {
      expect(() => validateOpenId('ou_abc123')).not.toThrow();
      expect(() => validateOpenId('ou_ABCXYZ')).not.toThrow();
    });

    it('should reject invalid open IDs', () => {
      expect(() => validateOpenId('invalid')).toThrow(ValidationError);
      expect(() => validateOpenId('invalid')).toThrow('ou_xxx format');
    });

    it('should reject ou_ with special characters', () => {
      expect(() => validateOpenId('ou_abc-def')).toThrow();
      expect(() => validateOpenId('ou_')).toThrow();
    });
  });

  describe('truncateGroupName', () => {
    it('should not truncate short names', () => {
      expect(truncateGroupName('Hello')).toBe('Hello');
      expect(truncateGroupName('测试群组')).toBe('测试群组');
    });

    it('should truncate names exceeding MAX_GROUP_NAME_LENGTH', () => {
      const longName = 'a'.repeat(100);
      expect(truncateGroupName(longName)).toBe('a'.repeat(MAX_GROUP_NAME_LENGTH));
      expect(truncateGroupName(longName).length).toBe(MAX_GROUP_NAME_LENGTH);
    });

    it('should handle CJK characters correctly (not split surrogate pairs)', () => {
      const cjkName = '中'.repeat(100);
      const truncated = truncateGroupName(cjkName);
      expect(truncated.length).toBe(MAX_GROUP_NAME_LENGTH);
      // Each CJK character should be intact
      expect([...truncated].every(c => c === '中')).toBe(true);
    });

    it('should handle mixed ASCII and CJK characters', () => {
      const mixedName = 'PR #123 Review - 代号审查 ' + 'x'.repeat(100);
      const truncated = truncateGroupName(mixedName);
      expect([...truncated].length).toBeLessThanOrEqual(MAX_GROUP_NAME_LENGTH);
    });

    it('should preserve exact name at boundary', () => {
      const boundaryName = 'a'.repeat(MAX_GROUP_NAME_LENGTH);
      expect(truncateGroupName(boundaryName)).toBe(boundaryName);
    });
  });

  describe('CHAT_ID_REGEX', () => {
    it('should match valid chat IDs', () => {
      expect(CHAT_ID_REGEX.test('oc_abc123')).toBe(true);
      expect(CHAT_ID_REGEX.test('oc_ABCXYZ123')).toBe(true);
    });

    it('should not match invalid chat IDs', () => {
      expect(CHAT_ID_REGEX.test('')).toBe(false);
      expect(CHAT_ID_REGEX.test('abc')).toBe(false);
      expect(CHAT_ID_REGEX.test('oc_')).toBe(false);
      expect(CHAT_ID_REGEX.test('oc_abc-def')).toBe(false);
    });
  });

  describe('OPEN_ID_REGEX', () => {
    it('should match valid open IDs', () => {
      expect(OPEN_ID_REGEX.test('ou_abc123')).toBe(true);
      expect(OPEN_ID_REGEX.test('ou_ABCXYZ')).toBe(true);
    });

    it('should not match invalid open IDs', () => {
      expect(OPEN_ID_REGEX.test('')).toBe(false);
      expect(OPEN_ID_REGEX.test('abc')).toBe(false);
      expect(OPEN_ID_REGEX.test('ou_')).toBe(false);
    });
  });
});
