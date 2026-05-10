/**
 * Tests for unified-messaging-mcp channel detection utility.
 *
 * Covers the detectChannel() function which routes messages
 * based on chatId prefix.
 *
 * @module mcp-server/unified-messaging-mcp
 */

import { describe, it, expect } from 'vitest';
import { detectChannel } from './unified-messaging-mcp.js';

describe('detectChannel', () => {
  describe('cli channel', () => {
    it('should detect cli channel for cli- prefix', () => {
      expect(detectChannel('cli-12345')).toBe('cli');
    });

    it('should detect cli channel for cli- with session id', () => {
      expect(detectChannel('cli-abc-def-ghi')).toBe('cli');
    });

    it('should detect cli channel for cli- only prefix', () => {
      expect(detectChannel('cli-')).toBe('cli');
    });
  });

  describe('feishu channel', () => {
    it('should detect feishu channel for oc_ prefix (group chat)', () => {
      expect(detectChannel('oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe('feishu');
    });

    it('should detect feishu channel for ou_ prefix (private chat)', () => {
      expect(detectChannel('ou_x1y2z3w4v5u6t7s8r9q0p1o2n3m4l5k6')).toBe('feishu');
    });

    it('should detect feishu channel for oc_ with minimal length', () => {
      expect(detectChannel('oc_')).toBe('feishu');
    });
  });

  describe('rest channel', () => {
    it('should detect rest channel for unknown prefix', () => {
      expect(detectChannel('unknown-prefix-123')).toBe('rest');
    });

    it('should detect rest channel for numeric id', () => {
      expect(detectChannel('123456')).toBe('rest');
    });

    it('should detect rest channel for empty string', () => {
      expect(detectChannel('')).toBe('rest');
    });

    it('should detect rest channel for http-like id', () => {
      expect(detectChannel('http-session-id')).toBe('rest');
    });
  });
});
