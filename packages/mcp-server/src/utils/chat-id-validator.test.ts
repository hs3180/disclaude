/**
 * Tests for chat ID validation utilities.
 *
 * @see https://github.com/hs3180/disclaude/issues/1641
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  isValidChatId,
  getChatIdValidationError,
  registerChatIdPattern,
  resetChatIdPatterns,
  getChatIdPatterns,
} from './chat-id-validator.js';

describe('isValidChatId', () => {
  describe('Feishu group chat IDs (oc_)', () => {
    it('should accept a valid oc_ group chat ID', () => {
      const chatId = `oc_${'a'.repeat(32)}`;
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should accept an oc_ ID with mixed hex chars', () => {
      const chatId = `oc_${'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'}`;
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should reject an oc_ ID that is too short', () => {
      const chatId = 'oc_abc';
      expect(isValidChatId(chatId)).toBe(false);
    });

    it('should reject an oc_ ID with spaces', () => {
      const chatId = `oc_${'a'.repeat(32)} `;
      expect(isValidChatId(chatId)).toBe(false);
    });
  });

  describe('Feishu user IDs (ou_)', () => {
    it('should accept a valid ou_ user chat ID', () => {
      const chatId = `ou_${'f'.repeat(32)}`;
      expect(isValidChatId(chatId)).toBe(true);
    });

    it('should reject an ou_ ID that is too short', () => {
      const chatId = 'ou_123';
      expect(isValidChatId(chatId)).toBe(false);
    });
  });

  describe('CLI session IDs (cli-)', () => {
    it('should accept a valid cli- session ID', () => {
      expect(isValidChatId('cli-abc123')).toBe(true);
    });

    it('should accept a minimal cli- ID', () => {
      expect(isValidChatId('cli-x')).toBe(true);
    });

    it('should reject a bare cli- prefix with nothing after it', () => {
      expect(isValidChatId('cli-')).toBe(false);
    });
  });

  describe('test- IDs (not built-in, Issue #2389)', () => {
    it('should reject test- IDs by default (no production test patterns)', () => {
      expect(isValidChatId('test-use-case-2-files-12345')).toBe(false);
    });

    it('should reject test-multimodal-* IDs by default', () => {
      expect(isValidChatId('test-multimodal-12345')).toBe(false);
    });

    it('should reject a bare test- prefix', () => {
      expect(isValidChatId('test-')).toBe(false);
    });
  });

  describe('invalid formats', () => {
    it('should reject an empty string', () => {
      expect(isValidChatId('')).toBe(false);
    });

    it('should reject a random string', () => {
      expect(isValidChatId('not-a-valid-id')).toBe(false);
    });

    it('should reject a numeric string', () => {
      expect(isValidChatId('1234567890')).toBe(false);
    });

    it('should reject a string with unknown prefix', () => {
      expect(isValidChatId('xx_abcdef1234567890')).toBe(false);
    });
  });
});

describe('getChatIdValidationError', () => {
  it('should return null for a valid oc_ chat ID', () => {
    const chatId = `oc_${'a'.repeat(32)}`;
    expect(getChatIdValidationError(chatId)).toBeNull();
  });

  it('should return null for a valid ou_ chat ID', () => {
    const chatId = `ou_${'b'.repeat(32)}`;
    expect(getChatIdValidationError(chatId)).toBeNull();
  });

  it('should return null for a valid cli- session ID', () => {
    expect(getChatIdValidationError('cli-session-42')).toBeNull();
  });

  it('should return an error for a test- ID (removed from production, Issue #2389)', () => {
    const error = getChatIdValidationError('test-mcp-send-text-12345');
    expect(error).not.toBeNull();
  });

  it('should return an error for an empty string', () => {
    const error = getChatIdValidationError('');
    expect(error).not.toBeNull();
    expect(error).toContain('required');
  });

  it('should return an error describing the expected formats', () => {
    const error = getChatIdValidationError('invalid-id');
    expect(error).not.toBeNull();
    expect(error).toContain('oc_');
    expect(error).toContain('ou_');
    expect(error).toContain('cli-');
    // test- should NOT appear in production error messages (Issue #2389)
    expect(error).not.toContain('test-');
  });

  it('should truncate long chatIds in error messages', () => {
    const longId = `invalid_${'x'.repeat(50)}`;
    const error = getChatIdValidationError(longId);
    expect(error).not.toBeNull();
    // The error should not contain the full 60-char string
    expect(error).not.toContain(longId);
    expect(error).toContain('...');
  });
});

describe('registerChatIdPattern / resetChatIdPatterns', () => {
  afterEach(() => {
    resetChatIdPatterns();
  });

  it('should allow registering a custom pattern', () => {
    registerChatIdPattern({ prefix: 'test-', label: 'Integration test session', minLength: 10 });
    expect(isValidChatId('test-use-case-1-12345')).toBe(true);
  });

  it('should include custom pattern in error messages', () => {
    registerChatIdPattern({ prefix: 'test-', label: 'Integration test session', minLength: 10 });
    expect(getChatIdValidationError('test-mcp-send-text-12345')).toBeNull();
  });

  it('should reset to production defaults', () => {
    registerChatIdPattern({ prefix: 'custom-', label: 'Custom', minLength: 8 });
    expect(isValidChatId('custom-abc')).toBe(true);

    resetChatIdPatterns();
    expect(isValidChatId('custom-abc')).toBe(false);
  });

  it('should not affect other patterns when registering', () => {
    registerChatIdPattern({ prefix: 'test-', label: 'Integration test session', minLength: 10 });

    // Production patterns still work
    expect(isValidChatId(`oc_${'a'.repeat(32)}`)).toBe(true);
    expect(isValidChatId('cli-session')).toBe(true);

    // Custom pattern also works
    expect(isValidChatId('test-multimodal-12345')).toBe(true);
  });

  it('getChatIdPatterns should return current patterns', () => {
    const before = getChatIdPatterns();
    expect(before).toHaveLength(3); // oc_, ou_, cli-

    registerChatIdPattern({ prefix: 'test-', label: 'Test', minLength: 10 });
    const after = getChatIdPatterns();
    expect(after).toHaveLength(4);
    expect(after[3].prefix).toBe('test-');
  });

  it('should be safe to call resetChatIdPatterns multiple times', () => {
    resetChatIdPatterns();
    resetChatIdPatterns();
    expect(getChatIdPatterns()).toHaveLength(3);
  });
});
