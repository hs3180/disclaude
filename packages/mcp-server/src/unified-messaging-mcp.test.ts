/**
 * Tests for Channel Detection Utility (packages/mcp-server/src/unified-messaging-mcp.ts)
 *
 * Covers:
 * - detectChannel() chatId prefix detection
 * - Edge cases: empty, partial, mixed prefixes
 */

import { describe, it, expect } from 'vitest';
import { detectChannel } from './unified-messaging-mcp.js';

describe('detectChannel', () => {
  describe('CLI channel', () => {
    it('should detect CLI channel for cli- prefix', () => {
      expect(detectChannel('cli-abc123')).toBe('cli');
    });

    it('should detect CLI channel for cli- with numbers', () => {
      expect(detectChannel('cli-1234567890')).toBe('cli');
    });

    it('should detect CLI channel for cli- with hyphens', () => {
      expect(detectChannel('cli-my-session-id')).toBe('cli');
    });
  });

  describe('Feishu channel', () => {
    it('should detect Feishu channel for oc_ prefix (group chat)', () => {
      expect(detectChannel('oc_abcdef123')).toBe('feishu');
    });

    it('should detect Feishu channel for ou_ prefix (private chat)', () => {
      expect(detectChannel('ou_abcdef123')).toBe('feishu');
    });

    it('should detect Feishu channel for oc_ with complex ID', () => {
      expect(detectChannel('oc_71e5f41a029f3a120988b7ecb76df314')).toBe('feishu');
    });
  });

  describe('REST channel', () => {
    it('should default to REST for unknown prefix', () => {
      expect(detectChannel('unknown_prefix_123')).toBe('rest');
    });

    it('should default to REST for plain string', () => {
      expect(detectChannel('some-chat-id')).toBe('rest');
    });

    it('should default to REST for numeric ID', () => {
      expect(detectChannel('1234567890')).toBe('rest');
    });

    it('should default to REST for UUID format', () => {
      expect(detectChannel('550e8400-e29b-41d4-a716-446655440000')).toBe('rest');
    });
  });

  describe('edge cases', () => {
    it('should treat empty string as REST', () => {
      expect(detectChannel('')).toBe('rest');
    });

    it('should not match "oc" without underscore', () => {
      expect(detectChannel('oc123')).toBe('rest');
    });

    it('should not match "cli" without hyphen', () => {
      expect(detectChannel('cli123')).toBe('rest');
    });

    it('should not match "ou" without underscore', () => {
      expect(detectChannel('ou123')).toBe('rest');
    });

    it('should handle case sensitivity — uppercase CLI- is not cli', () => {
      expect(detectChannel('CLI-uppercase')).toBe('rest');
    });

    it('should handle case sensitivity — uppercase OC_ is not oc_', () => {
      expect(detectChannel('OC_uppercase')).toBe('rest');
    });
  });
});
