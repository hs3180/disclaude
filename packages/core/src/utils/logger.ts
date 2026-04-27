/**
 * Logger Factory Module
 *
 * Provides a centralized logging infrastructure using Pino with support for:
 * - Development (pretty print) vs Production (JSON) environments
 * - File rotation with pino-roll
 * - Multiple log levels (trace, debug, info, warn, error, fatal)
 * - Child loggers with context binding
 * - Sensitive data redaction
 *
 * @module utils/logger
 */

import pino, { Logger, Level, LoggerOptions } from 'pino';

// Re-export Logger type for consumers
export type { Logger } from 'pino';
import path from 'path';
import fs from 'fs';
import { homedir } from 'os';

/**
 * Log levels supported by Pino
 */
export type LogLevel = Level;

/**
 * Logger configuration interface
 */
export interface LoggerConfig {
  /** Log level (default: 'info' in production, 'debug' in development) */
  level?: LogLevel;
  /** Enable pretty print (default: auto-detected from NODE_ENV) */
  prettyPrint?: boolean;
  /** Log to file (default: false in development, true in production) */
  fileLogging?: boolean;
  /** Log directory (default: './logs') */
  logDir?: string;
  /** Fields to redact from logs */
  redact?: string[];
  /** Additional metadata to include in all logs */
  metadata?: Record<string, unknown>;
}

/**
 * Sensitive field patterns that should be redacted
 */
const SENSITIVE_FIELDS = [
  'apiKey',
  'appSecret',
  'token',
  'password',
  'secret',
  'authorization',
  'cookie',
  'setCookie'
];

/**
 * Root logger instance (singleton)
 */
let rootLogger: Logger | null = null;

/**
 * Reset the root logger instance.
 * This is primarily useful for testing.
 *
 * @internal
 */
export function resetLogger(): void {
  rootLogger = null;
}

/**
 * Detect if running in development environment
 */
function isDevelopment(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Detect if running under launchd (macOS service)
 *
 * Set by launchd plist via DISCLAUDE_LAUNCHD=1 environment variable.
 * When true, file logging with pino-roll is activated.
 */
function isLaunchd(): boolean {
  return process.env.DISCLAUDE_LAUNCHD === '1';
}

/**
 * Get log level from environment or default
 */
function getDefaultLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  const validLevels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

  if (envLevel && validLevels.includes(envLevel as LogLevel)) {
    return envLevel as LogLevel;
  }

  return isDevelopment() ? 'debug' : 'info';
}

/**
 * Get development environment configuration
 *
 * Note: In test environment, we skip pino-pretty transport to avoid
 * conflicts with vitest's worker mechanism (Issue #825).
 * The transport uses worker_threads internally which can cause module
 * loading timeouts in CI environments.
 */
function getDevelopmentConfig(): LoggerOptions {
  const baseConfig: LoggerOptions = {
    level: getDefaultLogLevel(),
    formatters: {
      level: (label) => {
        return { level: label };
      }
    }
  };

  // Skip pino-pretty in test environment to avoid worker_threads conflicts
  if (process.env.NODE_ENV === 'test') {
    return baseConfig;
  }

  return {
    ...baseConfig,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: false,
        messageFormat: '[{context}] {msg}' // Add context prefix if present
      }
    }
  };
}

/**
 * Get production environment configuration
 */
function getProductionConfig(): LoggerOptions {
  return {
    level: getDefaultLogLevel(),
    formatters: {
      level: (label) => {
        return { level: label };
      }
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err
    },
    base: {
      pid: true,
      hostname: true
    }
  };
}

/**
 * Resolve the log directory path.
 *
 * Priority:
 * 1. LOG_DIR environment variable (explicit override)
 * 2. DISCLAUDE_LOG_DIR (set by launchd plist)
 * 3. Provided logDir parameter (from LoggerConfig)
 * 4. Default: './logs'
 */
function resolveLogDir(configLogDir?: string): string {
  return process.env.LOG_DIR || process.env.DISCLAUDE_LOG_DIR || configLogDir || './logs';
}

/**
 * Ensure log directory exists with secure permissions.
 *
 * Creates the directory with 0o700 (owner-only rwx) to prevent
 * information leakage from log files containing sensitive data.
 *
 * @see Issue #2898 — log security
 */
function ensureLogDir(logDir: string): string {
  const logsPath = path.resolve(logDir);

  if (!fs.existsSync(logsPath)) {
    fs.mkdirSync(logsPath, { recursive: true, mode: 0o700 });
  }

  // Ensure correct permissions on existing directories (upgrade scenario)
  try {
    fs.chmodSync(logsPath, 0o700);
  } catch {
    // chmod may fail on some platforms; non-fatal
  }

  return logsPath;
}

/**
 * Create a pino transport configuration for pino-roll file rotation.
 *
 * Uses pino's built-in transport (worker thread) mechanism for
 * non-blocking file writes with automatic rotation.
 *
 * @param logDir - Directory for log files
 * @returns Pino transport options for file rotation
 */
function createRollingFileTransport(logDir: string) {
  const logsPath = ensureLogDir(logDir);
  const logFile = path.join(logsPath, 'disclaude-combined');

  return {
    target: 'pino-roll',
    options: {
      file: logFile,
      size: '10M',
      limit: { count: 30 },
      compress: true,
    },
  };
}

/**
 * Setup file logging with rotation
 *
 * Note: Dynamic import of pino-roll to avoid build issues
 */
