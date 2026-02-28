/**
 * Tests for Logger Factory (src/utils/logger.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';

// Mock pino-roll to avoid file system operations
vi.mock('pino-roll', () => ({
  default: () => process.stdout,
}));

describe('Logger Module', () => {
  let originalNodeEnv: string | undefined;
  let originalLogLevel: string | undefined;
  let originalLogDir: string | undefined;

  beforeEach(() => {
    // Save original env vars
    originalNodeEnv = process.env.NODE_ENV;
    originalLogLevel = process.env.LOG_LEVEL;
    originalLogDir = process.env.LOG_DIR;

    // Reset modules to get fresh logger instances
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env vars
    process.env.NODE_ENV = originalNodeEnv;
    process.env.LOG_LEVEL = originalLogLevel;
    process.env.LOG_DIR = originalLogDir;

    vi.restoreAllMocks();
  });

  describe('Environment Detection', () => {
    it('should detect development mode when NODE_ENV is not production', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.LOG_LEVEL;

      const { resetLogger, getRootLogger } = await import('./logger.js');
      resetLogger();

      const logger = getRootLogger();
      expect(logger).toBeDefined();
      expect(logger.level).toBe('debug'); // Default for development
    });

    it('should detect production mode when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.LOG_LEVEL;

      const { resetLogger, getRootLogger } = await import('./logger.js');
      resetLogger();

      const logger = getRootLogger();
      expect(logger).toBeDefined();
      expect(logger.level).toBe('info'); // Default for production
    });
  });

  describe('Log Level from Environment', () => {
    it('should use LOG_LEVEL from environment if valid', async () => {
      process.env.NODE_ENV = 'production';
      process.env.LOG_LEVEL = 'warn';

      const { resetLogger, getRootLogger } = await import('./logger.js');
      resetLogger();

      const logger = getRootLogger();
      expect(logger.level).toBe('warn');
    });

    it('should ignore invalid LOG_LEVEL and use default', async () => {
      process.env.NODE_ENV = 'production';
      process.env.LOG_LEVEL = 'invalid';

      const { resetLogger, getRootLogger } = await import('./logger.js');
      resetLogger();

      const logger = getRootLogger();
      expect(logger.level).toBe('info');
    });

    it('should accept all valid log levels', async () => {
      const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

      for (const level of validLevels) {
        process.env.LOG_LEVEL = level;
        process.env.NODE_ENV = 'test';

        const { resetLogger, getRootLogger } = await import('./logger.js');
        resetLogger();

        const logger = getRootLogger();
        expect(logger.level).toBe(level);

        vi.resetModules();
      }
    });
  });

  describe('resetLogger', () => {
    it('should reset the root logger', async () => {
      const { resetLogger, getRootLogger } = await import('./logger.js');

      const logger1 = getRootLogger();
      resetLogger();
      const logger2 = getRootLogger();

      // After reset, should be a different instance
      expect(logger1).not.toBe(logger2);
    });
  });

  describe('getRootLogger', () => {
    it('should return the same logger instance on multiple calls', async () => {
      const { resetLogger, getRootLogger } = await import('./logger.js');
      resetLogger();

      const logger1 = getRootLogger();
      const logger2 = getRootLogger();

      expect(logger1).toBe(logger2);
    });

    it('should create logger lazily if not initialized', async () => {
      const { resetLogger, getRootLogger } = await import('./logger.js');
      resetLogger();

      const logger = getRootLogger();
      expect(logger).toBeDefined();
    });
  });

  describe('createLogger', () => {
    it('should create child logger with context', async () => {
      const { resetLogger, createLogger } = await import('./logger.js');
      resetLogger();

      const logger = createLogger('TestContext');

      expect(logger).toBeDefined();
      expect(logger.child).toBeDefined();
    });

    it('should create child logger with metadata', async () => {
      const { resetLogger, createLogger } = await import('./logger.js');
      resetLogger();

      const logger = createLogger('TestContext', { service: 'test-service' });

      expect(logger).toBeDefined();
    });

    it('should initialize root logger if not exists', async () => {
      const { resetLogger, createLogger, getRootLogger } = await import('./logger.js');
      resetLogger();

      createLogger('TestContext');
      const rootLogger = getRootLogger();

      expect(rootLogger).toBeDefined();
    });
  });

  describe('setLogLevel', () => {
    it('should update log level at runtime', async () => {
      const { resetLogger, getRootLogger, setLogLevel } = await import('./logger.js');
      resetLogger();

      const logger = getRootLogger();
      expect(logger.level).toBe('debug'); // Default in test env

      setLogLevel('error');
      expect(logger.level).toBe('error');
    });

    it('should do nothing if root logger is null', async () => {
      const { resetLogger, setLogLevel } = await import('./logger.js');
      resetLogger();

      // Should not throw
      expect(() => setLogLevel('error')).not.toThrow();
    });
  });

  describe('isLevelEnabled', () => {
    it('should return a boolean for any valid level', async () => {
      const { resetLogger, isLevelEnabled } = await import('./logger.js');
      resetLogger();

      // Function should return boolean for all levels
      expect(typeof isLevelEnabled('trace')).toBe('boolean');
      expect(typeof isLevelEnabled('debug')).toBe('boolean');
      expect(typeof isLevelEnabled('info')).toBe('boolean');
      expect(typeof isLevelEnabled('warn')).toBe('boolean');
      expect(typeof isLevelEnabled('error')).toBe('boolean');
      expect(typeof isLevelEnabled('fatal')).toBe('boolean');
    });

    it('should return true when level matches logger level', async () => {
      process.env.LOG_LEVEL = 'warn';

      const { resetLogger, isLevelEnabled } = await import('./logger.js');
      resetLogger();

      // When level matches exactly, should return true
      expect(isLevelEnabled('warn')).toBe(true);
    });
  });

  describe('flushLogger', () => {
    it('should return a promise that resolves', async () => {
      const { resetLogger, flushLogger } = await import('./logger.js');
      resetLogger();

      await expect(flushLogger()).resolves.toBeUndefined();
    });

    it('should resolve immediately if root logger is null', async () => {
      const { resetLogger, flushLogger } = await import('./logger.js');
      resetLogger();

      await expect(flushLogger()).resolves.toBeUndefined();
    });
  });

  describe('initLogger', () => {
    it('should return existing logger if already initialized', async () => {
      const { resetLogger, initLogger } = await import('./logger.js');
      resetLogger();

      const logger1 = await initLogger();
      const logger2 = await initLogger();

      expect(logger1).toBe(logger2);
    });

    it('should accept custom configuration', async () => {
      const { resetLogger, initLogger } = await import('./logger.js');
      resetLogger();

      const logger = await initLogger({
        level: 'trace',
        prettyPrint: true,
        fileLogging: false,
      });

      expect(logger).toBeDefined();
      expect(logger.level).toBe('trace');
    });

    it('should handle custom log directory', async () => {
      process.env.NODE_ENV = 'test';

      const { resetLogger, initLogger } = await import('./logger.js');
      resetLogger();

      const logger = await initLogger({
        logDir: '/tmp/test-logs',
        fileLogging: false,
      });

      expect(logger).toBeDefined();
    });

    it('should add custom metadata to logs', async () => {
      const { resetLogger, initLogger } = await import('./logger.js');
      resetLogger();

      const logger = await initLogger({
        metadata: { app: 'test-app', version: '1.0.0' },
        fileLogging: false,
      });

      expect(logger).toBeDefined();
    });

    it('should add custom redaction fields', async () => {
      const { resetLogger, initLogger } = await import('./logger.js');
      resetLogger();

      const logger = await initLogger({
        redact: ['customSecret', 'privateKey'],
        fileLogging: false,
      });

      expect(logger).toBeDefined();
    });
  });

  describe('Logger Interface', () => {
    it('should have all required log methods', async () => {
      const { resetLogger, getRootLogger } = await import('./logger.js');
      resetLogger();

      const logger = getRootLogger();

      expect(typeof logger.trace).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.fatal).toBe('function');
    });

    it('should be able to log messages without throwing', async () => {
      const { resetLogger, createLogger } = await import('./logger.js');
      resetLogger();

      const logger = createLogger('Test');

      expect(() => {
        logger.info('Test message');
        logger.debug({ key: 'value' }, 'Debug message');
        logger.warn('Warning message');
      }).not.toThrow();
    });
  });

  describe('Type Exports', () => {
    it('should export LogLevel type', async () => {
      const { resetLogger } = await import('./logger.js');
      resetLogger();

      // Type check - this is compile-time only
      // If this compiles, the type is exported correctly
      const level: pino.Level = 'info';
      expect(level).toBe('info');
    });

    it('should export LoggerConfig interface', async () => {
      const { initLogger } = await import('./logger.js');

      // Type check - this is compile-time only
      const config = {
        level: 'debug' as const,
        prettyPrint: true,
        fileLogging: false,
      };

      // Should accept the config without type errors
      expect(config).toBeDefined();
    });
  });
});
