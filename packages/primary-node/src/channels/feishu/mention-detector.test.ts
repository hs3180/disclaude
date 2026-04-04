/**
 * Tests for Bot Mention Detector.
 *
 * Tests bot mention detection logic in group chat messages.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MentionDetector } from './mention-detector.js';

// Mock @disclaude/core
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

// Mock @larksuiteoapi/node-sdk
vi.mock('@larksuiteoapi/node-sdk', () => ({}));

describe('MentionDetector', () => {
  let detector: MentionDetector;

  beforeEach(() => {
    detector = new MentionDetector();
    vi.clearAllMocks();
  });

  describe('isBotMentioned', () => {
    it('should return false when mentions is undefined', () => {
      expect(detector.isBotMentioned(undefined)).toBe(false);
    });

    it('should return false when mentions is empty array', () => {
      expect(detector.isBotMentioned([])).toBe(false);
    });

    it('should return true when mention open_id matches bot open_id', () => {
      detector.setClient({} as any);
      // Manually set bot info for testing
      (detector as any).botInfo = { open_id: 'ou_bot_123', app_id: 'cli_bot_456' };

      const mentions = [
        { id: { open_id: 'ou_bot_123', user_id: 'bot_123', union_id: 'on_bot' }, key: '@_user_1', name: 'Bot', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should return true when mention open_id matches bot app_id', () => {
      detector.setClient({} as any);
      (detector as any).botInfo = { open_id: 'ou_bot_123', app_id: 'cli_bot_456' };

      const mentions = [
        { id: { open_id: 'cli_bot_456', user_id: 'bot_456', union_id: 'on_bot' }, key: '@_user_1', name: 'Bot', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should return false when mention does not match bot', () => {
      detector.setClient({} as any);
      (detector as any).botInfo = { open_id: 'ou_bot_123', app_id: 'cli_bot_456' };

      const mentions = [
        { id: { open_id: 'ou_user_789', user_id: 'user_789', union_id: 'on_user' }, key: '@_user_2', name: 'User', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(false);
    });

    it('should detect bot mention by cli_ prefix in fallback mode', () => {
      // No bot info set, use fallback detection
      const mentions = [
        { id: { open_id: 'cli_some_bot_id', user_id: 'bot', union_id: '' }, key: '@_user_1', name: 'Bot', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should detect bot mention by bot keyword in key', () => {
      const mentions = [
        { id: { open_id: 'ou_user_123', user_id: 'user', union_id: '' }, key: '@_bot_1', name: 'Bot', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should not detect regular user mention in fallback mode', () => {
      const mentions = [
        { id: { open_id: 'ou_regular_user', user_id: 'user_123', union_id: 'on_user' }, key: '@_user_1', name: 'Regular User', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(false);
    });

    it('should check multiple mentions', () => {
      (detector as any).botInfo = { open_id: 'ou_bot_123', app_id: 'cli_bot_456' };

      const mentions = [
        { id: { open_id: 'ou_user_1', user_id: 'user_1', union_id: '' }, key: '@_user_1', name: 'User 1', tenant_key: 'tk1' },
        { id: { open_id: 'ou_bot_123', user_id: 'bot_123', union_id: '' }, key: '@_user_2', name: 'Bot', tenant_key: 'tk1' },
        { id: { open_id: 'ou_user_2', user_id: 'user_2', union_id: '' }, key: '@_user_3', name: 'User 2', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(true);
    });

    it('should handle mentions with missing id', () => {
      const mentions = [
        { id: undefined as any, key: '@_user_1', name: 'Unknown', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(false);
    });

    it('should handle mentions with missing open_id', () => {
      const mentions = [
        { id: { user_id: 'user_123' } as any, key: '@_user_1', name: 'Unknown', tenant_key: 'tk1' },
      ] as any;

      expect(detector.isBotMentioned(mentions)).toBe(false);
    });
  });

  describe('getBotInfo', () => {
    it('should return undefined when bot info is not fetched', () => {
      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should return bot info after setting', () => {
      (detector as any).botInfo = { open_id: 'ou_bot_123', app_id: 'cli_bot_456' };
      const info = detector.getBotInfo();
      expect(info?.open_id).toBe('ou_bot_123');
      expect(info?.app_id).toBe('cli_bot_456');
    });
  });

  describe('fetchBotInfo', () => {
    it('should warn when client is not initialized', async () => {
      await detector.fetchBotInfo();
      // Should not throw, just warn
      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should handle API errors gracefully', async () => {
      const mockClient = {
        request: vi.fn().mockRejectedValue(new Error('API Error')),
      };
      detector.setClient(mockClient as any);

      await detector.fetchBotInfo();
      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should handle response without bot.open_id', async () => {
      const mockClient = {
        request: vi.fn().mockResolvedValue({ code: 0, msg: 'ok', bot: {} }),
      };
      detector.setClient(mockClient as any);

      await detector.fetchBotInfo();
      expect(detector.getBotInfo()).toBeUndefined();
    });

    it('should set bot info on successful fetch', async () => {
      const mockClient = {
        request: vi.fn().mockResolvedValue({
          code: 0,
          msg: 'ok',
          bot: { open_id: 'ou_bot_test', app_id: 'cli_app_test' },
        }),
      };
      detector.setClient(mockClient as any);

      await detector.fetchBotInfo();
      const info = detector.getBotInfo();
      expect(info?.open_id).toBe('ou_bot_test');
      expect(info?.app_id).toBe('cli_app_test');
    });
  });
});
