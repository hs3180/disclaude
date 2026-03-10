/**
 * Tests for SessionTimeoutManager.
 *
 * @see Issue #1313
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger } from '../../utils/logger.js';
import { ConversationSessionManager } from '../session-manager.js';
import { SessionTimeoutManager } from '../session-timeout-manager.js';

describe('SessionTimeoutManager', () => {
  let mockSessionManager: ConversationSessionManager;
  let mockOnSessionTimeout: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger('test');
    mockOnSessionTimeout = vi.fn().mockResolvedValue(undefined);
    mockSessionManager = {
      getIdleSessions: vi.fn(),
      getStats: vi.fn(),
      size: vi.fn(),
    } as ConversationSessionManager;
    mockSessionManager.getStats = vi.fn().mockReturnValue({
      chatId: 'chat1',
      queueLength: 0,
      isClosed: false,
      createdAt: Date.now() - 100000,
      lastActivity: Date.now() - 2000000,
      started: true,
    });
    mockSessionManager.size = vi.fn().mockReturnValue(3);
    mockSessionManager.getIdleSessions = vi.fn().mockReturnValue(['chat1', 'chat2']);
  });

  describe('constructor', () => {
    it('should configure with provided settings', () => {
      const manager = new SessionTimeoutManager({
        logger,
        sessionManager: mockSessionManager,
        enabled: true,
        idleMinutes: 30,
        maxSessions: 100,
        checkIntervalMinutes: 5,
        onSessionTimeout: mockOnSessionTimeout,
      });

      const config = manager.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.idleMinutes).toBe(30);
      expect(config.maxSessions).toBe(100);
      expect(config.checkIntervalMinutes).toBe(5);
    });

    it('should not start timer when disabled', () => {
      const manager = new SessionTimeoutManager({
        logger,
        sessionManager: mockSessionManager,
        enabled: false,
        idleMinutes: 30,
        maxSessions: 100,
        checkIntervalMinutes: 5,
        onSessionTimeout: mockOnSessionTimeout,
      });

      manager.start();
      // Timer should not be set
      expect((manager as any).checkTimer).toBeUndefined();
    });
  });

  describe('start/stop', () => {
    it('should start periodic timer when enabled', () => {
      const manager = new SessionTimeoutManager({
        logger,
        sessionManager: mockSessionManager,
        enabled: true,
        idleMinutes: 30,
        maxSessions: 100,
        checkIntervalMinutes: 5,
        onSessionTimeout: mockOnSessionTimeout,
      });

      manager.start();
      expect((manager as any).checkTimer).toBeDefined();

      manager.stop();
      expect((manager as any).checkTimer).toBeUndefined();
    });
  });

  describe('checkTimeouts', () => {
    it('should not check when disabled', async () => {
      const manager = new SessionTimeoutManager({
        logger,
        sessionManager: mockSessionManager,
        enabled: false,
        idleMinutes: 30,
        maxSessions: 100,
        checkIntervalMinutes: 5,
        onSessionTimeout: mockOnSessionTimeout,
      });

      await manager.checkTimeouts();
      expect(mockSessionManager.getIdleSessions).not.toHaveBeenCalled();
    });

    it('should close idle sessions', async () => {
      const manager = new SessionTimeoutManager({
        logger,
        sessionManager: mockSessionManager,
        enabled: true,
        idleMinutes: 30,
        maxSessions: 100,
        checkIntervalMinutes: 5,
        onSessionTimeout: mockOnSessionTimeout,
      });

      await manager.checkTimeouts();

      expect(mockSessionManager.getIdleSessions).toHaveBeenCalledWith(30 * 60 * 1000);
      expect(mockOnSessionTimeout).toHaveBeenCalledTimes(2);
    });

    it('should enforce maxSessions limit', async () => {
      // Current count: 5, max: 3, excess: 2
      mockSessionManager.size.mockReturnValue(5);
      mockSessionManager.getIdleSessions.mockReturnValue(['chat1', 'chat2', 'chat3']);
      mockSessionManager.getStats
        .mockReturnValueOnce({ chatId: 'chat1', lastActivity: 1000 } as any)
        .mockReturnValueOnce({ chatId: 'chat2', lastActivity: 2000 } as any)
        .mockReturnValueOnce({ chatId: 'chat3', lastActivity: 3000 });

      mockOnSessionTimeout.mockResolvedValue(undefined);

      const manager = new SessionTimeoutManager({
        logger,
        sessionManager: mockSessionManager,
        enabled: true,
        idleMinutes: 30,
        maxSessions: 3,
        checkIntervalMinutes: 5,
        onSessionTimeout: mockOnSessionTimeout,
      });

      await manager.checkTimeouts();

      // Should close only 2 oldest sessions (chat1 and chat2)
      expect(mockOnSessionTimeout).toHaveBeenCalledTimes(2);
      expect(mockOnSessionTimeout).toHaveBeenCalledWith('chat1');
      expect(mockOnSessionTimeout).toHaveBeenCalledWith('chat2');
    });

    it('should not prevent reentrant checks', async () => {
      mockSessionManager.getIdleSessions.mockReturnValue(['chat1']);

      const manager = new SessionTimeoutManager({
        logger,
        sessionManager: mockSessionManager,
        enabled: true,
        idleMinutes: 30,
        maxSessions: 100,
        checkIntervalMinutes: 5,
        onSessionTimeout: async () => {
          // Simulate slow timeout handling
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
      });

      // Start two checks in parallel
      const check1 = manager.checkTimeouts();
      const check2 = manager.checkTimeouts();

      await Promise.all([check1, check2]);

      // getIdleSessions should only be called once
      expect(mockSessionManager.getIdleSessions).toHaveBeenCalledTimes(1);
    });
  });
});