async function setupFileLogging(
  logDir: string
): Promise<NodeJS.WritableStream> {
  try {
    // Create logs directory if it doesn't exist
    const resolvedDir = resolveLogDir(logDir);
    const logsPath = ensureLogDir(resolvedDir);

    // Dynamic import of pino-roll (no types available)
    const pinoRoll = (await import('pino-roll')) as unknown as (file: string, options: unknown) => NodeJS.WritableStream;

    // Combined log file with rotation
    const logFile = path.join(logsPath, 'disclaude-combined.log');
    const rollStream = pinoRoll(logFile, {
      size: '10M',
      limit: { count: 30 },
      compress: true
    });

    return rollStream;
  } catch (error) {
    // If pino-roll fails, fall back to stdout
    console.warn('Failed to setup file logging, falling back to stdout:', error);
    return process.stdout;
  }
}

/**
 * Create a redaction serializer for sensitive fields
 */
function createRedactionSerializer(fields: string[] = SENSITIVE_FIELDS) {
  const redactPaths = fields.map((field) => `*.${field}`);

  return {
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err
    },
    redact: {
      paths: redactPaths,
      remove: true
    }
  };
}

/**
 * Initialize the root logger
 *
 * This function creates the singleton root logger instance with
 * environment-specific configuration.
 *
 * @param config - Optional logger configuration
 * @returns The root logger instance
 *
 * @example
 * ```typescript
 * import { initLogger } from '@disclaude/core';
 *
 * const logger = initLogger();
 * logger.info('Application started');
 * ```
 */
export async function initLogger(config: LoggerConfig = {}): Promise<Logger> {
  if (rootLogger) {
    return rootLogger;
  }

  const isDev = isDevelopment();
  const logDir = resolveLogDir(config.logDir);

  // Get base configuration
  let options: LoggerOptions = isDev ? getDevelopmentConfig() : getProductionConfig();

  // Override log level if specified
  if (config.level) {
    options.level = config.level;
  }

  // Add redaction for sensitive fields
  if (!isDev || config.redact) {
    const redactConfig = createRedactionSerializer(config.redact);
    options = {
      ...options,
      serializers: {
        ...options.serializers,
        ...redactConfig.serializers
      },
      redact: redactConfig.redact
    };
  }

  // Add metadata if provided
  if (config.metadata) {
    options.base = {
      ...options.base,
      ...config.metadata
    };
  }

  // Setup file logging for production or if explicitly requested
  let logStream: NodeJS.WritableStream = process.stdout;

  if ((config.fileLogging ?? !isDev) && process.env.NODE_ENV !== 'test') {
    try {
      logStream = await setupFileLogging(logDir);
    } catch (error) {
      console.warn('Failed to setup file logging:', error);
    }
  }

  // Create root logger with stream
  rootLogger = pino(options, logStream);

  return rootLogger;
}

/**
 * Create a child logger with context
 *
 * Child loggers inherit the parent's configuration and automatically
 * include the context field in all log entries.
 *
 * @param context - Module/component name (e.g., 'FeishuBot', 'AgentClient')
 * @param metadata - Additional metadata to include in all logs
 * @returns A child logger instance
 *
 * @example
 * ```typescript
 * import { createLogger } from '@disclaude/core';
 *
 * class FeishuBot {
 *   private logger = createLogger('FeishuBot', {
 *     appId: config.appId.slice(0, 8) + '***'
 *   });
 *
 *   start() {
 *     this.logger.info('Bot starting');
 *   }
 * }
 * ```
 */
export function createLogger(
  context: string,
  metadata?: Record<string, unknown>
): Logger {
  // Ensure root logger is initialized
  if (!rootLogger) {
    // Synchronous initialization for immediate use
    const isDev = isDevelopment();
    let options: LoggerOptions = isDev ? getDevelopmentConfig() : getProductionConfig();

    // When running under launchd, set up pino transport for file rotation
    // This replaces the launchd StandardOutPath/StandardErrorPath mechanism.
    // @see Issue #2934 — pino-roll for launchd log rotation
    if (isLaunchd()) {
      const logDir = process.env.DISCLAUDE_LOG_DIR || path.resolve(homedir(), 'Library/Logs/disclaude');
      const fileTransport = createRollingFileTransport(logDir);
      options = {
        ...options,
        transport: fileTransport,
      };
    }

    rootLogger = pino(options);
  }

  // Create child logger with context
  const childLogger = rootLogger.child({
    context,
    ...metadata
  });

  return childLogger;
}

/**
 * Get the root logger instance
 *
 * Returns the existing root logger or initializes it if needed.
 *
 * @returns The root logger instance
 */
export function getRootLogger(): Logger {
  if (!rootLogger) {
    const isDev = isDevelopment();
    let options: LoggerOptions = isDev ? getDevelopmentConfig() : getProductionConfig();

    if (isLaunchd()) {
      const logDir = process.env.DISCLAUDE_LOG_DIR || path.resolve(homedir(), 'Library/Logs/disclaude');
      const fileTransport = createRollingFileTransport(logDir);
      options = {
        ...options,
        transport: fileTransport,
      };
    }

    rootLogger = pino(options);
  }
  return rootLogger;
}

/**
 * Update the log level at runtime
 *
 * @param level - New log level
 */
export function setLogLevel(level: LogLevel): void {
  if (rootLogger) {
    rootLogger.level = level;
  }
}

/**
 * Check if a log level is enabled
 *
 * @param level - Log level to check
 * @returns true if the level is enabled
 */
export function isLevelEnabled(level: LogLevel): boolean {
  const logger = getRootLogger();
  return logger.level === level ||
    pino.levels.values[level] >= logger.levelVal;
}

/**
 * Flush any pending log entries
 *
 * Useful for ensuring logs are written before process exit.
 */
export function flushLogger(): Promise<void> {
  if (rootLogger) {
    return new Promise((resolve) => {
      // Pino uses async writes, give it time to flush
      setTimeout(resolve, 100);
    });
  }
  return Promise.resolve();
}
