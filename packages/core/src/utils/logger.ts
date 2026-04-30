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
import { PassThrough } from 'node:stream';

// Re-export Logger type for consumers
export type { Logger } from 'pino';
import path from 'path';
import fs from 'fs';

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
 * PassThrough stream for upgrading from sync file logging to pino-roll.
 *
 * Issue #2934: When LOG_TO_FILE=true, createLogger() creates a sync file
 * logger at module level. initLogger() later upgrades the stream to pino-roll
 * (async). The PassThrough acts as a proxy — all child loggers write to it,
 * and it pipes to the current destination (file initially, pino-roll after upgrade).
 */
let logPassthrough: PassThrough | null = null;
// pino.destination() returns SonicBoom, pino-roll returns WritableStream
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentLogDest: any = null;

/**
 * Reset the root logger instance.
 * This is primarily useful for testing.
 *
 * @internal
 */
export function resetLogger(): void {
  if (logPassthrough) {
    logPassthrough.destroy();
    logPassthrough = null;
    currentLogDest = null;
  }
  rootLogger = null;
}

/**
 * Detect if running in development environment
 */
function isDevelopment(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Create a PassThrough stream that pipes to a sync file destination.
 * Used by createLogger() and getRootLogger() for synchronous file logging
 * that can later be upgraded to pino-roll by initLogger().
 *
 * Issue #2934: Extracts the repeated LOG_TO_FILE setup logic into a
 * single helper to avoid duplication across createLogger/getRootLogger.
 *
 * @returns Object with { passthrough, dest } if file logging is active,
 *          or null if stdout should be used instead.
 */
function setupSyncFilePassthrough(): { passthrough: PassThrough; dest: NodeJS.WritableStream | ReturnType<typeof pino.destination> } | null {
  if (process.env.LOG_TO_FILE !== 'true' || process.env.NODE_ENV === 'test') {
    return null;
  }

  const logDir = process.env.LOG_DIR ?? './logs';
  const logsPath = path.resolve(process.cwd(), logDir);

  if (!fs.existsSync(logsPath)) {
    fs.mkdirSync(logsPath, { recursive: true });
  }

  const logFile = path.join(logsPath, 'disclaude-combined.log');
  const passthrough = new PassThrough();
  const dest = pino.destination({ dest: logFile, sync: false, mkdir: true });

  // Handle PassThrough errors to prevent silent log loss
  passthrough.on('error', (err: Error) => {
    console.warn('Log passthrough stream error:', err.message);
  });

  passthrough.pipe(dest as unknown as NodeJS.WritableStream);
  return { passthrough, dest: dest as unknown as NodeJS.WritableStream };
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
 * Setup file logging with rotation
 *
 * Note: Dynamic import of pino-roll to avoid build issues
 */
async function setupFileLogging(
  logDir: string
): Promise<NodeJS.WritableStream> {
  try {
    // Create logs directory if it doesn't exist
    const logsPath = path.resolve(process.cwd(), logDir);

    if (!fs.existsSync(logsPath)) {
      fs.mkdirSync(logsPath, { recursive: true });
    }

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
 * Issue #2934: Supports upgrading a sync file logger (created by createLogger()
 * at module level) to pino-roll with rotation. The PassThrough stream proxy
 * ensures all child loggers seamlessly switch to the rotated destination.
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
  const isDev = isDevelopment();
  const logDir = config.logDir ?? process.env.LOG_DIR ?? './logs';

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

  // Determine if file logging should be enabled
  const shouldFileLog = (config.fileLogging ?? !isDev) && process.env.NODE_ENV !== 'test';

  if (rootLogger) {
    // Root logger already exists (created by createLogger() at module level).
    // Issue #2934: If LOG_TO_FILE is set and we have a PassThrough stream,
    // upgrade the destination from plain file to pino-roll with rotation.
    if (shouldFileLog && logPassthrough && currentLogDest) {
      try {
        const rollStream = await setupFileLogging(logDir);
        // Swap destination: unpipe old, pipe new
        logPassthrough.unpipe(currentLogDest);
        logPassthrough.pipe(rollStream);
        // Update log level in case it changed
        if (config.level) {
          rootLogger.level = config.level;
        }
        currentLogDest = rollStream;
      } catch (error) {
        console.warn('Failed to upgrade to pino-roll:', error);
      }
    }
    return rootLogger;
  }

  // Setup file logging for production or if explicitly requested
  let logStream: NodeJS.WritableStream = process.stdout;

  if (shouldFileLog) {
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
 * Issue #2934: When LOG_TO_FILE=true env var is set, the root logger is
 * created with a PassThrough stream writing to a file. Later, initLogger()
 * upgrades the destination to pino-roll with rotation.
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
    const isDev = isDevelopment();
    const options = isDev ? getDevelopmentConfig() : getProductionConfig();

    // Issue #2934: Use shared helper for LOG_TO_FILE sync file setup
    const fileSetup = setupSyncFilePassthrough();
    if (fileSetup) {
      logPassthrough = fileSetup.passthrough;
      currentLogDest = fileSetup.dest;
      rootLogger = pino(options, logPassthrough);
    } else {
      rootLogger = pino(options, process.stdout);
    }
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
 * Issue #2934: Respects LOG_TO_FILE env var for file-based logging.
 *
 * @returns The root logger instance
 */
export function getRootLogger(): Logger {
  if (!rootLogger) {
    const isDev = isDevelopment();
    const options = isDev ? getDevelopmentConfig() : getProductionConfig();

    // Issue #2934: Use shared helper for LOG_TO_FILE sync file setup
    const fileSetup = setupSyncFilePassthrough();
    if (fileSetup) {
      logPassthrough = fileSetup.passthrough;
      currentLogDest = fileSetup.dest;
      rootLogger = pino(options, logPassthrough);
    } else {
      rootLogger = pino(options, process.stdout);
    }
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
