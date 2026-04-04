/**
 * Tests for Passive Mode Manager.
 *
 * Tests passive mode state management for group chats.
 * In passive mode, the bot only responds when mentioned.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassiveModeManager } from './passive-mode.js';

// Mock @disclaude/core logger
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe('PassiveModeManager', () => {
  let manager: PassiveModeManager;

  beforeEach(() => {
    manager = new PassiveModeManager();
  });

  describe('isPassiveModeDisabled', () => {
    it('should return false by default for unknown chat', () => {
      expect(manager.isPassiveModeDisabled('unknown-chat')).toBe(false);
    });

    it('should return true after setting disabled', () => {
      manager.setPassiveModeDisabled('chat-1', true);
      expect(manager.isPassiveModeDisabled('chat-1')).toBe(true);
    });

    it('should return false after re-enabling', () => {
      manager.setPassiveModeDisabled('chat-1', true);
      manager.setPassiveModeDisabled('chat-1', false);
      expect(manager.isPassiveModeDisabled('chat-1')).toBe(false);
    });

    it('should not affect other chats', () => {
      manager.setPassiveModeDisabled('chat-1', true);
      expect(manager.isPassiveModeDisabled('chat-2')).toBe(false);
    });
  });

  describe('setPassiveModeDisabled', () => {
    it('should disable passive mode for a chat', () => {
      manager.setPassiveModeDisabled('chat-1', true);
      expect(manager.isPassiveModeDisabled('chat-1')).toBe(true);
    });

    it('should re-enable passive mode for a chat', () => {
      manager.setPassiveModeDisabled('chat-1', true);
      manager.setPassiveModeDisabled('chat-1', false);
      expect(manager.isPassiveModeDisabled('chat-1')).toBe(false);
    });

    it('should handle multiple chats independently', () => {
      manager.setPassiveModeDisabled('chat-1', true);
      manager.setPassiveModeDisabled('chat-2', false);
      manager.setPassiveModeDisabled('chat-3', true);

      expect(manager.isPassiveModeDisabled('chat-1')).toBe(true);
      expect(manager.isPassiveModeDisabled('chat-2')).toBe(false);
      expect(manager.isPassiveModeDisabled('chat-3')).toBe(true);
    });

    it('should handle setting disabled to false for non-existent chat', () => {
      expect(() => manager.setPassiveModeDisabled('non-existent', false)).not.toThrow();
      expect(manager.isPassiveModeDisabled('non-existent')).toBe(false);
    });
  });

  describe('getPassiveModeDisabledChats', () => {
    it('should return empty array when no chats are configured', () => {
      expect(manager.getPassiveModeDisabledChats()).toEqual([]);
    });

    it('should return all chats with passive mode disabled', () => {
      manager.setPassiveModeDisabled('chat-1', true);
      manager.setPassiveModeDisabled('chat-2', true);
      manager.setPassiveModeDisabled('chat-3', true);

      const result = manager.getPassiveModeDisabledChats();
      expect(result).toHaveLength(3);
      expect(result).toContain('chat-1');
      expect(result).toContain('chat-2');
      expect(result).toContain('chat-3');
    });

    it('should not include chats that were re-enabled', () => {
      manager.setPassiveModeDisabled('chat-1', true);
      manager.setPassiveModeDisabled('chat-2', true);
      manager.setPassiveModeDisabled('chat-1', false);

      const result = manager.getPassiveModeDisabledChats();
      expect(result).toHaveLength(1);
      expect(result).toContain('chat-2');
    });

    it('should not include chats set to false', () => {
      manager.setPassiveModeDisabled('chat-1', false);

      const result = manager.getPassiveModeDisabledChats();
      expect(result).toHaveLength(0);
    });
  });
});
