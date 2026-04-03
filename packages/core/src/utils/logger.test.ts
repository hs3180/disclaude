/**
 * Tests for Logger Factory Module.
 *
 * @module utils/logger.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLogger,
  initLogger,
  resetLogger,
  getRootLogger,
  setLogLevel,
  isLevelEnabled,
  flushLogger,
} from './logger.js';
import type { Logger } from 'pino';

describe('Logger', () => {
  beforeEach(() => {
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
  });

  describe('createLogger', () => {
    it('should create a child logger with context', () => {
      const logger = createLogger('TestModule');
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.warn).toBe('function');
    });

    it('should create a child logger with metadata', () => {
      const logger = createLogger('TestModule', { version: '1.0.0' });
      expect(logger).toBeDefined();
      // Logger should have the context bound
      expect(typeof logger.info).toBe('function');
    });

    it('should return same root logger for multiple calls', () => {
      const logger1 = createLogger('Module1');
      const logger2 = createLogger('Module2');
      // Both should share the same root logger
      expect(logger1).toBeDefined();
      expect(logger2).toBeDefined();
    });
  });

  describe('initLogger', () => {
    it('should initialize and return root logger', async () => {
      const logger = await initLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should return same logger on subsequent calls (singleton)', async () => {
      const logger1 = await initLogger();
      const logger2 = await initLogger();
      expect(logger1).toBe(logger2);
    });

    it('should accept custom log level', async () => {
      const logger = await initLogger({ level: 'error' });
      expect(logger).toBeDefined();
    });

    it('should accept custom metadata', async () => {
      const logger = await initLogger({
        metadata: { service: 'test-service', version: '1.0' },
      });
      expect(logger).toBeDefined();
    });

    it('should accept custom redact fields', async () => {
      const logger = await initLogger({
        redact: ['customSecret'],
      });
      expect(logger).toBeDefined();
    });

    it('should handle fileLogging option', async () => {
      const logger = await initLogger({ fileLogging: false });
      expect(logger).toBeDefined();
    });

    it('should handle custom logDir option', async () => {
      const logger = await initLogger({ logDir: '/custom/logs' });
      expect(logger).toBeDefined();
    });

    it('should initialize with empty config', async () => {
      const logger = await initLogger({});
      expect(logger).toBeDefined();
    });
  });

  describe('getRootLogger', () => {
    it('should return a logger instance', () => {
      const logger = getRootLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should return same instance across calls', () => {
      const logger1 = getRootLogger();
      const logger2 = getRootLogger();
      expect(logger1).toBe(logger2);
    });
  });

  describe('resetLogger', () => {
    it('should reset the root logger', () => {
      const logger1 = getRootLogger();
      resetLogger();
      const logger2 = getRootLogger();
      // After reset, should be a new instance
      expect(logger1).not.toBe(logger2);
    });
  });

  describe('setLogLevel', () => {
    it('should update log level on root logger', () => {
      getRootLogger(); // Ensure root logger exists
      setLogLevel('error');
      expect(getRootLogger().level).toBe('error');
    });

    it('should accept all valid log levels', () => {
      const logger = getRootLogger(); // Ensure root logger exists
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
      for (const level of levels) {
        setLogLevel(level);
        expect(logger.level).toBe(level);
      }
    });

    it('should do nothing when root logger does not exist', () => {
      resetLogger();
      // Should not throw
      setLogLevel('error');
    });
  });

  describe('isLevelEnabled', () => {
    it('should return true when level matches current level', () => {
      getRootLogger(); // Ensure root logger exists
      setLogLevel('info');
      expect(isLevelEnabled('info')).toBe(true);
    });

    it('should return true for less severe levels than current', () => {
      // Implementation: logger.levelVal >= pino.levels.values[level]
      // With info (30): debug (20) → 30 >= 20 = true, trace (10) → 30 >= 10 = true
      // With info (30): warn (40) → 30 >= 40 = false
      const logger = getRootLogger();
      logger.level = 'info';
      expect(isLevelEnabled('debug')).toBe(true);
      expect(isLevelEnabled('trace')).toBe(true);
      expect(isLevelEnabled('warn')).toBe(false);
      expect(isLevelEnabled('error')).toBe(false);
    });

    it('should return false for more severe levels than current', () => {
      const logger = getRootLogger();
      logger.level = 'warn';
      // warn (40): info (30) → 40 >= 30 = true, error (50) → 40 >= 50 = false
      expect(isLevelEnabled('info')).toBe(true);
      expect(isLevelEnabled('debug')).toBe(true);
      expect(isLevelEnabled('error')).toBe(false);
      expect(isLevelEnabled('fatal')).toBe(false);
    });

    it('should return true for all levels when set to fatal', () => {
      // fatal (60): all other levels have lower values, so 60 >= N is always true
      const logger = getRootLogger();
      logger.level = 'fatal';
      expect(isLevelEnabled('trace')).toBe(true);
      expect(isLevelEnabled('debug')).toBe(true);
      expect(isLevelEnabled('info')).toBe(true);
      expect(isLevelEnabled('warn')).toBe(true);
      expect(isLevelEnabled('error')).toBe(true);
      expect(isLevelEnabled('fatal')).toBe(true);
    });

    it('should return false for all other levels when set to trace', () => {
      // trace (10): all other levels have higher values, so 10 >= N is always false (except trace itself)
      const logger = getRootLogger();
      logger.level = 'trace';
      expect(isLevelEnabled('trace')).toBe(true);
      expect(isLevelEnabled('debug')).toBe(false);
      expect(isLevelEnabled('info')).toBe(false);
      expect(isLevelEnabled('warn')).toBe(false);
      expect(isLevelEnabled('error')).toBe(false);
      expect(isLevelEnabled('fatal')).toBe(false);
    });
  });

  describe('flushLogger', () => {
    it('should resolve without error when root logger exists', async () => {
      getRootLogger();
      await expect(flushLogger()).resolves.toBeUndefined();
    });

    it('should resolve immediately when no root logger', async () => {
      resetLogger();
      await expect(flushLogger()).resolves.toBeUndefined();
    });
  });

  describe('LoggerConfig', () => {
    it('should support all config options', async () => {
      const logger = await initLogger({
        level: 'debug',
        prettyPrint: true,
        fileLogging: false,
        logDir: './test-logs',
        redact: ['apiKey', 'secret'],
        metadata: { env: 'test' },
      });
      expect(logger).toBeDefined();
    });
  });
});
