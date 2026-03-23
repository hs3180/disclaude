/**
 * Tests for logger module (packages/core/src/utils/logger.ts)
 *
 * Tests the following functionality:
 * - Singleton root logger initialization
 * - Child logger creation with context
 * - Log level management
 * - Environment-specific configuration (dev/prod)
 * - Logger reset and flush
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to define mocks that are available inside hoisted vi.mock factories
const { mockChildFn, mockPinoInstance, mockPino, pinoMock } = vi.hoisted(() => {
  const mockChildFn = vi.fn().mockReturnThis();
  const mockPinoInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: mockChildFn,
    level: 'info',
    levelVal: 30,
    get msgPrefix() { return ''; },
  };

  const mockPino = vi.fn().mockReturnValue(mockPinoInstance);

  // Attach pino module-level properties directly to the mock function
  // because the source code does: pino.stdTimeFunctions.isoTime, pino.stdSerializers.err, pino.levels.values
  // where pino is the default import (i.e., the mockPino function itself)
  mockPino.levels = {
    values: {
      trace: 10,
      debug: 20,
      info: 30,
      warn: 40,
      error: 50,
      fatal: 60,
    },
    labels: {
      10: 'trace',
      20: 'debug',
      30: 'info',
      40: 'warn',
      50: 'error',
      60: 'fatal',
    },
  };
  mockPino.stdTimeFunctions = {
    isoTime: vi.fn(),
    epochTime: vi.fn(),
  };
  mockPino.stdSerializers = {
    err: vi.fn((err: Error) => ({ type: 'Error', message: err.message, stack: err.stack })),
    error: vi.fn((err: Error) => ({ type: 'Error', message: err.message, stack: err.stack })),
    req: vi.fn(),
    res: vi.fn(),
  };

  // The pino module mock - default export is mockPino, named exports also available
  const pinoMock = {
    default: mockPino,
    ...mockPino,
  };

  return { mockChildFn, mockPinoInstance, mockPino, pinoMock };
});

vi.mock('pino', () => pinoMock);

vi.mock('pino-roll', () => ({}));

// Import after mocks are set up
import {
  initLogger,
  createLogger,
  getRootLogger,
  setLogLevel,
  isLevelEnabled,
  flushLogger,
  resetLogger,
} from './logger.js';
import type { LoggerConfig } from './logger.js';

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLogger();
    // Reset the pino mock to return a fresh instance
    mockPinoInstance.level = 'debug';
    mockPinoInstance.levelVal = 20;
    mockPino.mockReturnValue(mockPinoInstance);
    mockChildFn.mockReturnThis();
    // Restore pino.levels after clearAllMocks (clearAllMocks may remove custom properties)
    mockPino.levels = {
      values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
      labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
    };
  });

  afterEach(() => {
    resetLogger();
  });

  describe('initLogger', () => {
    it('should create a root logger instance', async () => {
      const logger = await initLogger();

      expect(logger).toBeDefined();
      expect(mockPino).toHaveBeenCalled();
    });

    it('should return the same instance on second call (singleton)', async () => {
      const first = await initLogger();
      const second = await initLogger();

      expect(first).toBe(second);
      // pino should only be called once because the singleton is reused
      expect(mockPino).toHaveBeenCalledTimes(1);
    });

    it('should pass development config when NODE_ENV is not production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        // In development (non-production), config should have formatters
        const options = callArgs[0];
        expect(options).toBeDefined();
        expect(options.formatters).toBeDefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should pass production config when NODE_ENV is production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        const options = callArgs[0];
        expect(options).toBeDefined();
        // Production config should have timestamp and serializers
        expect(options.timestamp).toBeDefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should use test config without transport when NODE_ENV is test', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        const options = callArgs[0];
        // In test environment, there should be no transport (to avoid worker_threads conflicts)
        expect(options.transport).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should override log level when config.level is specified', async () => {
      const config: LoggerConfig = { level: 'trace' };

      await initLogger(config);
      const callArgs = mockPino.mock.calls[0];
      const options = callArgs[0];

      expect(options.level).toBe('trace');
    });

    it('should add redaction config in production environment', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        const options = callArgs[0];

        expect(options.redact).toBeDefined();
        expect(options.redact.paths).toBeInstanceOf(Array);
        expect(options.redact.remove).toBe(true);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should add redaction config when custom redact fields are provided', async () => {
      const config: LoggerConfig = { redact: ['customField', 'anotherField'] };

      await initLogger(config);
      const callArgs = mockPino.mock.calls[0];
      const options = callArgs[0];

      expect(options.redact).toBeDefined();
      expect(options.redact.paths).toEqual(
        expect.arrayContaining(['*.customField', '*.anotherField'])
      );
    });

    it('should add metadata to base config when provided', async () => {
      const config: LoggerConfig = { metadata: { service: 'test-service', version: '1.0.0' } };

      await initLogger(config);
      const callArgs = mockPino.mock.calls[0];
      const options = callArgs[0];

      expect(options.base).toBeDefined();
      expect(options.base.service).toBe('test-service');
      expect(options.base.version).toBe('1.0.0');
    });

    it('should use LOG_DIR environment variable for log directory', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalLogDir = process.env.LOG_DIR;
      process.env.NODE_ENV = 'production';
      process.env.LOG_DIR = '/custom/logs';

      try {
        await initLogger();
        // Should not throw - file logging setup is skipped in test env
        expect(mockPino).toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.LOG_DIR = originalLogDir;
      }
    });

    it('should use process.stdout as stream in test environment', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        // Second argument is the stream
        expect(callArgs[1]).toBe(process.stdout);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should use LOG_LEVEL environment variable for default level', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.NODE_ENV = 'development';
      process.env.LOG_LEVEL = 'warn';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        const options = callArgs[0];
        expect(options.level).toBe('warn');
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.LOG_LEVEL = originalLogLevel;
      }
    });

    it('should ignore invalid LOG_LEVEL environment variable', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.NODE_ENV = 'development';
      process.env.LOG_LEVEL = 'invalid-level';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        const options = callArgs[0];
        // Should fall back to 'debug' in development with invalid LOG_LEVEL
        expect(options.level).toBe('debug');
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.LOG_LEVEL = originalLogLevel;
      }
    });

    it('should accept empty config and use defaults', async () => {
      const logger = await initLogger({});

      expect(logger).toBeDefined();
      expect(mockPino).toHaveBeenCalled();
    });
  });

  describe('createLogger', () => {
    it('should create a child logger with context', () => {
      const child = createLogger('TestContext');

      expect(child).toBeDefined();
      expect(mockChildFn).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'TestContext' })
      );
    });

    it('should create a child logger with context and metadata', () => {
      const metadata = { component: 'auth', version: '2.0' };
      const child = createLogger('AuthContext', metadata);

      expect(child).toBeDefined();
      expect(mockChildFn).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'AuthContext',
          component: 'auth',
          version: '2.0',
        })
      );
    });

    it('should auto-initialize root logger if not already initialized', () => {
      resetLogger();
      const child = createLogger('AutoInit');

      expect(mockPino).toHaveBeenCalled();
      expect(mockChildFn).toHaveBeenCalled();
    });

    it('should use existing root logger if already initialized', async () => {
      await initLogger();
      mockPino.mockClear();

      createLogger('ReuseRoot');

      // pino should not be called again since root logger exists
      expect(mockPino).not.toHaveBeenCalled();
      expect(mockChildFn).toHaveBeenCalled();
    });
  });

  describe('getRootLogger', () => {
    it('should return the root logger if initialized', async () => {
      const root = await initLogger();
      const retrieved = getRootLogger();

      expect(retrieved).toBe(root);
    });

    it('should create root logger if not initialized', () => {
      resetLogger();
      const logger = getRootLogger();

      expect(logger).toBeDefined();
      expect(mockPino).toHaveBeenCalled();
    });

    it('should return same instance on multiple calls', () => {
      resetLogger();
      const first = getRootLogger();
      const second = getRootLogger();

      expect(first).toBe(second);
      expect(mockPino).toHaveBeenCalledTimes(1);
    });
  });

  describe('setLogLevel', () => {
    it('should update log level on the root logger', async () => {
      await initLogger();
      setLogLevel('error');

      expect(mockPinoInstance.level).toBe('error');
    });

    it('should not throw if root logger is not initialized', () => {
      resetLogger();
      expect(() => setLogLevel('debug')).not.toThrow();
    });

    it('should accept all valid log levels', async () => {
      await initLogger();
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

      for (const level of levels) {
        setLogLevel(level);
        expect(mockPinoInstance.level).toBe(level);
      }
    });
  });

  describe('isLevelEnabled', () => {
    it('should return true when current level matches', async () => {
      await initLogger();
      mockPinoInstance.level = 'info';
      mockPinoInstance.levelVal = 30;

      expect(isLevelEnabled('info')).toBe(true);
    });

    it('should return true when current levelVal is greater than or equal to checked level', async () => {
      await initLogger();
      mockPinoInstance.level = 'error';
      mockPinoInstance.levelVal = 50;

      // error (50) >= info (30) = true (the code checks levelVal >= values[level])
      expect(isLevelEnabled('info')).toBe(true);
    });

    it('should return false when current levelVal is less than checked level', async () => {
      await initLogger();
      mockPinoInstance.level = 'debug';
      mockPinoInstance.levelVal = 20;

      // debug (20) >= info (30) = false
      expect(isLevelEnabled('info')).toBe(false);
    });

    it('should return false for fatal level when current level is lower', async () => {
      await initLogger();
      mockPinoInstance.level = 'info';
      mockPinoInstance.levelVal = 30;

      // fatal (60) > info (30), so fatal should not be enabled
      expect(isLevelEnabled('fatal')).toBe(false);
    });

    it('should return true when levelVal equals the checked level', async () => {
      await initLogger();
      mockPinoInstance.level = 'warn';
      mockPinoInstance.levelVal = 40;

      expect(isLevelEnabled('warn')).toBe(true);
    });

    it('should auto-create root logger if not initialized', () => {
      resetLogger();
      const result = isLevelEnabled('info');

      expect(typeof result).toBe('boolean');
      expect(mockPino).toHaveBeenCalled();
    });
  });

  describe('flushLogger', () => {
    it('should return a promise', async () => {
      await initLogger();
      const result = flushLogger();

      expect(result).toBeInstanceOf(Promise);
    });

    it('should resolve without error', async () => {
      await initLogger();
      await expect(flushLogger()).resolves.toBeUndefined();
    });

    it('should resolve immediately when no root logger exists', async () => {
      resetLogger();
      await expect(flushLogger()).resolves.toBeUndefined();
    });
  });

  describe('resetLogger', () => {
    it('should clear the root logger singleton', async () => {
      await initLogger();
      resetLogger();

      // After reset, getRootLogger should create a new instance
      const newLogger = getRootLogger();
      expect(mockPino).toHaveBeenCalledTimes(2); // Once for initLogger, once for getRootLogger
    });

    it('should allow initLogger to create a new instance after reset', async () => {
      await initLogger();
      resetLogger();
      await initLogger();

      expect(mockPino).toHaveBeenCalledTimes(2);
    });
  });

  describe('environment detection', () => {
    it('should detect development environment when NODE_ENV is undefined', async () => {
      const originalEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        const options = callArgs[0];
        // Development config has formatters, production has timestamp
        expect(options.formatters).toBeDefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should detect development environment when NODE_ENV is "test"', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        const options = callArgs[0];
        // Test env uses base development config (no transport)
        expect(options.formatters).toBeDefined();
        expect(options.transport).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should detect development environment when NODE_ENV is "development"', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        await initLogger();
        const callArgs = mockPino.mock.calls[0];
        const options = callArgs[0];
        // Development should have transport with pino-pretty
        expect(options.formatters).toBeDefined();
        expect(options.transport).toBeDefined();
        expect(options.transport.target).toBe('pino-pretty');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});
