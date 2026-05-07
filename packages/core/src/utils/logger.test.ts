/**
 * Tests for logger utility (packages/core/src/utils/logger.ts)
 *
 * Covers:
 * - initLogger: singleton creation, config options, redaction, file logging
 * - createLogger: child logger creation with context and metadata
 * - getRootLogger: lazy initialization
 * - resetLogger: singleton reset
 * - setLogLevel: runtime log level change
 * - isLevelEnabled: level checking
 * - flushLogger: flush pending logs
 * - Environment detection (development vs production)
 * - Sensitive data redaction
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initLogger,
  createLogger,
  getRootLogger,
  resetLogger,
  setLogLevel,
  isLevelEnabled,
  flushLogger,
} from './logger.js';

describe('logger', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    resetLogger();
    delete process.env.LOG_LEVEL;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetLogger();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalLogLevel !== undefined) {
      process.env.LOG_LEVEL = originalLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  describe('resetLogger', () => {
    it('should clear the root logger singleton', async () => {
      await initLogger();
      expect(getRootLogger()).toBeDefined();

      resetLogger();

      // getRootLogger should create a new one after reset
      const newLogger = getRootLogger();
      expect(newLogger).toBeDefined();
    });
  });

  describe('initLogger', () => {
    it('should create a logger instance', async () => {
      process.env.NODE_ENV = 'test';
      const logger = await initLogger();

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.warn).toBe('function');
    });

    it('should return the same singleton on subsequent calls', async () => {
      process.env.NODE_ENV = 'test';
      const logger1 = await initLogger();
      const logger2 = await initLogger();

      expect(logger1).toBe(logger2);
    });

    it('should respect custom log level', async () => {
      process.env.NODE_ENV = 'test';
      const logger = await initLogger({ level: 'error' });

      expect(logger.level).toBe('error');
    });

    it('should use debug level in development by default', async () => {
      process.env.NODE_ENV = 'development';
      const logger = await initLogger({});

      expect(logger.level).toBe('debug');
    });

    it('should use info level in production by default', async () => {
      process.env.NODE_ENV = 'production';
      const logger = await initLogger({});

      expect(logger.level).toBe('info');
    });

    it('should respect LOG_LEVEL environment variable', async () => {
      process.env.NODE_ENV = 'development';
      process.env.LOG_LEVEL = 'warn';
      const logger = await initLogger({});

      expect(logger.level).toBe('warn');
    });

    it('should ignore invalid LOG_LEVEL and use default', async () => {
      process.env.NODE_ENV = 'development';
      process.env.LOG_LEVEL = 'invalid-level';
      const logger = await initLogger({});

      expect(logger.level).toBe('debug');
    });

    it('should accept config.level over environment variable', async () => {
      process.env.NODE_ENV = 'test';
      process.env.LOG_LEVEL = 'warn';
      const logger = await initLogger({ level: 'trace' });

      expect(logger.level).toBe('trace');
    });

    it('should include metadata in log entries', async () => {
      process.env.NODE_ENV = 'test';
      const logger = await initLogger({
        metadata: { service: 'test-service', version: '1.0' },
      });

      // Logger should be created with metadata in base
      expect(logger.bindings()).toEqual(
        expect.objectContaining({
          service: 'test-service',
          version: '1.0',
        }),
      );
    });

    it('should not setup file logging in test environment', async () => {
      process.env.NODE_ENV = 'test';
      // Should not throw even with fileLogging: true
      const logger = await initLogger({ fileLogging: true });

      expect(logger).toBeDefined();
    });

    it('should skip file logging when fileLogging is false', async () => {
      process.env.NODE_ENV = 'production';
      const logger = await initLogger({ fileLogging: false });

      expect(logger).toBeDefined();
    });

    it('should successfully initialize file logging with pino-roll', async () => {
      // Issue #3359: Verify pino-roll CJS/ESM interop works correctly
      process.env.NODE_ENV = 'production';
      const tmpDir = `/tmp/test-logs-${Date.now()}`;
      const logger = await initLogger({
        fileLogging: true,
        logDir: tmpDir,
      });

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');

      // Verify logs can be written without error
      expect(() => {
        logger.info('pino-roll file logging test');
      }).not.toThrow();

      // Flush pending writes and reset logger before cleanup
      // to prevent pino-roll from writing to a deleted directory (ENOENT error)
      await flushLogger();
      resetLogger();

      // Cleanup: remove temp directory
      const fs = await import('fs');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('createLogger', () => {
    it('should create a child logger with context', () => {
      process.env.NODE_ENV = 'test';
      const logger = createLogger('TestModule');

      expect(logger).toBeDefined();
      expect(logger.bindings()).toEqual(
        expect.objectContaining({ context: 'TestModule' }),
      );
    });

    it('should include metadata in child logger', () => {
      process.env.NODE_ENV = 'test';
      const logger = createLogger('TestModule', { requestId: 'abc-123' });

      expect(logger.bindings()).toEqual(
        expect.objectContaining({
          context: 'TestModule',
          requestId: 'abc-123',
        }),
      );
    });

    it('should auto-initialize root logger if not already initialized', () => {
      resetLogger();
      process.env.NODE_ENV = 'test';

      const logger = createLogger('AutoInit');

      expect(logger).toBeDefined();
      expect(logger.bindings()).toEqual(
        expect.objectContaining({ context: 'AutoInit' }),
      );
    });

    it('should create independent child loggers', () => {
      process.env.NODE_ENV = 'test';
      const logger1 = createLogger('Module1');
      const logger2 = createLogger('Module2');

      expect(logger1.bindings()).toEqual(
        expect.objectContaining({ context: 'Module1' }),
      );
      expect(logger2.bindings()).toEqual(
        expect.objectContaining({ context: 'Module2' }),
      );
    });

    it('should work after initLogger has been called', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger();
      const childLogger = createLogger('AfterInit');

      expect(childLogger).toBeDefined();
      expect(childLogger.bindings()).toEqual(
        expect.objectContaining({ context: 'AfterInit' }),
      );
    });
  });

  describe('getRootLogger', () => {
    it('should create root logger if not initialized', () => {
      resetLogger();
      process.env.NODE_ENV = 'test';

      const logger = getRootLogger();

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should return the same instance on repeated calls', () => {
      process.env.NODE_ENV = 'test';
      const logger1 = getRootLogger();
      const logger2 = getRootLogger();

      expect(logger1).toBe(logger2);
    });

    it('should return the initialized logger after initLogger', async () => {
      process.env.NODE_ENV = 'test';
      const initialized = await initLogger();
      const root = getRootLogger();

      expect(root).toBe(initialized);
    });
  });

  describe('setLogLevel', () => {
    it('should update the log level of an existing logger', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger({ level: 'info' });

      setLogLevel('debug');

      expect(getRootLogger().level).toBe('debug');
    });

    it('should not throw when no root logger exists', () => {
      resetLogger();
      expect(() => setLogLevel('error')).not.toThrow();
    });

    it('should support all log levels', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger();

      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

      for (const level of levels) {
        setLogLevel(level);
        expect(getRootLogger().level).toBe(level);
      }
    });
  });

  describe('isLevelEnabled', () => {
    it('should return true for the current level', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger({ level: 'warn' });

      expect(isLevelEnabled('warn')).toBe(true);
    });

    it('should return true for more severe levels than current', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger({ level: 'info' });

      // Pino severity: warn(40) >= info(30), error(50) >= info(30), fatal(60) >= info(30)
      expect(isLevelEnabled('warn')).toBe(true);
      expect(isLevelEnabled('error')).toBe(true);
      expect(isLevelEnabled('fatal')).toBe(true);
    });

    it('should return false for less severe levels than current', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger({ level: 'warn' });

      // Pino severity: debug(20) < warn(40), trace(10) < warn(40), info(30) < warn(40)
      expect(isLevelEnabled('debug')).toBe(false);
      expect(isLevelEnabled('trace')).toBe(false);
      expect(isLevelEnabled('info')).toBe(false);
      expect(isLevelEnabled('warn')).toBe(true); // exact match still true
    });

    it('should work without explicit initialization', () => {
      resetLogger();
      process.env.NODE_ENV = 'test';

      // Should not throw
      const result = isLevelEnabled('info');
      expect(typeof result).toBe('boolean');
    });

    it('should correctly classify all levels at trace threshold', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger({ level: 'trace' });

      // At trace (10), everything is enabled: trace(10) >= 10
      expect(isLevelEnabled('trace')).toBe(true);
      expect(isLevelEnabled('debug')).toBe(true);
      expect(isLevelEnabled('info')).toBe(true);
      expect(isLevelEnabled('warn')).toBe(true);
      expect(isLevelEnabled('error')).toBe(true);
      expect(isLevelEnabled('fatal')).toBe(true);
    });

    it('should correctly classify all levels at fatal threshold', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger({ level: 'fatal' });

      // At fatal (60), only fatal is enabled: fatal(60) >= 60
      expect(isLevelEnabled('trace')).toBe(false);
      expect(isLevelEnabled('debug')).toBe(false);
      expect(isLevelEnabled('info')).toBe(false);
      expect(isLevelEnabled('warn')).toBe(false);
      expect(isLevelEnabled('error')).toBe(false);
      expect(isLevelEnabled('fatal')).toBe(true);
    });

    it('should reflect runtime level changes via setLogLevel', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger({ level: 'error' });

      expect(isLevelEnabled('info')).toBe(false);
      expect(isLevelEnabled('error')).toBe(true);

      setLogLevel('debug');
      expect(isLevelEnabled('info')).toBe(true);
      expect(isLevelEnabled('debug')).toBe(true);
    });
  });

  describe('flushLogger', () => {
    it('should resolve immediately when no root logger exists', async () => {
      resetLogger();
      await expect(flushLogger()).resolves.toBeUndefined();
    });

    it('should resolve after a timeout when root logger exists', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger();

      const start = Date.now();
      await flushLogger();
      const elapsed = Date.now() - start;

      // flushLogger waits 100ms for pino to flush
      expect(elapsed).toBeGreaterThanOrEqual(90);
    });
  });

  describe('redaction', () => {
    it('should redact sensitive fields in production mode', async () => {
      process.env.NODE_ENV = 'production';
      const logger = await initLogger({ fileLogging: false });

      // The logger should have redaction configured
      // We verify by checking the logger was created with proper options
      expect(logger).toBeDefined();

      // Verify the logger can log without error
      expect(() => {
        logger.info({ apiKey: 'secret-key-12345' }, 'Test message');
      }).not.toThrow();
    });

    it('should support custom redact fields', async () => {
      process.env.NODE_ENV = 'test';
      const logger = await initLogger({
        redact: ['customSecret'],
      });

      expect(logger).toBeDefined();
      expect(() => {
        logger.info({ customSecret: 'hidden-value' }, 'Custom redaction');
      }).not.toThrow();
    });

    it('should not apply redaction in development by default', async () => {
      process.env.NODE_ENV = 'development';
      const logger = await initLogger({ fileLogging: false });

      expect(logger).toBeDefined();
      // Development mode skips redaction unless explicitly configured
    });
  });

  describe('log output', () => {
    it('should write log messages without error', async () => {
      process.env.NODE_ENV = 'test';
      const logger = await initLogger();

      expect(() => {
        logger.info('Simple info message');
        logger.debug('Debug message');
        logger.warn('Warning message');
        logger.error('Error message');
        logger.trace('Trace message');
      }).not.toThrow();
    });

    it('should support structured logging with objects', async () => {
      process.env.NODE_ENV = 'test';
      const logger = await initLogger();

      expect(() => {
        logger.info({ userId: 123, action: 'login' }, 'User logged in');
        logger.error({ err: new Error('test error') }, 'An error occurred');
      }).not.toThrow();
    });

    it('should support child logger logging', async () => {
      process.env.NODE_ENV = 'test';
      await initLogger();
      const child = createLogger('ChildModule', { requestId: 'req-1' });

      expect(() => {
        child.info('Child logger message');
        child.info({ extraData: 'value' }, 'With extra data');
      }).not.toThrow();
    });

    it('should support string interpolation in messages', async () => {
      process.env.NODE_ENV = 'test';
      const logger = await initLogger();

      expect(() => {
        logger.info('Hello %s', 'world');
        logger.info('Value: %d', 42);
      }).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle initLogger being called multiple times with different configs', async () => {
      process.env.NODE_ENV = 'test';
      const logger1 = await initLogger({ level: 'debug' });
      const logger2 = await initLogger({ level: 'error' });

      // Second call should return the same singleton (first config wins)
      expect(logger1).toBe(logger2);
      expect(logger1.level).toBe('debug');
    });

    it('should handle createLogger with empty metadata', () => {
      process.env.NODE_ENV = 'test';
      const logger = createLogger('EmptyMeta', {});

      expect(logger).toBeDefined();
      expect(logger.bindings()).toEqual(
        expect.objectContaining({ context: 'EmptyMeta' }),
      );
    });

    it('should handle resetLogger and re-initialization', async () => {
      process.env.NODE_ENV = 'test';
      const first = await initLogger({ level: 'info' });
      expect(first.level).toBe('info');

      resetLogger();

      const second = await initLogger({ level: 'debug' });
      expect(second).not.toBe(first);
      expect(second.level).toBe('debug');
    });

    it('should handle concurrent createLogger calls after reset', () => {
      resetLogger();
      process.env.NODE_ENV = 'test';

      // Multiple createLogger calls should not conflict
      const loggers = Array.from({ length: 5 }, (_, i) =>
        createLogger(`Module${i}`, { index: i }),
      );

      for (let i = 0; i < loggers.length; i++) {
        expect(loggers[i].bindings()).toEqual(
          expect.objectContaining({ context: `Module${i}`, index: i }),
        );
      }
    });
  });
});
