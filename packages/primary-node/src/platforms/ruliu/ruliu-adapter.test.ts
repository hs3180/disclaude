/**
 * Tests for Ruliu Platform Adapter.
 *
 * @see ruliu-adapter.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { RuliuPlatformAdapter } from './ruliu-adapter.js';
import type { RuliuConfig } from './types.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    level: 'info',
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    msgPrefix: '',
  } as unknown as Logger;
}

// Mock @disclaude/core
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// Mock RuliuMessageSender
vi.mock('./ruliu-message-sender.js', () => {
  return {
    RuliuMessageSender: vi.fn().mockImplementation(() => ({
      sendText: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
      addReaction: vi.fn(),
    })),
  };
});

const testConfig: RuliuConfig = {
  apiHost: 'https://api.test.com',
  checkToken: 'test-token',
  encodingAESKey: 'test-key',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  robotName: 'TestBot',
};

describe('RuliuPlatformAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with correct platform identifiers', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });

      expect(adapter.platformId).toBe('ruliu');
      expect(adapter.platformName).toBe('Ruliu (如流)');
    });

    it('should create a RuliuMessageSender instance', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });

      expect(adapter.messageSender).toBeDefined();
      expect(adapter.messageSender.sendText).toBeDefined();
    });

    it('should have undefined fileHandler', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });

      expect(adapter.fileHandler).toBeUndefined();
    });

    it('should use custom logger when provided', () => {
      const logger = createMockLogger();

      new RuliuPlatformAdapter({ config: testConfig, logger });

      // Logger should have been used during initialization
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          apiHost: 'https://api.test.com',
          robotName: 'TestBot',
        }),
        'Ruliu platform adapter initialized'
      );
    });

    it('should log default replyMode when not specified in config', () => {
      const logger = createMockLogger();

      new RuliuPlatformAdapter({ config: testConfig, logger });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          replyMode: 'mention-and-watch',
        }),
        'Ruliu platform adapter initialized'
      );
    });

    it('should log custom replyMode when specified in config', () => {
      const logger = createMockLogger();

      const configWithMode: RuliuConfig = {
        ...testConfig,
        replyMode: 'proactive',
      };

      new RuliuPlatformAdapter({ config: configWithMode, logger });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          replyMode: 'proactive',
        }),
        'Ruliu platform adapter initialized'
      );
    });
  });

  describe('getConfig', () => {
    it('should return a copy of the config', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });
      const config = adapter.getConfig();

      expect(config).toEqual(testConfig);
      // Verify it's a copy, not a reference
      expect(config).not.toBe(testConfig);
    });

    it('should not reflect mutations on the returned object', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });
      const config = adapter.getConfig();

      (config as any).appKey = 'modified';

      const configAgain = adapter.getConfig();
      expect(configAgain.appKey).toBe('test-app-key');
    });
  });

  describe('updateConfig', () => {
    it('should merge partial config updates', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });

      adapter.updateConfig({ robotName: 'NewBot' });

      const config = adapter.getConfig();
      expect(config.robotName).toBe('NewBot');
      // Other fields should remain unchanged
      expect(config.apiHost).toBe('https://api.test.com');
      expect(config.appKey).toBe('test-app-key');
    });

    it('should update multiple fields at once', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });

      adapter.updateConfig({
        apiHost: 'https://new-api.test.com',
        replyMode: 'proactive',
      });

      const config = adapter.getConfig();
      expect(config.apiHost).toBe('https://new-api.test.com');
      expect(config.replyMode).toBe('proactive');
    });

    it('should log which fields were updated', () => {
      const logger = createMockLogger();

      const adapter = new RuliuPlatformAdapter({ config: testConfig, logger });

      adapter.updateConfig({ robotName: 'UpdatedBot' });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          updatedFields: ['robotName'],
        }),
        'Configuration updated'
      );
    });

    it('should persist updates across multiple calls', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });

      adapter.updateConfig({ robotName: 'Bot1' });
      adapter.updateConfig({ apiHost: 'https://host2.test.com' });

      const config = adapter.getConfig();
      expect(config.robotName).toBe('Bot1');
      expect(config.apiHost).toBe('https://host2.test.com');
    });
  });

  describe('IPlatformAdapter compliance', () => {
    it('should implement IPlatformAdapter interface correctly', () => {
      const adapter = new RuliuPlatformAdapter({ config: testConfig });

      expect(adapter).toHaveProperty('platformId');
      expect(adapter).toHaveProperty('platformName');
      expect(adapter).toHaveProperty('messageSender');
      expect(typeof adapter.platformId).toBe('string');
      expect(typeof adapter.platformName).toBe('string');
    });
  });
});
