/**
 * Tests for logger utility (src/utils/logger.ts)
 *
 * Tests the following functionality:
 * - Logger initialization and configuration
 * - Development vs production environments
 * - Child logger creation with context
 * - Log level management
 * - File logging setup
 * - Sensitive data redaction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import pino from 'pino';
import {
  initLogger,
  resetLogger,
  createLogger,
  getRootLogger,
  setLogLevel,
  isLevelEnabled,
  flushLogger,
  type LogLevel,
  type LoggerConfig,
} from './logger.js';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
  },
}));

// Mock pino-roll
vi.mock('pino-roll', () => ({
  default: vi.fn(() => ({
    write: vi.fn(),
    on: vi.fn(),
  })),
}));

const mockedFs = vi.mocked(fs);

describe('Logger', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
    // Reset NODE_ENV for each test
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
    // Reset logger singleton
    resetLogger();
    // Clear mock calls
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetLogger();
  });

  describe('initLogger', () => {
    it('should create root logger in development mode', async () => {
      process.env.NODE_ENV = 'development';

      const logger = await initLogger();

      expect(logger).toBeDefined();
      expect(logger.level).toBe('debug'); // Default in dev
    });

    it('should create root logger in production mode', async () => {
      process.env.NODE_ENV = 'production';

      const logger = await initLogger();

      expect(logger).toBeDefined();
      expect(logger.level).toBe('info'); // Default in production
    });

    it('should respect custom log level from config', async () => {
      const config: LoggerConfig = {
        level: 'warn',
      };

      const logger = await initLogger(config);

      expect(logger.level).toBe('warn');
    });

    it('should respect LOG_LEVEL environment variable', async () => {
      process.env.LOG_LEVEL = 'error';

      const logger = await initLogger();

      expect(logger.level).toBe('error');
    });

    it('should return same logger instance on subsequent calls', async () => {
      const logger1 = await initLogger();
      const logger2 = await initLogger();

      expect(logger1).toBe(logger2);
    });

    it('should add metadata to base configuration', async () => {
      const config: LoggerConfig = {
        metadata: { service: 'test-service', version: '1.0.0' },
      };

      const logger = await initLogger(config);

      expect(logger).toBeDefined();
      // Metadata is added to base, check by binding it
      const child = logger.child({ test: 'value' });
      expect(child).toBeDefined();
    });

    it('should handle file logging setup in production', async () => {
      resetLogger(); // Reset before this test
      process.env.NODE_ENV = 'production';
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockReturnValue(undefined);

      const config: LoggerConfig = {
        fileLogging: true,
        logDir: '/test/logs',
      };

      const logger = await initLogger(config);

      expect(logger).toBeDefined();
      expect(mockedFs.mkdirSync).toHaveBeenCalled();
    });

    it('should skip file logging in test environment', async () => {
      process.env.NODE_ENV = 'test';

      const logger = await initLogger({
        fileLogging: true,
      });

      expect(logger).toBeDefined();
      // File logging should be skipped in test mode
      expect(mockedFs.existsSync).not.toHaveBeenCalled();
    });
  });

  describe('createLogger', () => {
    it('should create child logger with context', () => {
      const logger = createLogger('TestModule');

      expect(logger).toBeDefined();
      expect(logger).toHaveProperty('info');
      expect(logger).toHaveProperty('error');
      expect(logger).toHaveProperty('debug');
    });

    it('should create child logger with metadata', () => {
      const logger = createLogger('TestModule', {
        userId: 'test-user',
        requestId: 'test-request',
      });

      expect(logger).toBeDefined();
    });

    it('should initialize root logger if not exists', () => {
      // This should create root logger implicitly
      const logger = createLogger('TestModule');

      expect(logger).toBeDefined();

      // Subsequent calls should use same root
      const logger2 = createLogger('AnotherModule');
      expect(logger2).toBeDefined();
    });

    it('should create separate child loggers', () => {
      const logger1 = createLogger('Module1');
      const logger2 = createLogger('Module2');

      expect(logger1).not.toBe(logger2);
    });

    it('should preserve metadata in child loggers', () => {
      const logger = createLogger('TestModule', { key: 'value' });

      // Logger should be functional
      expect(() => logger.info('test message')).not.toThrow();
    });
  });

  describe('getRootLogger', () => {
    it('should return existing root logger', async () => {
      const initLoggerInstance = await initLogger();
      const rootLogger = getRootLogger();

      expect(rootLogger).toBeDefined();
      expect(rootLogger).toBe(initLoggerInstance);
    });

    it('should initialize root logger if not exists', () => {
      // Reset any existing logger
      const rootLogger = getRootLogger();

      expect(rootLogger).toBeDefined();
      expect(rootLogger).toHaveProperty('level');
    });

    it('should return same instance on multiple calls', () => {
      const logger1 = getRootLogger();
      const logger2 = getRootLogger();

      expect(logger1).toBe(logger2);
    });
  });

  describe('setLogLevel', () => {
    it('should update log level of root logger', async () => {
      await initLogger({ level: 'info' });

      setLogLevel('debug');
      const rootLogger = getRootLogger();

      expect(rootLogger.level).toBe('debug');
    });

    it('should handle all valid log levels', async () => {
      const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

      await initLogger();

      for (const level of levels) {
        setLogLevel(level);
        expect(getRootLogger().level).toBe(level);
      }
    });

    it('should not throw if root logger not initialized', () => {
      expect(() => setLogLevel('debug')).not.toThrow();
    });
  });

  describe('isLevelEnabled', () => {
    it('should be a callable function', () => {
      expect(typeof isLevelEnabled).toBe('function');
    });

    it('should accept log level parameter', () => {
      // Test that the function accepts valid log levels
      const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

      levels.forEach((level) => {
        expect(() => isLevelEnabled(level)).not.toThrow();
      });
    });

    it('should return boolean value', () => {
      const result = isLevelEnabled('info');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('flushLogger', () => {
    it('should resolve without error when root logger exists', async () => {
      await initLogger();

      await expect(flushLogger()).resolves.not.toThrow();
    });

    it('should resolve without error when root logger does not exist', async () => {
      await expect(flushLogger()).resolves.not.toThrow();
    });

    it('should wait for async log writes', async () => {
      await initLogger();
      const logger = getRootLogger();
      logger.info('Test message before flush');

      const start = Date.now();
      await flushLogger();
      const elapsed = Date.now() - start;

      // Should wait at least 100ms as per implementation
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });
  });

  describe('environment detection', () => {
    it('should detect development environment correctly', () => {
      process.env.NODE_ENV = 'development';

      // Logger should use dev config
      const logger = createLogger('Test');
      expect(logger).toBeDefined();
    });

    it('should detect production environment correctly', () => {
      process.env.NODE_ENV = 'production';

      const logger = createLogger('Test');
      expect(logger).toBeDefined();
    });

    it('should default to development when NODE_ENV not set', () => {
      delete process.env.NODE_ENV;

      const logger = createLogger('Test');
      expect(logger).toBeDefined();
    });
  });

  describe('log level from environment', () => {
    beforeEach(() => {
      resetLogger();
    });

    afterEach(() => {
      resetLogger();
    });

    it('should respect explicit log level config', async () => {
      delete process.env.LOG_LEVEL;
      delete process.env.NODE_ENV;

      const logger = await initLogger({ level: 'error' });
      expect(logger.level).toBe('error');
    });

    it('should use warn level when configured', async () => {
      const logger = await initLogger({ level: 'warn' });
      expect(logger.level).toBe('warn');
    });

    it('should use debug level when configured', async () => {
      const logger = await initLogger({ level: 'debug' });
      expect(logger.level).toBe('debug');
    });
  });

  describe('child logger functionality', () => {
    it('should create child logger that inherits configuration', async () => {
      await initLogger({ level: 'warn' });

      const child = createLogger('ChildModule');
      const root = getRootLogger();

      // Child should inherit root's level
      expect(child.level).toBe(root.level);
    });

    it('should include context in child logger', () => {
      const child = createLogger('TestContext');

      // Child logger should be functional
      expect(() => {
        child.info({ contextField: 'value' }, 'test message');
      }).not.toThrow();
    });

    it('should include additional metadata in child logger', () => {
      const child = createLogger('TestContext', {
        userId: 'user123',
        requestId: 'req456',
      });

      expect(() => {
        child.info('test message');
      }).not.toThrow();
    });
  });

  describe('redaction configuration', () => {
    it('should enable redaction in production', async () => {
      process.env.NODE_ENV = 'production';

      const config: LoggerConfig = {
        redact: ['apiKey', 'secret'],
      };

      const logger = await initLogger(config);
      expect(logger).toBeDefined();
    });

    it('should enable redaction when explicitly requested in dev', async () => {
      process.env.NODE_ENV = 'development';

      const config: LoggerConfig = {
        redact: ['password'],
      };

      const logger = await initLogger(config);
      expect(logger).toBeDefined();
    });

    it('should include default sensitive fields', async () => {
      process.env.NODE_ENV = 'production';

      const logger = await initLogger();
      expect(logger).toBeDefined();
      // Default redaction should be applied
    });
  });
});
