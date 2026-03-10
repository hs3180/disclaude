/**
 * Tests for SessionTimeoutManager (Issue #1313).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationSessionManager } from '../session-manager.js';
import { SessionTimeoutManager } from '../session-timeout-manager.js';
import type { SessionTimeoutConfig } from '../../config/types.js';
import type pino from 'pino';

// Create a mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as pino.Logger;

describe('SessionTimeoutManager', () => {
  let sessionManager: ConversationSessionManager;
  let timeoutManager: SessionTimeoutManager;
  let disposeCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new ConversationSessionManager({ logger: mockLogger });
    disposeCallback = vi.fn().mockReturnValue(true);
  });

  afterEach(() => {
    if (timeoutManager) {
      timeoutManager.stop();
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should use default values when config is empty', () => {
      const config: SessionTimeoutConfig = {};
      timeoutManager = new SessionTimeoutManager({
        logger: mockLogger,
        sessionManager,
        config,
        onDisposeSession: disposeCallback,
      });

      const resolved = timeoutManager.getConfig();
      expect(resolved.enabled).toBe(false);
      expect(resolved.idleMinutes).toBe(30);
      expect(resolved.maxSessions).toBe(100);
      expect(resolved.checkIntervalMinutes).toBe(5);
    });

    it('should use provided config values', () => {
      const config: SessionTimeoutConfig = {
        enabled: true,
        idleMinutes: 15,
        maxSessions: 50,
        checkIntervalMinutes: 2,
      };
      timeoutManager = new SessionTimeoutManager({
        logger: mockLogger,
        sessionManager,
        config,
        onDisposeSession: disposeCallback,
      });

      const resolved = timeoutManager.getConfig();
      expect(resolved.enabled).toBe(true);
      expect(resolved.idleMinutes).toBe(15);
      expect(resolved.maxSessions).toBe(50);
      expect(resolved.checkIntervalMinutes).toBe(2);
    });
  });

  describe('start/stop', () => {
    it('should not start timer when disabled', () => {
      timeoutManager = new SessionTimeoutManager({
        logger: mockLogger,
        sessionManager,
        config: { enabled: false },
        onDisposeSession: disposeCallback,
      });

      timeoutManager.start();
      expect(timeoutManager.isActive()).toBe(false);
    });

    it('should start timer when enabled', () => {
      timeoutManager = new SessionTimeoutManager({
        logger: mockLogger,
        sessionManager,
        config: { enabled: true, checkIntervalMinutes: 1 },
        onDisposeSession: disposeCallback,
      });

      timeoutManager.start();
      expect(timeoutManager.isActive()).toBe(true);
    });

    it('should stop timer on stop()', () => {
      timeoutManager = new SessionTimeoutManager({
        logger: mockLogger,
        sessionManager,
        config: { enabled: true, checkIntervalMinutes: 1 },
        onDisposeSession: disposeCallback,
      });

      timeoutManager.start();
      expect(timeoutManager.isActive()).toBe(true);

      timeoutManager.stop();
      expect(timeoutManager.isActive()).toBe(false);
    });
  });

  describe('checkAndCleanup', () => {
    beforeEach(() => {
      timeoutManager = new SessionTimeoutManager({
        logger: mockLogger,
        sessionManager,
        config: {
          enabled: true,
          idleMinutes: 30,
          maxSessions: 100,
          checkIntervalMinutes: 1,
        },
        onDisposeSession: disposeCallback,
      });
    });

    it('should not cleanup when no idle sessions', () => {
      timeoutManager.checkAndCleanup();
      expect(disposeCallback).not.toHaveBeenCalled();
    });

    it('should cleanup idle sessions', () => {
      // Create sessions
      sessionManager.getOrCreate('chat-1');
      sessionManager.getOrCreate('chat-2');

      // Simulate idle time passing (more than 30 minutes)
      vi.advanceTimersByTime(31 * 60 * 1000);

      timeoutManager.checkAndCleanup();

      // Both sessions should be checked for disposal
      expect(disposeCallback).toHaveBeenCalledTimes(2);
    });

    it('should not cleanup processing sessions', () => {
      // Create a session and mark it as processing
      sessionManager.getOrCreate('chat-1');
      sessionManager.setProcessing('chat-1', true);

      // Simulate idle time passing
      vi.advanceTimersByTime(31 * 60 * 1000);

      timeoutManager.checkAndCleanup();

      // Processing session should not be disposed
      expect(disposeCallback).not.toHaveBeenCalled();
    });

    it('should cleanup only non-processing sessions', () => {
      // Create sessions
      sessionManager.getOrCreate('chat-1');
      sessionManager.getOrCreate('chat-2');

      // Mark one as processing
      sessionManager.setProcessing('chat-1', true);

      // Simulate idle time passing
      vi.advanceTimersByTime(31 * 60 * 1000);

      timeoutManager.checkAndCleanup();

      // Only chat-2 should be disposed
      expect(disposeCallback).toHaveBeenCalledTimes(1);
      expect(disposeCallback).toHaveBeenCalledWith('chat-2');
    });
  });
});

describe('ConversationSessionManager - timeout methods', () => {
  let sessionManager: ConversationSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new ConversationSessionManager({ logger: mockLogger });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setProcessing / isProcessing', () => {
    it('should return false for non-existent session', () => {
      expect(sessionManager.isProcessing('non-existent')).toBe(false);
    });

    it('should set and get processing state', () => {
      sessionManager.getOrCreate('chat-1');
      expect(sessionManager.isProcessing('chat-1')).toBe(false);

      sessionManager.setProcessing('chat-1', true);
      expect(sessionManager.isProcessing('chat-1')).toBe(true);

      sessionManager.setProcessing('chat-1', false);
      expect(sessionManager.isProcessing('chat-1')).toBe(false);
    });
  });

  describe('getIdleSessions', () => {
    it('should return empty array when no sessions', () => {
      const idle = sessionManager.getIdleSessions(30 * 60 * 1000);
      expect(idle).toEqual([]);
    });

    it('should return idle sessions', () => {
      sessionManager.getOrCreate('chat-1');
      sessionManager.getOrCreate('chat-2');

      // Immediately check - no idle sessions
      const idleNow = sessionManager.getIdleSessions(30 * 60 * 1000);
      expect(idleNow).toEqual([]);

      // After 31 minutes - both should be idle
      vi.advanceTimersByTime(31 * 60 * 1000);
      const idleLater = sessionManager.getIdleSessions(30 * 60 * 1000);
      expect(idleLater).toHaveLength(2);
      expect(idleLater).toContain('chat-1');
      expect(idleLater).toContain('chat-2');
    });

    it('should exclude processing sessions', () => {
      sessionManager.getOrCreate('chat-1');
      sessionManager.getOrCreate('chat-2');
      sessionManager.setProcessing('chat-1', true);

      vi.advanceTimersByTime(31 * 60 * 1000);
      const idle = sessionManager.getIdleSessions(30 * 60 * 1000);

      expect(idle).toHaveLength(1);
      expect(idle).toContain('chat-2');
    });

    it('should exclude closed sessions', () => {
      sessionManager.getOrCreate('chat-1');
      sessionManager.getOrCreate('chat-2');
      sessionManager.delete('chat-1');

      vi.advanceTimersByTime(31 * 60 * 1000);
      const idle = sessionManager.getIdleSessions(30 * 60 * 1000);

      expect(idle).toHaveLength(1);
      expect(idle).toContain('chat-2');
    });
  });
});
