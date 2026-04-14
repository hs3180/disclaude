/**
 * Tests for chat schema validation functions.
 */

import { describe, it, expect } from 'vitest';
import {
  validateChatId,
  validateExpiresAt,
  validateGroupName,
  validateMembers,
  validateContext,
  validateResponder,
  validateResponseContent,
  validateChatFileData,
  parseChatFile,
  truncateGroupName,
  MAX_GROUP_NAME_LENGTH,
  MAX_RESPONSE_LENGTH,
  ValidationError,
} from '../schema.js';

describe('schema', () => {
  describe('validateChatId', () => {
    it('should accept valid chat IDs', () => {
      expect(() => validateChatId('pr-123')).not.toThrow();
      expect(() => validateChatId('test_chat')).not.toThrow();
      expect(() => validateChatId('my.chat')).not.toThrow();
      expect(() => validateChatId('a')).not.toThrow();
    });

    it('should reject empty chat ID', () => {
      expect(() => validateChatId('')).toThrow(ValidationError);
      expect(() => validateChatId('')).toThrow('required');
    });

    it('should reject chat ID with path traversal', () => {
      expect(() => validateChatId('../etc/passwd')).toThrow(ValidationError);
      expect(() => validateChatId('./hidden')).toThrow(ValidationError);
    });

    it('should reject chat ID starting with dot', () => {
      expect(() => validateChatId('.hidden')).toThrow(ValidationError);
    });
  });

  describe('validateExpiresAt', () => {
    it('should accept valid UTC Z-suffix timestamps', () => {
      expect(() => validateExpiresAt('2099-12-31T23:59:59Z')).not.toThrow();
    });

    it('should reject empty expiresAt', () => {
      expect(() => validateExpiresAt('')).toThrow(ValidationError);
    });

    it('should reject non-UTC timestamps', () => {
      expect(() => validateExpiresAt('2099-12-31T23:59:59+08:00')).toThrow(ValidationError);
      expect(() => validateExpiresAt('2099-12-31')).toThrow(ValidationError);
    });
  });

  describe('validateGroupName', () => {
    it('should accept valid group names', () => {
      expect(() => validateGroupName('PR Review')).not.toThrow();
      expect(() => validateGroupName('Test Group (Review)')).not.toThrow();
      expect(() => validateGroupName('Test（Fullwidth）【Brackets】')).not.toThrow();
      expect(() => validateGroupName('project:v2.0')).not.toThrow();
    });

    it('should reject empty group name', () => {
      expect(() => validateGroupName('')).toThrow(ValidationError);
    });

    it('should reject group names with unsafe characters', () => {
      expect(() => validateGroupName('test; rm -rf')).toThrow(ValidationError);
      expect(() => validateGroupName('test`cmd`')).toThrow(ValidationError);
    });
  });

  describe('validateMembers', () => {
    it('should accept valid member arrays', () => {
      const result = validateMembers(['ou_abc123', 'ou_def456']);
      expect(result).toEqual(['ou_abc123', 'ou_def456']);
    });

    it('should reject non-array input', () => {
      expect(() => validateMembers('ou_abc')).toThrow(ValidationError);
      expect(() => validateMembers(null)).toThrow(ValidationError);
    });

    it('should reject empty array', () => {
      expect(() => validateMembers([])).toThrow(ValidationError);
    });

    it('should reject invalid member IDs', () => {
      expect(() => validateMembers(['invalid'])).toThrow(ValidationError);
      expect(() => validateMembers(['ou_'])).toThrow(ValidationError);
      expect(() => validateMembers(['abc123'])).toThrow(ValidationError);
    });
  });

  describe('validateContext', () => {
    it('should accept valid objects', () => {
      expect(validateContext({ key: 'value' })).toEqual({ key: 'value' });
    });

    it('should default to empty object for null/undefined', () => {
      expect(validateContext(null)).toEqual({});
      expect(validateContext(undefined)).toEqual({});
    });

    it('should reject arrays', () => {
      expect(() => validateContext([1, 2, 3])).toThrow(ValidationError);
    });

    it('should reject oversized context', () => {
      const bigObj: Record<string, string> = {};
      for (let i = 0; i < 500; i++) {
        bigObj[`key${i}`] = 'x'.repeat(10);
      }
      expect(() => validateContext(bigObj)).toThrow(ValidationError);
      expect(() => validateContext(bigObj)).toThrow('too large');
    });
  });

  describe('validateResponder', () => {
    it('should accept valid responder IDs', () => {
      expect(() => validateResponder('ou_abc123')).not.toThrow();
    });

    it('should reject empty responder', () => {
      expect(() => validateResponder('')).toThrow(ValidationError);
    });

    it('should reject invalid format', () => {
      expect(() => validateResponder('invalid')).toThrow(ValidationError);
    });
  });

  describe('validateResponseContent', () => {
    it('should accept valid response text', () => {
      expect(() => validateResponseContent('Looks good!')).not.toThrow();
    });

    it('should reject empty response', () => {
      expect(() => validateResponseContent('')).toThrow(ValidationError);
    });

    it('should reject oversized response', () => {
      expect(() => validateResponseContent('x'.repeat(MAX_RESPONSE_LENGTH + 1))).toThrow(ValidationError);
    });
  });

  describe('validateChatFileData', () => {
    const validChat = {
      id: 'test-123',
      status: 'pending',
      chatId: null,
      createdAt: '2026-01-01T00:00:00Z',
      activatedAt: null,
      expiresAt: '2099-12-31T23:59:59Z',
      expiredAt: null,
      createGroup: { name: 'Test', members: ['ou_abc'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };

    it('should accept valid chat file data', () => {
      const result = validateChatFileData(validChat, '/path/to/test.json');
      expect(result.id).toBe('test-123');
      expect(result.status).toBe('pending');
    });

    it('should accept chat file with triggerMode: "always"', () => {
      const result = validateChatFileData(
        { ...validChat, triggerMode: 'always' },
        '/path/to/test.json',
      );
      expect(result.triggerMode).toBe('always');
    });

    it('should accept chat file with triggerMode: "mention"', () => {
      const result = validateChatFileData(
        { ...validChat, triggerMode: 'mention' },
        '/path/to/test.json',
      );
      expect(result.triggerMode).toBe('mention');
    });

    it('should accept chat file without triggerMode field', () => {
      const result = validateChatFileData(validChat, '/path/to/test.json');
      expect(result.triggerMode).toBeUndefined();
    });

    it('should reject non-object input', () => {
      expect(() => validateChatFileData(null, '/path')).toThrow(ValidationError);
      expect(() => validateChatFileData('string', '/path')).toThrow(ValidationError);
    });

    it('should reject missing required fields', () => {
      expect(() => validateChatFileData({}, '/path')).toThrow(ValidationError);
    });

    it('should reject invalid status', () => {
      expect(() => validateChatFileData({ ...validChat, status: 'unknown' }, '/path')).toThrow(ValidationError);
    });

    it('should accept expiredAt as null', () => {
      const result = validateChatFileData({ ...validChat, expiredAt: null }, '/path');
      expect(result.expiredAt).toBeNull();
    });

    it('should accept expiredAt as valid UTC Z-suffix timestamp', () => {
      const result = validateChatFileData({ ...validChat, expiredAt: '2026-03-25T10:00:00Z' }, '/path');
      expect(result.expiredAt).toBe('2026-03-25T10:00:00Z');
    });

    it('should reject expiredAt with non-UTC timestamp', () => {
      expect(() => validateChatFileData({ ...validChat, expiredAt: '2026-03-25T10:00:00+08:00' }, '/path')).toThrow(ValidationError);
    });

    it('should reject expiredAt with invalid type', () => {
      expect(() => validateChatFileData({ ...validChat, expiredAt: 12345 }, '/path')).toThrow(ValidationError);
    });
  });

  describe('parseChatFile', () => {
    it('should parse valid JSON', () => {
      const json = JSON.stringify({
        id: 'test-123',
        status: 'pending',
        chatId: null,
        createdAt: '2026-01-01T00:00:00Z',
        activatedAt: null,
        expiresAt: '2099-12-31T23:59:59Z',
        expiredAt: null,
        createGroup: { name: 'Test', members: ['ou_abc'] },
        context: {},
        response: null,
        activationAttempts: 0,
        lastActivationError: null,
        failedAt: null,
      });
      const result = parseChatFile(json, '/path/to/test.json');
      expect(result.id).toBe('test-123');
    });

    it('should reject invalid JSON', () => {
      expect(() => parseChatFile('not json', '/path')).toThrow(ValidationError);
    });
  });

  describe('truncateGroupName', () => {
    it('should truncate long names at character boundaries', () => {
      const longName = 'A'.repeat(100);
      const result = truncateGroupName(longName);
      expect(result.length).toBe(MAX_GROUP_NAME_LENGTH);
    });

    it('should not truncate short names', () => {
      expect(truncateGroupName('Test')).toBe('Test');
    });

    it('should handle multi-byte characters correctly', () => {
      const emojiName = '🎉'.repeat(100);
      const result = truncateGroupName(emojiName);
      expect(Array.from(result).length).toBe(MAX_GROUP_NAME_LENGTH);
    });
  });
});
