/**
 * Tests for channel detection utility.
 *
 * Verifies detectChannel correctly identifies channel type
 * from chatId prefixes: cli-, oc_, ou_ for CLI and Feishu channels,
 * with everything else defaulting to REST.
 *
 * Issue #1617: Phase 2 — mcp-server unified-messaging-mcp test coverage.
 */

import { describe, it, expect } from 'vitest';
import { detectChannel, type ChannelType } from './unified-messaging-mcp.js';

describe('detectChannel', () => {
  describe('CLI channel detection', () => {
    it('should detect CLI channel from cli- prefix', () => {
      expect(detectChannel('cli-abc123')).toBe<ChannelType>('cli');
    });

    it('should detect CLI channel with uuid-style id', () => {
      expect(detectChannel('cli-550e8400-e29b-41d4-a716-446655440000')).toBe('cli');
    });

    it('should detect CLI channel with short id', () => {
      expect(detectChannel('cli-1')).toBe('cli');
    });
  });

  describe('Feishu channel detection', () => {
    it('should detect Feishu channel from oc_ prefix (group chat)', () => {
      expect(detectChannel('oc_abc123def456')).toBe<ChannelType>('feishu');
    });

    it('should detect Feishu channel from ou_ prefix (private chat)', () => {
      expect(detectChannel('ou_xyz789ghi012')).toBe<ChannelType>('feishu');
    });

    it('should detect Feishu channel with complex oc_ id', () => {
      expect(detectChannel('oc_71e5f41a029f3a120988b7ecb76df314')).toBe('feishu');
    });

    it('should detect Feishu channel with complex ou_ id', () => {
      expect(detectChannel('ou_a1b2c3d4e5f6')).toBe('feishu');
    });
  });

  describe('REST channel detection (default)', () => {
    it('should default to REST for arbitrary strings', () => {
      expect(detectChannel('random-chat-id')).toBe<ChannelType>('rest');
    });

    it('should default to REST for numeric ids', () => {
      expect(detectChannel('123456789')).toBe('rest');
    });

    it('should default to REST for empty-ish ids', () => {
      expect(detectChannel('abc')).toBe('rest');
    });

    it('should default to REST for uuid without cli- prefix', () => {
      expect(detectChannel('550e8400-e29b-41d4-a716-446655440000')).toBe('rest');
    });
  });

  describe('edge cases', () => {
    it('should not match cli_ (underscore) as CLI', () => {
      // cli_ uses underscore, not hyphen — should be REST
      expect(detectChannel('cli_abc')).toBe('rest');
    });

    it('should not match OC_ (uppercase) as Feishu', () => {
      // Prefixes are case-sensitive
      expect(detectChannel('OC_abc')).toBe('rest');
    });

    it('should not match OU_ (uppercase) as Feishu', () => {
      expect(detectChannel('OU_abc')).toBe('rest');
    });

    it('should match cli- prefix exactly (starts with)', () => {
      expect(detectChannel('cli-')).toBe('cli');
    });

    it('should match oc_ prefix exactly (starts with)', () => {
      expect(detectChannel('oc_')).toBe('feishu');
    });

    it('should match ou_ prefix exactly (starts with)', () => {
      expect(detectChannel('ou_')).toBe('feishu');
    });

    it('should not match mid-string cli- as CLI', () => {
      expect(detectChannel('prefix-cli-abc')).toBe('rest');
    });

    it('should not match mid-string oc_ as Feishu', () => {
      expect(detectChannel('prefix_oc_abc')).toBe('rest');
    });
  });
});
