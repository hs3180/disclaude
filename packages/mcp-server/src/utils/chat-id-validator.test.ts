/**
 * Tests for chat ID validation utilities.
 *
 * Issue #1641: Agent tool calls fail silently or with unclear errors.
 */

import { describe, it, expect } from 'vitest';
import { isValidChatId, getChatIdValidationError } from './chat-id-validator.js';

describe('isValidChatId', () => {
  it('should return true for valid Feishu chat IDs', () => {
    expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(true);
  });

  it('should return true for valid chat IDs with uppercase hex', () => {
    // Pattern uses lowercase only, uppercase should fail
    expect(isValidChatId('oc_A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isValidChatId('')).toBe(false);
  });

  it('should return false for missing oc_ prefix', () => {
    expect(isValidChatId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
  });

  it('should return false for too short', () => {
    expect(isValidChatId('oc_abc123')).toBe(false);
  });

  it('should return false for too long', () => {
    expect(isValidChatId('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6extra')).toBe(false);
  });

  it('should return false for non-hex characters', () => {
    expect(isValidChatId('oc_g1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
  });

  it('should return false for ou_ prefix (user ID)', () => {
    expect(isValidChatId('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe(false);
  });

  it('should return false for random string', () => {
    expect(isValidChatId('invalid-id')).toBe(false);
  });
});

describe('getChatIdValidationError', () => {
  it('should return null for valid chat IDs', () => {
    expect(getChatIdValidationError('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBeNull();
  });

  it('should return error for empty string', () => {
    expect(getChatIdValidationError('')).toBe('chatId is required');
  });

  it('should return error for non-string type', () => {
    const result = getChatIdValidationError(123 as unknown as string);
    expect(result).toBe('chatId must be a string, got number');
  });

  it('should return error for missing oc_ prefix', () => {
    const result = getChatIdValidationError('ou_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
    expect(result).toContain('expected "oc_" prefix');
  });

  it('should return error for wrong length', () => {
    const result = getChatIdValidationError('oc_tooshort');
    expect(result).toContain('32 hex characters');
  });
});
