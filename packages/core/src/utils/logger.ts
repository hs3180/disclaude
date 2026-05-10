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
// Recursion guard for error handlers that may try to log during flush
let flushInProgress = false;

/**
 * Reset the root logger instance.
 * This is primarily useful for testing.
 *
 * Issue #3416: Properly destroy currentLogDest (SonicBoom stream) to
 * prevent file handle leaks and concurrent writes to log files.
 *
 * @internal
 */
export function resetLogger(): void {
  // Stop rotation timer before destroying streams
  stopRotation();
  if (logPassthrough) {
    logPassthrough.destroy();
    logPassthrough = null;
  }
  // Issue #3416: Destroy the underlying file stream to release file handles.
  // Without this, pino.destination() / pino-roll SonicBoom streams are
  // orphaned — they keep file descriptors open and may write buffered data
  // to a file that pino-roll has already rotated away.
  if (currentLogDest && typeof currentLogDest.destroy === 'function') {
    currentLogDest.destroy();
  }
  currentLogDest = null;
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
 * Setup file logging with custom rotation.
 *
 * Issue #3416: Replaced pino-roll with a custom rotation mechanism.
 * pino-roll v4.0.0 had a race condition where data could leak between
 * files during rotation — SonicBoom's reopen() did not flush remaining
 * buffer before switching files, causing log truncation and corruption.
 *
 * The custom implementation uses pino.destination() (SonicBoom) directly
 * and manages rotation externally via a periodic size check. Rotation
 * is performed through the PassThrough proxy, ensuring:
 *   1. All buffered data is flushed before the file is rotated
 *   2. No concurrent writes happen during rotation
 *   3. File handles are properly released before renaming
 */
function setupFileLogging(
  logDir: string
): NodeJS.WritableStream {
  try {
    const logsPath = path.resolve(process.cwd(), logDir);
    if (!fs.existsSync(logsPath)) {
      fs.mkdirSync(logsPath, { recursive: true });
    }

    const logFile = path.join(logsPath, 'disclaude-combined.log');
    const dest = pino.destination({ dest: logFile, sync: false, mkdir: true });

    (dest as unknown as NodeJS.EventEmitter).on('error', (err: Error) => {
      if (rootLogger && !flushInProgress) {
        rootLogger.error({ err }, 'File log stream error');
      } else {
        console.warn('File log stream error:', err.message);
      }
    });

    // Start rotation manager
    startRotation(logFile, 10 * 1024 * 1024, 30);

    return dest as unknown as NodeJS.WritableStream;
  } catch (error) {
    console.warn('Failed to setup file logging, falling back to stdout:', error);
    return process.stdout;
  }
}

/**
 * Rotation state
 */
let rotationTimer: ReturnType<typeof setInterval> | null = null;
let rotationConfig: { logFile: string; maxSize: number; maxFiles: number } | null = null;

/**
 * Start periodic rotation checks.
 * Checks file size every 30 seconds and rotates if needed.
 */
function startRotation(logFile: string, maxSize: number, maxFiles: number): void {
  stopRotation();
  rotationConfig = { logFile, maxSize, maxFiles };
  rotationTimer = setInterval(() => checkAndRotate(), 30_000);
  if (rotationTimer.unref) {
    rotationTimer.unref();
  }
}

/**
 * Stop the rotation timer.
 */
function stopRotation(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
}

/**
 * Check if rotation is needed and perform it.
 *
 * Rotation sequence:
 * 1. Check actual file size on disk
 * 2. If size >= maxSize, initiate rotation via the PassThrough proxy
 * 3. Unpipe PassThrough from current dest (stops new writes)
 * 4. Flush and destroy the current dest
 * 5. Shift rotated files (.1 → .2, .2 → .3, etc.)
 * 6. Create new dest and pipe PassThrough to it
 */
function checkAndRotate(): void {
  if (!rotationConfig || !logPassthrough || !currentLogDest) {
    return;
  }

  const { logFile, maxSize, maxFiles } = rotationConfig;

  try {
    const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    if (size < maxSize) {
      return;
    }
  } catch {
    return;
  }

  // Rotation needed
  const oldDest = currentLogDest;
  logPassthrough.unpipe(oldDest);

  // Flush buffered data to disk — all pending writes complete before rotation
  if (typeof oldDest.flush === 'function' && !oldDest.destroyed) {
    try {
      // Use flushSync for guaranteed completion (rotation is already synchronous)
      oldDest.flushSync();
    } catch {
      // Fallback: best-effort async flush
       
      try { oldDest.flush(() => {}); } catch { /* ignore */ }
    }
  }

  // Destroy old file handle
  if (typeof oldDest.destroy === 'function' && !oldDest.destroyed) {
    oldDest.destroy();
  }

  // Shift rotated files
  shiftLogFiles(logFile, maxFiles);

  // Create new destination
  const newDest = pino.destination({ dest: logFile, sync: false, mkdir: true });

  (newDest as unknown as NodeJS.EventEmitter).on('error', (err: Error) => {
    if (rootLogger && !flushInProgress) {
      rootLogger.error({ err }, 'File log stream error after rotation');
    } else {
      console.warn('File log stream error after rotation:', err.message);
    }
  });

  logPassthrough.pipe(newDest as unknown as NodeJS.WritableStream);
  currentLogDest = newDest;

  if (rootLogger) {
    rootLogger.info({ logFile, maxSize: `${maxSize / 1024 / 1024  }M` }, 'Log file rotated');
  }
}

/**
 * Shift rotated log files.
 *
 * Naming scheme:
 *   disclaude-combined.log      ← current (always this name)
 *   disclaude-combined.log.1    ← most recent rotation
 *   disclaude-combined.log.2    ← second most recent
 *   ...                         ← up to maxFiles
 *
 * Steps:
 * 1. Delete the oldest file if it exceeds maxFiles
 * 2. Rename .N-1 → .N (descending order to avoid overwriting)
 * 3. Rename current → .1
 */
function shiftLogFiles(logFile: string, maxFiles: number): void {
  // Delete oldest if it exceeds limit
  const oldest = `${logFile}.${maxFiles}`;
  try {
    if (fs.existsSync(oldest)) {
      fs.unlinkSync(oldest);
    }
  } catch {
    // Best-effort deletion
  }

  // Shift existing rotated files (descending to avoid collision)
  for (let i = maxFiles - 1; i >= 1; i--) {
    const from = `${logFile}.${i}`;
    const to = `${logFile}.${i + 1}`;
    try {
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    } catch {
      // Best-effort rename
    }
  }

  // Rename current log file to .1
  try {
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // If rename fails, the new dest will append to the existing file
    // This is non-fatal — logs continue, just without rotation
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
    // Issue #2934/#3416: If LOG_TO_FILE is set and we have a PassThrough stream,
    // upgrade the destination from plain file to rotating file logging.
    if (shouldFileLog && logPassthrough && currentLogDest) {
      try {
        const newDest = setupFileLogging(logDir);

        // Properly flush and close the old destination before switching.
        const oldDest = currentLogDest;
        logPassthrough.unpipe(oldDest);

        // Flush the old destination to ensure all buffered writes reach disk
        await new Promise<void>((resolve) => {
          if (typeof oldDest.flush === 'function' && !oldDest.destroyed) {
            oldDest.flush(() => resolve());
          } else {
            resolve();
          }
        });

        // Destroy the old file handle to release the fd
        if (typeof oldDest.destroy === 'function' && !oldDest.destroyed) {
          oldDest.destroy();
        }

        // Now pipe to the new rotating file stream
        logPassthrough.pipe(newDest);

        // Update log level in case it changed
        if (config.level) {
          rootLogger.level = config.level;
        }
        currentLogDest = newDest;
      } catch (error) {
        console.warn('Failed to upgrade to rotating file logging:', error);
      }
    }
    return rootLogger;
  }

  // Setup file logging for production or if explicitly requested
  let logStream: NodeJS.WritableStream = process.stdout;

  if (shouldFileLog) {
    try {
      logStream = setupFileLogging(logDir);
      currentLogDest = logStream;
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
 * Check if a log level is enabled for the root logger.
 *
 * In Pino, higher numeric values indicate more severe levels:
 *   trace=10, debug=20, info=30, warn=40, error=50, fatal=60
 *
 * A level is "enabled" when its numeric severity meets or exceeds the
 * configured threshold (`logger.levelVal`). For example, if the logger
 * is set to `warn` (40), then `warn` (40), `error` (50), and `fatal`
 * (60) are all enabled, while `info` (30), `debug` (20), and `trace`
 * (10) are suppressed.
 *
 * @param level - Log level to check
 * @returns true if the level's severity meets or exceeds the configured threshold
 */
export function isLevelEnabled(level: LogLevel): boolean {
  const logger = getRootLogger();
  return pino.levels.values[level] >= logger.levelVal;
}

/**
 * Flush any pending log entries
 *
 * Issue #3416: Uses SonicBoom's flush() method instead of setTimeout.
 * The previous setTimeout(100ms) approach was unreliable — it neither
 * guaranteed flush completion nor respected backpressure. This could
 * cause log truncation when the process exits before buffered writes
 * reach the filesystem.
 *
 * Flushes both the PassThrough proxy (if active) and the underlying
 * file stream (pino-roll / pino.destination).
 *
 * Useful for ensuring logs are written before process exit.
 */
export function flushLogger(): Promise<void> {
  if (!rootLogger) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const pending: Promise<void>[] = [];

    // Flush the PassThrough proxy — this pushes buffered chunks downstream
    if (logPassthrough && !logPassthrough.destroyed) {
      try {
        logPassthrough.resume();
      } catch {
        // PassThrough may already be ended
      }
    }

    // Flush the underlying file stream (SonicBoom) if it has a flush method
    if (currentLogDest && typeof currentLogDest.flush === 'function' && !currentLogDest.destroyed) {
      pending.push(
        new Promise<void>((res) => {
          currentLogDest.flush((err?: Error | null) => {
            if (err) {
              // Use rootLogger when safe, fallback to console.warn during flush
              if (rootLogger && !flushInProgress) {
                rootLogger.error({ err }, 'Logger flush error');
              } else {
                console.warn('Logger flush error:', err.message);
              }
            }
            res();
          });
        })
      );
    }

    if (pending.length > 0) {
      flushInProgress = true;
      void Promise.all(pending).then(() => {
        flushInProgress = false;
        resolve();
      });
    } else {
      // No file stream to flush — resolve immediately
      resolve();
    }
  });
}

/**
 * Flush and close the logger, releasing all file handles.
 *
 * Issue #3416: Provides a clean shutdown path for the logger. Use this
 * before process.exit() to ensure all buffered log entries are written
 * to disk and file handles are released.
 *
 * After calling this, the logger can be re-initialized with initLogger().
 *
 * @returns Promise that resolves when all streams are flushed and closed
 */
export async function closeLogger(): Promise<void> {
  await flushLogger();
  resetLogger();
}
