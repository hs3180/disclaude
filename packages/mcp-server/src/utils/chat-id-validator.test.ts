/**
 * Tests for chat ID validation utilities (packages/mcp-server/src/utils/chat-id-validator.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('Feishu group chat IDs (oc_)', () => {
    it('should return true for valid oc_ chatId', () => {
      expect(isValidChatId('oc_abc123def456')).toBe(true);
    });

    it('should return true for oc_ with hex chars', () => {
      expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
    });

    it('should return true for oc_ with hyphens', () => {
      expect(isValidChatId('oc_abc-123_def')).toBe(true);
    });

    it('should return false for oc_ prefix only', () => {
      expect(isValidChatId('oc_')).toBe(false);
    });

    it('should return false for oc_ with special chars', () => {
      expect(isValidChatId('oc_abc$%^')).toBe(false);
    });

    it('should return false for oc_ with spaces', () => {
      expect(isValidChatId('oc_abc def')).toBe(false);
    });
  });

  describe('Feishu private chat IDs (ou_)', () => {
    it('should return true for valid ou_ chatId', () => {
      expect(isValidChatId('ou_abc123def456')).toBe(true);
    });

    it('should return true for ou_ with hex chars', () => {
      expect(isValidChatId('ou_a1b2c3d4e5f6')).toBe(true);
    });

    it('should return false for ou_ prefix only', () => {
      expect(isValidChatId('ou_')).toBe(false);
    });
  });

  describe('CLI channel IDs (cli-)', () => {
    it('should return true for valid cli- chatId', () => {
      expect(isValidChatId('cli-12345')).toBe(true);
    });

    it('should return true for cli- with descriptive name', () => {
      expect(isValidChatId('cli-my-session')).toBe(true);
    });

    it('should return false for cli- prefix only', () => {
      expect(isValidChatId('cli-')).toBe(false);
    });
  });

  describe('REST channel IDs (no prefix)', () => {
    it('should return true for any non-empty string', () => {
      expect(isValidChatId('test-chat-123')).toBe(true);
    });

    it('should return true for UUID format', () => {
      expect(isValidChatId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should return true for simple string', () => {
      expect(isValidChatId('my-chat')).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should return false for empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should return false for null', () => {
      expect(isValidChatId(null as unknown as string)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isValidChatId(undefined as unknown as string)).toBe(false);
    });

    it('should return false for number', () => {
      expect(isValidChatId(123 as unknown as string)).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  describe('null and missing inputs', () => {
    it('should return error for empty string', () => {
      expect(getChatIdValidationError('')).toBe('chatId must be a non-empty string');
    });

    it('should return error for null', () => {
      expect(getChatIdValidationError(null)).toBe('chatId is required');
    });

    it('should return error for undefined', () => {
      expect(getChatIdValidationError(undefined)).toBe('chatId is required');
    });

    it('should return error for non-string type', () => {
      expect(getChatIdValidationError(123)).toBe('chatId must be a string, got number');
    });
  });

  describe('Feishu chatId validation', () => {
    it('should return error for oc_ prefix only', () => {
      const error = getChatIdValidationError('oc_');
      expect(error).toContain('Invalid Feishu group chatId');
      expect(error).toContain('oc_');
    });

    it('should return error for oc_ with invalid characters', () => {
      const error = getChatIdValidationError('oc_abc$%^');
      expect(error).toContain('Invalid Feishu group chatId format');
    });

    it('should return error for ou_ prefix only', () => {
      const error = getChatIdValidationError('ou_');
      expect(error).toContain('Invalid Feishu private chatId');
    });

    it('should return null for valid oc_ chatId', () => {
      expect(getChatIdValidationError('oc_abc123def456')).toBe(null);
    });

    it('should return null for valid ou_ chatId', () => {
      expect(getChatIdValidationError('ou_abc123def456')).toBe(null);
    });
  });

  describe('CLI chatId validation', () => {
    it('should return error for cli- prefix only', () => {
      const error = getChatIdValidationError('cli-');
      expect(error).toContain('Invalid CLI chatId');
    });

    it('should return null for valid cli- chatId', () => {
      expect(getChatIdValidationError('cli-12345')).toBe(null);
    });
  });

  describe('REST channel (no prefix)', () => {
    it('should return null for any non-empty string', () => {
      expect(getChatIdValidationError('any-chat-id')).toBe(null);
    });

    it('should return null for UUID', () => {
      expect(getChatIdValidationError('550e8400-e29b-41d4-a716-446655440000')).toBe(null);
    });
  });
});
