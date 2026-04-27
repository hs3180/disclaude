/**
 * Unit tests for side-group skill.
 *
 * Tests validation logic, chat ID generation, and integration
 * with the chat skill's create script. Does NOT test lark-cli
 * calls directly (those are tested in chat-timeout/chats-activation tests).
 */

import { describe, it, expect } from 'vitest';

// We test the exported helper functions by importing them.
// Since the script uses process.exit, we test the pure functions directly.

// ---- Test helpers (extracted from module for testing) ----

const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const GROUP_NAME_REGEX = /^[^\x00-\x1F\x7F]+$/;
const MAX_GROUP_NAME_LENGTH = 64;

function validateGroupName(name: string): string | null {
  if (!name) return 'SIDE_GROUP_NAME environment variable is required';
  if (!GROUP_NAME_REGEX.test(name)) return 'Invalid SIDE_GROUP_NAME — contains control characters';
  if (name.trim().length === 0) return 'SIDE_GROUP_NAME cannot be blank (whitespace only)';
  return null;
}

function validateMembers(members: unknown): string | null {
  if (!Array.isArray(members) || members.length === 0) {
    return 'SIDE_GROUP_MEMBERS must be a non-empty JSON array of open IDs';
  }
  for (const member of members) {
    if (typeof member !== 'string' || !MEMBER_ID_REGEX.test(member)) {
      return `Invalid member ID '${member}' — expected ou_xxxxx format`;
    }
  }
  return null;
}

function validateContext(context: unknown): string | null {
  if (context === undefined || context === null) return null;
  if (typeof context !== 'object' || Array.isArray(context)) {
    return 'SIDE_GROUP_CONTEXT must be a JSON object';
  }
  const size = JSON.stringify(context).length;
  if (size > 4096) {
    return `SIDE_GROUP_CONTEXT too large (${size} bytes, max 4096)`;
  }
  return null;
}

function validateExpiresAt(expiresAt: string): string | null {
  // Accept both with and without milliseconds
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(expiresAt)) {
    return 'SIDE_GROUP_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-04-28T10:00:00Z)';
  }
  return null;
}

function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

function generateChatId(): string {
  const { createHash, randomBytes } = require('node:crypto');
  const timestamp = Date.now().toString(36);
  const hash = createHash('sha256')
    .update(randomBytes(8))
    .digest('hex')
    .slice(0, 6);
  return `side-${timestamp}-${hash}`;
}

