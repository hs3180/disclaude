/**
 * Tests for RuliuPlatformAdapter (packages/primary-node/src/platforms/ruliu/ruliu-adapter.ts)
 *
 * Issue #1617: Add unit tests for RuliuPlatformAdapter.
 *
 * Tests cover:
 * 1. Constructor initializes with correct platform metadata
 * 2. Constructor creates RuliuMessageSender with config
 * 3. fileHandler is undefined (not implemented)
 * 4. getConfig() returns a copy of the configuration
 * 5. getConfig() modifications don't affect internal state
 * 6. updateConfig() merges partial config
 * 7. updateConfig() preserves unmodified fields
 * 8. Custom logger is used when provided
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuliuConfig } from './types.js';

// Mock @disclaude/core — partially mock with importOriginal
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

// Mock RuliuMessageSender
vi.mock('./ruliu-message-sender.js', () => ({
  RuliuMessageSender: vi.fn().mockImplementation((_config: unknown) => ({
    sendText: vi.fn(),
    sendMarkdown: vi.fn(),
  })),
}));

import { createLogger } from '@disclaude/core';
import { RuliuPlatformAdapter } from './ruliu-adapter.js';
import { RuliuMessageSender } from './ruliu-message-sender.js';

const createTestConfig = (): RuliuConfig => ({
  apiHost: 'https://api.example.com',
  checkToken: 'test-token',
  encodingAESKey: 'test-aes-key',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  robotName: 'TestBot',
});

describe('RuliuPlatformAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Constructor & Metadata
  // ==========================================================================

  describe('constructor', () => {
    it('should have correct platform metadata', () => {
      const adapter = new RuliuPlatformAdapter({ config: createTestConfig() });

      expect(adapter.platformId).toBe('ruliu');
      expect(adapter.platformName).toBe('Ruliu (如流)');
    });

    it('should create RuliuMessageSender with config and logger', () => {
      const config = createTestConfig();

      new RuliuPlatformAdapter({ config });

      expect(RuliuMessageSender).toHaveBeenCalledOnce();
      const senderConfig = vi.mocked(RuliuMessageSender).mock.calls[0][0] as any;
      expect(senderConfig.config).toBe(config);
    });

    it('should use default logger when none provided', () => {
      new RuliuPlatformAdapter({ config: createTestConfig() });

      expect(createLogger).toHaveBeenCalledWith('RuliuPlatformAdapter');
    });

    it('should use custom logger when provided', () => {
      const customLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

      new RuliuPlatformAdapter({ config: createTestConfig(), logger: customLogger as any });

      expect(createLogger).not.toHaveBeenCalled();
    });

    it('should set fileHandler to undefined', () => {
      const adapter = new RuliuPlatformAdapter({ config: createTestConfig() });

      expect(adapter.fileHandler).toBeUndefined();
    });

    it('should expose messageSender', () => {
      const adapter = new RuliuPlatformAdapter({ config: createTestConfig() });

      expect(adapter.messageSender).toBeDefined();
    });
  });

  // ==========================================================================
  // getConfig()
  // ==========================================================================

  describe('getConfig()', () => {
    it('should return current configuration', () => {
      const config = createTestConfig();
      const adapter = new RuliuPlatformAdapter({ config });

      const result = adapter.getConfig();

      expect(result).toEqual(config);
    });

    it('should return a copy, not a reference', () => {
      const config = createTestConfig();
      const adapter = new RuliuPlatformAdapter({ config });

      const result = adapter.getConfig();
      result.robotName = 'ModifiedBot';

      expect(adapter.getConfig().robotName).toBe('TestBot');
    });
  });

  // ==========================================================================
  // updateConfig()
  // ==========================================================================

  describe('updateConfig()', () => {
    it('should merge partial config into existing config', () => {
      const config = createTestConfig();
      const adapter = new RuliuPlatformAdapter({ config });

      adapter.updateConfig({ robotName: 'NewBot' });

      const updated = adapter.getConfig();
      expect(updated.robotName).toBe('NewBot');
      expect(updated.apiHost).toBe('https://api.example.com');
      expect(updated.checkToken).toBe('test-token');
    });

    it('should update multiple fields at once', () => {
      const config = createTestConfig();
      const adapter = new RuliuPlatformAdapter({ config });

      adapter.updateConfig({ robotName: 'NewBot', apiHost: 'https://new.api.com' });

      const updated = adapter.getConfig();
      expect(updated.robotName).toBe('NewBot');
      expect(updated.apiHost).toBe('https://new.api.com');
    });
  });
});
