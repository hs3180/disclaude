/**
 * Unit tests for scripts/chat/schema.ts
 *
 * Tests all validation functions, type guards, and utility functions
 * used by the chat lifecycle scripts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateChatId,
  validateExpiresAt,
  validateGroupName,
  validateMembers,
  validateContext,
  validateResponder,
  validateResponseContent,
  parseChatFile,
  validateChatFileData,
  nowISO,
  truncateGroupName,
  ValidationError,
  CHAT_ID_REGEX,
  MEMBER_ID_REGEX,
  GROUP_NAME_REGEX,
  UTC_DATETIME_REGEX,
  MAX_GROUP_NAME_LENGTH,
  MAX_CONTEXT_SIZE,
  MAX_RESPONSE_LENGTH,
  type ChatFile,
} from './schema.js';

// ---- validateChatId ----

describe('validateChatId', () => {
  it('accepts valid chat IDs', () => {
    expect(() => validateChatId('pr-123')).not.toThrow();
    expect(() => validateChatId('deploy_456')).not.toThrow();
    expect(() => validateChatId('ask.review')).not.toThrow();
    expect(() => validateChatId('a')).not.toThrow();
  });

  it('rejects empty chat ID', () => {
    expect(() => validateChatId('')).toThrow(ValidationError);
    expect(() => validateChatId('')).toThrow('CHAT_ID environment variable is required');
  });

  it('rejects chat ID with leading dot', () => {
    expect(() => validateChatId('.hidden')).toThrow(ValidationError);
  });

  it('rejects chat ID with path traversal', () => {
    expect(() => validateChatId('../etc/passwd')).toThrow(ValidationError);
    expect(() => validateChatId('foo/bar')).toThrow(ValidationError);
  });

  it('rejects chat ID with special characters', () => {
    expect(() => validateChatId('chat with spaces')).toThrow(ValidationError);
    expect(() => validateChatId('chat;rm -rf')).toThrow(ValidationError);
  });

  it('CHAT_ID_REGEX matches valid patterns', () => {
    expect(CHAT_ID_REGEX.test('pr-123')).toBe(true);
    expect(CHAT_ID_REGEX.test('a_b.c-d')).toBe(true);
    expect(CHAT_ID_REGEX.test('.hidden')).toBe(false);
    expect(CHAT_ID_REGEX.test('../traversal')).toBe(false);
  });
});

// ---- validateExpiresAt ----

describe('validateExpiresAt', () => {
  it('accepts valid UTC Z-suffix timestamps', () => {
    expect(() => validateExpiresAt('2026-03-25T10:00:00Z')).not.toThrow();
    expect(() => validateExpiresAt('2099-12-31T23:59:59Z')).not.toThrow();
  });

  it('rejects empty value', () => {
    expect(() => validateExpiresAt('')).toThrow(ValidationError);
    expect(() => validateExpiresAt('')).toThrow('CHAT_EXPIRES_AT environment variable is required');
  });

  it('rejects non-UTC formats', () => {
    expect(() => validateExpiresAt('2026-03-25T10:00:00+08:00')).toThrow(ValidationError);
    expect(() => validateExpiresAt('2026-03-25')).toThrow(ValidationError);
    expect(() => validateExpiresAt('not-a-date')).toThrow(ValidationError);
  });

  it('UTC_DATETIME_REGEX validates format', () => {
    expect(UTC_DATETIME_REGEX.test('2026-03-25T10:00:00Z')).toBe(true);
    expect(UTC_DATETIME_REGEX.test('2026-03-25T10:00:00+08:00')).toBe(false);
    expect(UTC_DATETIME_REGEX.test('2026-03-25')).toBe(false);
  });
});

// ---- validateGroupName ----

describe('validateGroupName', () => {
  it('accepts valid group names', () => {
    expect(() => validateGroupName('PR #123 Review')).not.toThrow();
    expect(() => validateGroupName('Group (2026)')).not.toThrow();
    expect(() => validateGroupName('Test（Fullwidth）【Brackets】')).not.toThrow();
    expect(() => validateGroupName('project:v2.0')).not.toThrow();
  });

  it('rejects empty name', () => {
    expect(() => validateGroupName('')).toThrow(ValidationError);
    expect(() => validateGroupName('')).toThrow('CHAT_GROUP_NAME environment variable is required');
  });

  it('rejects names with unsafe characters', () => {
    expect(() => validateGroupName('name<script>')).toThrow(ValidationError);
    expect(() => validateGroupName('name&evil')).toThrow(ValidationError);
  });

  it('GROUP_NAME_REGEX validates patterns', () => {
    expect(GROUP_NAME_REGEX.test('PR #123 Review')).toBe(true);
    expect(GROUP_NAME_REGEX.test('Test（Fullwidth）【Brackets】')).toBe(true);
    expect(GROUP_NAME_REGEX.test('name<script>')).toBe(false);
  });
});

// ---- validateMembers ----

describe('validateMembers', () => {
  it('accepts valid member arrays', () => {
    const result = validateMembers(['ou_abc123', 'ou_def456']);
    expect(result).toEqual(['ou_abc123', 'ou_def456']);
  });

  it('rejects non-array input', () => {
    expect(() => validateMembers('not-array')).toThrow(ValidationError);
    expect(() => validateMembers(null)).toThrow(ValidationError);
  });

  it('rejects empty array', () => {
    expect(() => validateMembers([])).toThrow(ValidationError);
  });

  it('rejects invalid member IDs', () => {
    expect(() => validateMembers(['invalid'])).toThrow(ValidationError);
    expect(() => validateMembers(['ou_'])).toThrow(ValidationError);
    expect(() => validateMembers([{ id: 'ou_123' }])).toThrow(ValidationError);
  });

  it('MEMBER_ID_REGEX validates format', () => {
    expect(MEMBER_ID_REGEX.test('ou_abc123')).toBe(true);
    expect(MEMBER_ID_REGEX.test('ou_')).toBe(false);
    expect(MEMBER_ID_REGEX.test('invalid')).toBe(false);
  });
});

// ---- validateContext ----

describe('validateContext', () => {
  it('returns empty object for undefined', () => {
    expect(validateContext(undefined)).toEqual({});
  });

  it('returns empty object for null', () => {
    expect(validateContext(null)).toEqual({});
  });

  it('accepts valid objects', () => {
    const ctx = validateContext({ prNumber: 123, repo: 'test/repo' });
    expect(ctx).toEqual({ prNumber: 123, repo: 'test/repo' });
  });

  it('rejects arrays', () => {
    expect(() => validateContext([1, 2, 3])).toThrow(ValidationError);
  });

  it('rejects oversized context', () => {
    const bigObj: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      bigObj[`key${i}`] = 'x'.repeat(50);
    }
    expect(JSON.stringify(bigObj).length).toBeGreaterThan(MAX_CONTEXT_SIZE);
    expect(() => validateContext(bigObj)).toThrow(ValidationError);
    expect(() => validateContext(bigObj)).toThrow('too large');
  });

  it('accepts context at size limit', () => {
    // Ensure the total JSON size is under the limit
    const value = 'x'.repeat(MAX_CONTEXT_SIZE - 20); // account for key + braces
    const obj: Record<string, string> = { d: value };
    expect(JSON.stringify(obj).length).toBeLessThanOrEqual(MAX_CONTEXT_SIZE);
    expect(() => validateContext(obj)).not.toThrow();
  });
});

// ---- validateResponder ----

describe('validateResponder', () => {
  it('accepts valid responder IDs', () => {
    expect(() => validateResponder('ou_developer123')).not.toThrow();
  });

  it('rejects empty value', () => {
    expect(() => validateResponder('')).toThrow(ValidationError);
  });

  it('rejects invalid format', () => {
    expect(() => validateResponder('invalid')).toThrow(ValidationError);
    expect(() => validateResponder('ou_')).toThrow(ValidationError);
  });
});

// ---- validateResponseContent ----

describe('validateResponseContent', () => {
  it('accepts valid response text', () => {
    expect(() => validateResponseContent('Looks good, approve it')).not.toThrow();
  });

  it('rejects empty response', () => {
    expect(() => validateResponseContent('')).toThrow(ValidationError);
  });

  it('rejects oversized response', () => {
    const longText = 'x'.repeat(MAX_RESPONSE_LENGTH + 1);
    expect(() => validateResponseContent(longText)).toThrow(ValidationError);
    expect(() => validateResponseContent(longText)).toThrow('too long');
  });

  it('accepts response at max length', () => {
    const maxText = 'x'.repeat(MAX_RESPONSE_LENGTH);
    expect(() => validateResponseContent(maxText)).not.toThrow();
  });
});

// ---- parseChatFile ----

describe('parseChatFile', () => {
  const validChatJSON = JSON.stringify({
    id: 'pr-123',
    status: 'pending',
    chatId: null,
    createdAt: '2026-03-24T10:00:00Z',
    activatedAt: null,
    expiresAt: '2026-03-25T10:00:00Z',
    createGroup: { name: 'PR #123 Review', members: ['ou_developer'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
  });

  it('parses valid chat file JSON', () => {
    const chat = parseChatFile(validChatJSON, 'pr-123.json');
    expect(chat.id).toBe('pr-123');
    expect(chat.status).toBe('pending');
    expect(chat.createGroup.name).toBe('PR #123 Review');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseChatFile('not json', 'bad.json')).toThrow(ValidationError);
    expect(() => parseChatFile('not json', 'bad.json')).toThrow('not valid JSON');
  });

  it('rejects missing required fields', () => {
    const minimal = JSON.stringify({ id: 'test' });
    expect(() => parseChatFile(minimal, 'minimal.json')).toThrow(ValidationError);
  });

  it('rejects invalid status', () => {
    const invalidStatus = JSON.stringify({
      ...JSON.parse(validChatJSON),
      status: 'unknown',
    });
    expect(() => parseChatFile(invalidStatus, 'bad-status.json')).toThrow(ValidationError);
    expect(() => parseChatFile(invalidStatus, 'bad-status.json')).toThrow("invalid 'status'");
  });

  it('rejects invalid expiresAt format', () => {
    const badExpiry = JSON.stringify({
      ...JSON.parse(validChatJSON),
      expiresAt: '2026-03-25T10:00:00+08:00',
    });
    expect(() => parseChatFile(badExpiry, 'bad-expiry.json')).toThrow(ValidationError);
  });

  it('rejects invalid createGroup', () => {
    const badGroup = JSON.stringify({
      ...JSON.parse(validChatJSON),
      createGroup: { name: 'Test' }, // missing members
    });
    expect(() => parseChatFile(badGroup, 'bad-group.json')).toThrow(ValidationError);
  });

  it('rejects invalid member IDs in createGroup', () => {
    const badMembers = JSON.stringify({
      ...JSON.parse(validChatJSON),
      createGroup: { name: 'Test', members: ['invalid'] },
    });
    expect(() => parseChatFile(badMembers, 'bad-members.json')).toThrow(ValidationError);
  });

  it('rejects non-object input', () => {
    expect(() => parseChatFile('null', 'null.json')).toThrow(ValidationError);
    expect(() => parseChatFile('"string"', 'string.json')).toThrow(ValidationError);
    expect(() => parseChatFile('[1,2,3]', 'array.json')).toThrow(ValidationError);
  });
});

// ---- validateChatFileData ----

describe('validateChatFileData', () => {
  it('validates a properly structured object', () => {
    const obj = {
      id: 'test-123',
      status: 'active',
      chatId: 'oc_xxx',
      createdAt: '2026-03-24T10:00:00Z',
      activatedAt: '2026-03-24T10:01:00Z',
      expiresAt: '2026-03-25T10:00:00Z',
      createGroup: { name: 'Test Group', members: ['ou_abc'] },
      context: { key: 'value' },
      response: { content: 'approved', responder: 'ou_abc', repliedAt: '2026-03-24T12:00:00Z' },
      activationAttempts: 1,
      lastActivationError: null,
      failedAt: null,
    };
    const chat = validateChatFileData(obj, 'test.json');
    expect(chat.id).toBe('test-123');
    expect(chat.status).toBe('active');
    expect(chat.response?.content).toBe('approved');
  });

  it('rejects invalid chatId type', () => {
    const obj = {
      id: 'test',
      status: 'pending',
      expiresAt: '2026-03-25T10:00:00Z',
      createGroup: { name: 'Test', members: ['ou_abc'] },
      chatId: 123, // should be string or null
    };
    expect(() => validateChatFileData(obj, 'test.json')).toThrow(ValidationError);
  });

  it('rejects negative activationAttempts', () => {
    const obj = {
      id: 'test',
      status: 'pending',
      expiresAt: '2026-03-25T10:00:00Z',
      createGroup: { name: 'Test', members: ['ou_abc'] },
      activationAttempts: -1,
    };
    expect(() => validateChatFileData(obj, 'test.json')).toThrow(ValidationError);
  });
});

// ---- nowISO ----

describe('nowISO', () => {
  it('returns a valid ISO 8601 Z-suffix string', () => {
    const result = nowISO();
    expect(result).toMatch(UTC_DATETIME_REGEX);
  });

  it('returns current time', () => {
    const before = new Date();
    const result = nowISO();
    const after = new Date();
    const parsed = new Date(result);
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(parsed.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ---- truncateGroupName ----

describe('truncateGroupName', () => {
  it('does not truncate short names', () => {
    expect(truncateGroupName('Short')).toBe('Short');
  });

  it('truncates at character boundary', () => {
    const longName = 'A'.repeat(100);
    const truncated = truncateGroupName(longName);
    expect(truncated.length).toBe(MAX_GROUP_NAME_LENGTH);
    expect(truncated).toBe('A'.repeat(MAX_GROUP_NAME_LENGTH));
  });

  it('handles multi-byte characters correctly', () => {
    // Each emoji is 2 UTF-16 code units
    const emojiName = 'Group'.padEnd(MAX_GROUP_NAME_LENGTH + 10, '😀');
    const truncated = truncateGroupName(emojiName);
    expect(Array.from(truncated).length).toBeLessThanOrEqual(MAX_GROUP_NAME_LENGTH);
  });
});

// ---- ValidationError ----

describe('ValidationError', () => {
  it('is an Error instance', () => {
    const err = new ValidationError('test error');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('has correct name and message', () => {
    const err = new ValidationError('validation failed');
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('validation failed');
  });
});