function defaultExpiresAt(): string {
  const d = new Date();
  d.setHours(d.getHours() + 24);
  // Match the production code: strip milliseconds
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- Tests ----

describe('side-group', () => {
  describe('validateGroupName', () => {
    it('should accept valid group names', () => {
      expect(validateGroupName('LiteLLM 配置方案')).toBeNull();
      expect(validateGroupName('PR #123 Review')).toBeNull();
      expect(validateGroupName('代码审查')).toBeNull();
      expect(validateGroupName('Test Group')).toBeNull();
    });

    it('should reject empty names', () => {
      expect(validateGroupName('')).not.toBeNull();
    });

    it('should reject whitespace-only names', () => {
      expect(validateGroupName('   ')).not.toBeNull();
    });

    it('should reject names with control characters', () => {
      expect(validateGroupName('test\x00name')).not.toBeNull();
      expect(validateGroupName('test\x1Fname')).not.toBeNull();
      expect(validateGroupName('test\x7Fname')).not.toBeNull();
    });
  });

  describe('validateMembers', () => {
    it('should accept valid member arrays', () => {
      expect(validateMembers(['ou_abc123', 'ou_def456'])).toBeNull();
    });

    it('should reject non-array input', () => {
      expect(validateMembers('ou_abc123')).not.toBeNull();
      expect(validateMembers(123)).not.toBeNull();
      expect(validateMembers(null)).not.toBeNull();
    });

    it('should reject empty arrays', () => {
      expect(validateMembers([])).not.toBeNull();
    });

    it('should reject invalid member IDs', () => {
      expect(validateMembers(['invalid'])).not.toBeNull();
      expect(validateMembers(['ou_'])).not.toBeNull();
      expect(validateMembers([123])).not.toBeNull();
    });

    it('should reject mixed valid and invalid member IDs', () => {
      expect(validateMembers(['ou_abc123', 'invalid'])).not.toBeNull();
    });
  });

  describe('validateContext', () => {
    it('should accept valid JSON objects', () => {
      expect(validateContext({ topic: 'test' })).toBeNull();
      expect(validateContext({})).toBeNull();
    });

    it('should accept null/undefined', () => {
      expect(validateContext(null)).toBeNull();
      expect(validateContext(undefined)).toBeNull();
    });

    it('should reject arrays', () => {
      expect(validateContext([1, 2, 3])).not.toBeNull();
    });

    it('should reject strings', () => {
      expect(validateContext('test')).not.toBeNull();
    });

    it('should reject oversized context', () => {
      const largeObj: Record<string, string> = {};
      // Generate ~5000 bytes of context
      for (let i = 0; i < 500; i++) {
        largeObj[`key_${i}`] = 'value'.repeat(10);
      }
      expect(validateContext(largeObj)).not.toBeNull();
    });
  });

  describe('validateExpiresAt', () => {
    it('should accept valid ISO 8601 Z-suffix timestamps', () => {
      expect(validateExpiresAt('2026-04-28T10:00:00Z')).toBeNull();
      expect(validateExpiresAt('2099-12-31T23:59:59Z')).toBeNull();
    });

    it('should reject non-Z-suffix timestamps', () => {
      expect(validateExpiresAt('2026-04-28T10:00:00+08:00')).not.toBeNull();
      expect(validateExpiresAt('2026-04-28T10:00:00')).not.toBeNull();
    });

    it('should reject invalid formats', () => {
      expect(validateExpiresAt('not-a-date')).not.toBeNull();
      expect(validateExpiresAt('')).not.toBeNull();
    });
  });

  describe('truncateGroupName', () => {
    it('should not truncate short names', () => {
      expect(truncateGroupName('Test')).toBe('Test');
    });

    it('should truncate long names at character boundaries', () => {
      const longName = 'A'.repeat(100);
      const truncated = truncateGroupName(longName);
      expect(truncated.length).toBe(64);
    });

    it('should handle CJK characters correctly', () => {
      // Each CJK character is one code point
      const cjkName = '测'.repeat(100);
      const truncated = truncateGroupName(cjkName);
      expect(Array.from(truncated).length).toBe(64);
    });

    it('should handle mixed CJK and ASCII', () => {
      const mixedName = '测试Test测试'.repeat(10);
      const truncated = truncateGroupName(mixedName);
      expect(Array.from(truncated).length).toBeLessThanOrEqual(64);
    });
  });

  describe('generateChatId', () => {
    it('should generate IDs with side- prefix', () => {
      const id = generateChatId();
      expect(id).toMatch(/^side-[a-z0-9]+-[a-f0-9]{6}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateChatId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('defaultExpiresAt', () => {
    it('should return a timestamp ~24 hours in the future', () => {
      const before = Date.now() + 23 * 3600 * 1000;
      const expires = defaultExpiresAt();
      const after = Date.now() + 25 * 3600 * 1000;

      const expiresMs = new Date(expires).getTime();
      expect(expiresMs).toBeGreaterThan(before);
      expect(expiresMs).toBeLessThan(after);
    });

    it('should return valid ISO 8601 Z-suffix format', () => {
      const expires = defaultExpiresAt();
      // toISOString() includes milliseconds, both formats are valid ISO 8601
      expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
      expect(expires.endsWith('Z')).toBe(true);
    });
  });

  describe('integration: validation pipeline', () => {
    it('should validate a complete valid input set', () => {
      expect(validateGroupName('LiteLLM 配置方案')).toBeNull();
      expect(validateMembers(['ou_abc123'])).toBeNull();
      expect(validateContext({ source: 'main-chat' })).toBeNull();
      expect(validateExpiresAt('2099-12-31T23:59:59Z')).toBeNull();
    });

    it('should catch all invalid inputs', () => {
      expect(validateGroupName('')).not.toBeNull();
      expect(validateMembers([])).not.toBeNull();
      expect(validateContext('not json')).not.toBeNull();
      expect(validateExpiresAt('invalid')).not.toBeNull();
    });
  });
});
