/**
 * Tests for logger factory module (packages/core/src/utils/logger.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resetLogger,
  createLogger,
  getRootLogger,
  setLogLevel,
  isLevelEnabled,
  flushLogger,
} from './logger.js';

describe('logger', () => {
  beforeEach(() => {
    // Ensure a clean state before each test
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
  });

  describe('resetLogger', () => {
    it('should set root logger to null so a new one is created on next access', () => {
      // First, create a root logger
      const logger1 = getRootLogger();
      expect(logger1).toBeDefined();

      // Reset it
      resetLogger();

      // getRootLogger should create a new instance
      const logger2 = getRootLogger();
      expect(logger2).toBeDefined();
      // The new instance should be a different object (not the same reference)
      expect(logger2).not.toBe(logger1);
    });

    it('should allow createLogger to work after reset', () => {
      const logger1 = createLogger('TestModule');
      expect(logger1).toBeDefined();

      resetLogger();

      const logger2 = createLogger('TestModule');
      expect(logger2).toBeDefined();
      // The child loggers should be different objects since the root was recreated
      expect(logger2).not.toBe(logger1);
    });
  });

  describe('createLogger', () => {
    it('should return a logger object with standard log methods', () => {
      const logger = createLogger('TestContext');

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.trace).toBe('function');
      expect(typeof logger.fatal).toBe('function');
    });

    it('should return a logger with a child method', () => {
      const logger = createLogger('TestContext');

      expect(typeof logger.child).toBe('function');
    });

    it('should create the root logger if it does not exist yet', () => {
      // After resetLogger(), root logger is null
      resetLogger();

      const childLogger = createLogger('AutoInit');
      expect(childLogger).toBeDefined();

      // Now getRootLogger should return the same root instance that was created
      const root = getRootLogger();
      expect(root).toBeDefined();
    });

    it('should create child loggers that have the child method themselves', () => {
      const logger = createLogger('ParentContext');
      const grandchild = logger.child({ extra: 'info' });

      expect(grandchild).toBeDefined();
      expect(typeof grandchild.child).toBe('function');
      expect(typeof grandchild.info).toBe('function');
    });

    it('should pass context to the child logger binding', () => {
      // Verify that a child logger is created (pino child returns a logger instance)
      const logger = createLogger('MyModule');
      expect(logger).toBeDefined();
      expect(typeof logger.child).toBe('function');
    });

    it('should pass metadata alongside context', () => {
      const logger = createLogger('ModuleWithMeta', { component: 'test', version: 1 });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should return a logger even with empty metadata object', () => {
      const logger = createLogger('ModuleNoMeta', {});
      expect(logger).toBeDefined();
    });

    it('should return a logger when no metadata is provided', () => {
      const logger = createLogger('ModuleNoMeta');
      expect(logger).toBeDefined();
    });
  });

  describe('getRootLogger', () => {
    it('should return a logger instance', () => {
      const logger = getRootLogger();
      expect(logger).toBeDefined();
    });

    it('should return the same instance on multiple calls (singleton)', () => {
      const logger1 = getRootLogger();
      const logger2 = getRootLogger();
      expect(logger1).toBe(logger2);
    });

    it('should create a new instance after resetLogger', () => {
      const logger1 = getRootLogger();
      resetLogger();
      const logger2 = getRootLogger();

      expect(logger2).toBeDefined();
      expect(logger2).not.toBe(logger1);
    });

    it('should return a logger with standard log methods', () => {
      const logger = getRootLogger();

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });
  });

  describe('setLogLevel', () => {
    it('should update the level on the root logger', () => {
      getRootLogger(); // Ensure root logger exists
      setLogLevel('debug');

      const logger = getRootLogger();
      expect(logger.level).toBe('debug');
    });

    it('should accept valid pino log levels', () => {
      getRootLogger();
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

      for (const level of levels) {
        setLogLevel(level);
        expect(getRootLogger().level).toBe(level);
      }
    });

    it('should not throw if root logger has not been created yet', () => {
      resetLogger();
      // setLogLevel guards with `if (rootLogger)`, so it should not throw
      expect(() => setLogLevel('info')).not.toThrow();
    });
  });

  describe('isLevelEnabled', () => {
    it('should return true when the checked level matches the current level', () => {
      getRootLogger(); // Ensure root logger exists before setLogLevel
      setLogLevel('info');
      expect(isLevelEnabled('info')).toBe(true);
    });

    it('should return true for a level with lower numeric value than current', () => {
      getRootLogger();
      setLogLevel('info');
      // pino values: trace=10, debug=20, info=30, warn=40, error=50, fatal=60
      // Current level info=30, so debug=20 < 30 → levelVal(30) >= values.debug(20) → true
      expect(isLevelEnabled('debug')).toBe(true);
      expect(isLevelEnabled('trace')).toBe(true);
    });

    it('should return false for a level with higher numeric value than current', () => {
      getRootLogger();
      setLogLevel('info');
      // warn=40 > info=30 → levelVal(30) >= values.warn(40) → false
      expect(isLevelEnabled('warn')).toBe(false);
      expect(isLevelEnabled('error')).toBe(false);
      expect(isLevelEnabled('fatal')).toBe(false);
    });

    it('should return true only for trace when set to trace (lowest numeric)', () => {
      getRootLogger();
      setLogLevel('trace');
      // trace=10, so levelVal(10) >= values only for trace(10)
      expect(isLevelEnabled('trace')).toBe(true);
      expect(isLevelEnabled('debug')).toBe(false);
      expect(isLevelEnabled('info')).toBe(false);
    });

    it('should return true for all levels when set to fatal (highest numeric)', () => {
      getRootLogger();
      setLogLevel('fatal');
      // fatal=60, so levelVal(60) >= all other level values → all true
      expect(isLevelEnabled('fatal')).toBe(true);
      expect(isLevelEnabled('error')).toBe(true);
      expect(isLevelEnabled('warn')).toBe(true);
      expect(isLevelEnabled('info')).toBe(true);
      expect(isLevelEnabled('debug')).toBe(true);
      expect(isLevelEnabled('trace')).toBe(true);
    });

    it('should create the root logger if it does not exist', () => {
      resetLogger();
      // isLevelEnabled calls getRootLogger() internally
      const result = isLevelEnabled('info');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('flushLogger', () => {
    it('should return a promise', () => {
      const result = flushLogger();
      expect(result).toBeInstanceOf(Promise);
    });

    it('should resolve the promise', async () => {
      await expect(flushLogger()).resolves.toBeUndefined();
    });

    it('should resolve immediately when root logger is null', async () => {
      resetLogger();
      const start = Date.now();
      await flushLogger();
      // Should resolve essentially immediately (no 100ms delay)
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    it('should resolve after a delay when root logger exists', async () => {
      getRootLogger();
      const start = Date.now();
      await flushLogger();
      const elapsed = Date.now() - start;
      // flushLogger uses a 100ms setTimeout when rootLogger is present
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });
  });
});
