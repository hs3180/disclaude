/**
 * Tests for Callback manager (packages/mcp-server/src/tools/callback-manager.ts)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setMessageSentCallback,
  getMessageSentCallback,
  invokeMessageSentCallback,
} from './callback-manager.js';

describe('callback-manager', () => {
  beforeEach(() => {
    // Clear callback before each test
    setMessageSentCallback(null);
  });

  describe('setMessageSentCallback / getMessageSentCallback', () => {
    it('should return null initially', () => {
      expect(getMessageSentCallback()).toBeNull();
    });

    it('should set and get a callback', () => {
      const callback = vi.fn();
      setMessageSentCallback(callback);
      expect(getMessageSentCallback()).toBe(callback);
    });

    it('should clear callback when setting to null', () => {
      const callback = vi.fn();
      setMessageSentCallback(callback);
      expect(getMessageSentCallback()).toBe(callback);

      setMessageSentCallback(null);
      expect(getMessageSentCallback()).toBeNull();
    });

    it('should replace existing callback', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      setMessageSentCallback(callback1);
      expect(getMessageSentCallback()).toBe(callback1);

      setMessageSentCallback(callback2);
      expect(getMessageSentCallback()).toBe(callback2);
    });
  });

  describe('invokeMessageSentCallback', () => {
    it('should do nothing when no callback is set', () => {
      // Should not throw
      expect(() => invokeMessageSentCallback('chat-123')).not.toThrow();
    });

    it('should invoke the callback with chatId', () => {
      const callback = vi.fn();
      setMessageSentCallback(callback);

      invokeMessageSentCallback('chat-123');
      expect(callback).toHaveBeenCalledWith('chat-123');
    });

    it('should invoke callback multiple times', () => {
      const callback = vi.fn();
      setMessageSentCallback(callback);

      invokeMessageSentCallback('chat-1');
      invokeMessageSentCallback('chat-2');
      invokeMessageSentCallback('chat-3');

      expect(callback).toHaveBeenCalledTimes(3);
      expect(callback).toHaveBeenNthCalledWith(1, 'chat-1');
      expect(callback).toHaveBeenNthCalledWith(2, 'chat-2');
      expect(callback).toHaveBeenNthCalledWith(3, 'chat-3');
    });

    it('should not throw when callback throws an error', () => {
      const callback = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      setMessageSentCallback(callback);

      // Should not throw
      expect(() => invokeMessageSentCallback('chat-123')).not.toThrow();
    });

    it('should handle async callback that throws', () => {
      const callback = vi.fn().mockImplementation(() => {
        throw new Error('Async callback error');
      });
      setMessageSentCallback(callback);

      // invokeMessageSentCallback does not await, so it should not throw
      expect(() => invokeMessageSentCallback('chat-123')).not.toThrow();
    });
  });
});
