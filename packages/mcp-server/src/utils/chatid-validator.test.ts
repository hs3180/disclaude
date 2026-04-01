/**
 * Tests for chatId validation utilities (Issue #1641).
 *
 * Validates that chatId format checking works correctly for all known patterns:
 * - Feishu: oc_xxx (group), ou_xxx (user), on_xxx (bot)
 * - CLI: cli-xxx
 * - REST: UUID format
 */

import { describe, it, expect } from 'vitest';
import { validateChatId } from './chatid-validator.js';

describe('validateChatId', () => {
  describe('valid Feishu chatIds', () => {
    it('should accept oc_ prefix (group chat)', () => {
      expect(validateChatId('oc_abc123def456')).toBeNull();
    });

    it('should accept ou_ prefix (user)', () => {
      expect(validateChatId('ou_abc123def456')).toBeNull();
    });

    it('should accept on_ prefix (bot)', () => {
      expect(validateChatId('on_abc123def456')).toBeNull();
    });

    it('should accept short Feishu IDs', () => {
      expect(validateChatId('oc_x')).toBeNull();
      expect(validateChatId('ou_y')).toBeNull();
      expect(validateChatId('on_z')).toBeNull();
    });
  });

  describe('valid CLI chatIds', () => {
    it('should accept cli- prefix', () => {
      expect(validateChatId('cli-123')).toBeNull();
    });

    it('should accept cli- with long suffix', () => {
      expect(validateChatId('cli-agent-session-12345')).toBeNull();
    });
  });

  describe('valid REST chatIds (UUID)', () => {
    it('should accept lowercase UUID', () => {
      expect(validateChatId('123e4567-e89b-12d3-a456-426614174000')).toBeNull();
    });

    it('should accept uppercase UUID', () => {
      expect(validateChatId('123E4567-E89B-12D3-A456-426614174000')).toBeNull();
    });

    it('should accept mixed case UUID', () => {
      expect(validateChatId('123e4567-E89b-12d3-A456-426614174000')).toBeNull();
    });
  });

  describe('invalid chatIds', () => {
    it('should reject empty string', () => {
      const result = validateChatId('');
      expect(result).not.toBeNull();
      expect(result).toContain('non-empty string');
    });

    it('should reject random strings', () => {
      const result = validateChatId('invalid-id');
      expect(result).not.toBeNull();
      expect(result).toContain('Invalid chatId format');
      expect(result).toContain('invalid-id');
    });

    it('should reject partial prefix matches', () => {
      const result = validateChatId('oc');  // missing underscore
      expect(result).not.toBeNull();
    });

    it('should reject whitespace-only string', () => {
      const result = validateChatId('   ');
      expect(result).not.toBeNull();
    });

    it('should reject numbers', () => {
      const result = validateChatId('12345');
      expect(result).not.toBeNull();
    });

    it('should include helpful format hints in error message', () => {
      const result = validateChatId('bad-id');
      expect(result).toContain('oc_xxx');
      expect(result).toContain('ou_xxx');
      expect(result).toContain('on_xxx');
      expect(result).toContain('cli-xxx');
      expect(result).toContain('UUID');
    });
  });
});
