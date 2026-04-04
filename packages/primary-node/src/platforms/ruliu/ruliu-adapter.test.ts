/**
 * Tests for Ruliu Platform Adapter.
 *
 * Tests the adapter that combines RuliuMessageSender into
 * a unified platform-agnostic interface.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuliuPlatformAdapter } from './ruliu-adapter.js';
import type { RuliuConfig } from './types.js';

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

const mockConfig: RuliuConfig = {
  apiHost: 'https://apiin.im.baidu.com',
  checkToken: 'test-check-token',
  encodingAESKey: 'test-aes-key',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  robotName: 'TestBot',
};

describe('RuliuPlatformAdapter', () => {
  let adapter: RuliuPlatformAdapter;

  beforeEach(() => {
    adapter = new RuliuPlatformAdapter({ config: { ...mockConfig } });
  });

  describe('constructor', () => {
    it('should set platformId to "ruliu"', () => {
      expect(adapter.platformId).toBe('ruliu');
    });

    it('should set platformName to "Ruliu (如流)"', () => {
      expect(adapter.platformName).toBe('Ruliu (如流)');
    });

    it('should create a messageSender instance', () => {
      expect(adapter.messageSender).toBeDefined();
    });

    it('should set fileHandler to undefined', () => {
      expect(adapter.fileHandler).toBeUndefined();
    });

    it('should use provided logger when available', () => {
      const mockLogger = {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as any;
      const adapterWithLogger = new RuliuPlatformAdapter({
        config: { ...mockConfig },
        logger: mockLogger,
      });
      expect(adapterWithLogger.messageSender).toBeDefined();
    });

    it('should use default replyMode when not specified', () => {
      const config = adapter.getConfig();
      expect(config.replyMode).toBeUndefined();
    });

    it('should preserve custom replyMode in config', () => {
      const customConfig: RuliuConfig = {
        ...mockConfig,
        replyMode: 'mention-only',
      };
      const customAdapter = new RuliuPlatformAdapter({ config: customConfig });
      const config = customAdapter.getConfig();
      expect(config.replyMode).toBe('mention-only');
    });
  });

  describe('getConfig', () => {
    it('should return a copy of the config', () => {
      const config = adapter.getConfig();
      expect(config).toEqual(mockConfig);
    });

    it('should not return the same object reference', () => {
      const config1 = adapter.getConfig();
      const config2 = adapter.getConfig();
      expect(config1).not.toBe(config2);
    });

    it('should include all config fields', () => {
      const config = adapter.getConfig();
      expect(config.apiHost).toBe(mockConfig.apiHost);
      expect(config.checkToken).toBe(mockConfig.checkToken);
      expect(config.encodingAESKey).toBe(mockConfig.encodingAESKey);
      expect(config.appKey).toBe(mockConfig.appKey);
      expect(config.appSecret).toBe(mockConfig.appSecret);
      expect(config.robotName).toBe(mockConfig.robotName);
    });
  });

  describe('updateConfig', () => {
    it('should update specified config fields', () => {
      adapter.updateConfig({ robotName: 'NewBot' });
      const config = adapter.getConfig();
      expect(config.robotName).toBe('NewBot');
    });

    it('should preserve non-updated fields', () => {
      adapter.updateConfig({ robotName: 'NewBot' });
      const config = adapter.getConfig();
      expect(config.apiHost).toBe(mockConfig.apiHost);
      expect(config.appKey).toBe(mockConfig.appKey);
    });

    it('should support updating multiple fields at once', () => {
      adapter.updateConfig({
        robotName: 'UpdatedBot',
        replyMode: 'proactive',
      });
      const config = adapter.getConfig();
      expect(config.robotName).toBe('UpdatedBot');
      expect(config.replyMode).toBe('proactive');
    });

    it('should handle updating apiHost', () => {
      adapter.updateConfig({ apiHost: 'https://new-api.example.com' });
      const config = adapter.getConfig();
      expect(config.apiHost).toBe('https://new-api.example.com');
    });

    it('should handle updating followUp settings', () => {
      adapter.updateConfig({
        followUp: true,
        followUpWindow: 300,
      });
      const config = adapter.getConfig();
      expect(config.followUp).toBe(true);
      expect(config.followUpWindow).toBe(300);
    });
  });
});
