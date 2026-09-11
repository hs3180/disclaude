/**
 * Logger Factory Module
 *
 * Provides a centralized logging infrastructure using Pino with support for:
 * - Development (pretty print) vs Production (JSON) environments
 * - File logging via pino.destination() (rotation delegated to system tools)
 * - Multiple log levels (trace, debug, info, warn, error, fatal)
 * - Child loggers with context binding
 * - Sensitive data redaction
 *
 * Issue #3416: Application-level log rotation was removed in favor of system
 * tools. Restored opt-in in #4777 because Docker containers have no system
 * logrotate and the single file grew unbounded (49GB): LOG_ROTATE /
 * `logging.rotate` turns on pino-roll size/count rotation. LOG_TO_FILE=tee or
 * LOG_MIRROR_STDOUT=true mirrors the file log to stdout for `docker logs`
 * collection (#4786).
 *
 * @module utils/logger
 */

import pino, { Logger, Level, LoggerOptions } from 'pino';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import pinoRoll from 'pino-roll';
import { redactDeclaredSensitive } from '../security/sensitive-values.js';

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
  /** Rotate the file log by size/count via pino-roll (#4777). Default: off. */
  rotate?: boolean;
  /** Mirror file logs to stdout for docker logs / container log collection (#4786). Default: off. */
  mirror?: boolean;
  /** Fields to redact from logs */
  redact?: string[];
  /** Additional metadata to include in all logs */
  metadata?: Record<string, unknown>;
}

/**
 * Root logger instance (singleton)
 */
let rootLogger: Logger | null = null;

/**
 * PassThrough stream for deferred file logging setup.
 *
 * When LOG_TO_FILE=true, createLogger() creates a sync file logger at module
 * level. initLogger() later reconfigures the stream with proper async options.
 * The PassThrough acts as a proxy — all child loggers write to it, and it
 * pipes to the current destination.
 */
let logPassthrough: PassThrough | null = null;
// The writables `logPassThrough` currently pipes to. All child loggers write
// into the same PassThrough, so initLogger() can switch the whole tree onto a
// rotating/mirrored destination after the fact by detaching these and piping
// fresh targets (see initLogger() / #4777 + #4786).
let passthroughTargets: NodeJS.WritableStream[] = [];
// pino.destination() returns SonicBoom (a NodeJS.WritableStream)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentLogDest: any = null;
// Track the underlying file stream so closeLogger()/resetLogger() can flush
// and release the file handle regardless of which path created it. This is
// set by BOTH initLogger() (long-running service) and the sync passthrough
// path (createLogger/getRootLogger). Without it, a pino-roll destination
// created in initLogger() would never be destroyed on shutdown.
let activeFileDest: NodeJS.WritableStream | null = null;
// Recursion guard for error handlers that may try to log during flush
let flushInProgress = false;

/**
 * Reset the root logger instance.
 * This is primarily useful for testing.
 *
 * Properly destroys the underlying file stream to prevent file handle leaks.
 *
 * @internal
 */
export function resetLogger(): void {
  if (logPassthrough) {
    logPassthrough.destroy();
    logPassthrough = null;
  }
  passthroughTargets = [];
  // Destroy the underlying file stream to release file handles.
  if (currentLogDest && typeof currentLogDest.destroy === 'function') {
    currentLogDest.destroy();
  }
  currentLogDest = null;
  // Destroy the file destination created by initLogger() (possibly a pino-roll
  // rotating SonicBoom) so the handle is released on shutdown.
  // Never destroy process.stdout: buildFileDestination() falls back to it when
  // the file destination cannot be created, and tearing down the process's own
  // stdout would silence every later write (including console.*).
  if (activeFileDest && activeFileDest !== process.stdout) {
    const fd = activeFileDest as unknown as { destroy: () => void };
    if (typeof fd.destroy === 'function') {
      fd.destroy();
    }
  }
  activeFileDest = null;
  rootLogger = null;
}

/**
 * Detect if running in development environment
 */
function isDevelopment(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * True when file logging is active, i.e. LOG_TO_FILE is 'true' or 'tee'.
 *
 * 'tee' (Issue #4786) additionally mirrors the file log to stdout/stderr so
 * `docker logs` / the Docker json-file driver can collect diagnostics even
 * while the app persists logs to a file.
 */
function isFileLogMode(): boolean {
  const v = process.env.LOG_TO_FILE;
  return v === 'true' || v === 'tee';
}

/**
 * Resolve the stdout mirror flag.
 *
 * Precedence: LOG_TO_FILE=tee > LOG_MIRROR_STDOUT env > config value > false.
 * The mirror keeps `docker logs` working when LOG_TO_FILE=true (Issue #4786).
 */
function resolveMirror(configMirror?: boolean): boolean {
  if (process.env.LOG_TO_FILE === 'tee') {
    return true;
  }
  const env = process.env.LOG_MIRROR_STDOUT;
  if (env !== undefined) {
    return env === 'true' || env === '1';
  }
  return configMirror ?? false;
}

/**
 * Resolve the rotation flag (Issue #4777).
 *
 * Precedence: LOG_ROTATE env (so a Docker `.env` can force rotation on even
 * when the mounted disclaude.config.yaml still says `logging.rotate: false`)
 * > config `logging.rotate` value > false.
 */
function resolveRotate(configRotate?: boolean): boolean {
  const env = process.env.LOG_ROTATE;
  if (env !== undefined) {
    return env === 'true' || env === '1';
  }
  return configRotate ?? false;
}

/**
 * Build the file log destination.
 *
 * When rotation is enabled (LOG_ROTATE / logging.rotate), delegates to
 * pino-roll's rotating SonicBoom so the file is rolled by size (default 50m)
 * and old files removed (default keep 3 total). Otherwise falls back to a
 * synchronous `pino.destination()` (the pre-#3416 reliable path for short-lived
 * processes).
 *
 * Issue #4777: previously this path wrote a single ever-growing
 * disculaude-combined.log (observed 49GB in Docker) with no cleanup — the
 * `logging.rotate` config field was never consumed.
 */
async function buildFileDestination(
  logDir: string,
  rotate: boolean
): Promise<NodeJS.WritableStream> {
  try {
    const logsPath = path.resolve(process.cwd(), logDir);
    if (!fs.existsSync(logsPath)) {
      fs.mkdirSync(logsPath, { recursive: true });
    }
    const logFile = path.join(logsPath, 'disclaude-combined.log');

  if (rotate) {
    const size = process.env.LOG_ROTATE_SIZE ?? '50m';
    const keepTotal = parseInt(process.env.LOG_ROTATE_LIMIT ?? '3', 10);
    const keepCount = Number.isFinite(keepTotal) && keepTotal > 1 ? keepTotal - 1 : 2;
    const frequency = process.env.LOG_ROTATE_FREQUENCY;
    const rollOpts: {
      file: string;
      size: string | number;
      limit: { count: number };
      frequency?: string | number;
      mkdir: boolean;
      symlink: boolean;
      extension?: string;
    } = {
      file: logFile,
      size,
      limit: { count: keepCount }, // keep N-1 rotated files in addition to the current one
      mkdir: true,
      // pino-roll never writes the bare `file` path. It splits the trailing
      // extension off and inserts the sequence number before it, producing
      // disclaude-combined.1.log, .2.log, ... (verified against pino-roll
      // 4.0.0 — note the number goes *before* `.log`, not after). The stable
      // consumers of this log (filebeat.yml, scripts/launchd.mjs `tail`) watch
      // a fixed path, so without a symlink turning rotation on silently
      // orphans them. `symlink: true` keeps <logDir>/current.log pointed at
      // the live file.
      symlink: true
    };
    if (frequency) {
      rollOpts.frequency = frequency;
    }
    // pino-roll's default export is an async builder resolving to a rotating
    // SonicBoom. initLogger() awaits it, so the long-running service stays safe.
    //
    // pino-roll builds the symlink with a *relative* target, so symlinkSync()
    // throws ENOENT if the log directory does not exist yet. mkdirSync() above
    // normally rules that out, but a racing rmdir or a log volume remounted
    // empty would take the whole file destination down with it. The symlink is
    // a convenience for fixed-path consumers, not a prerequisite for logging —
    // degrade to an unlinked rotation rather than falling all the way back to
    // stdout.
    let dest: unknown;
    try {
      dest = await pinoRoll(rollOpts);
    } catch (symlinkError) {
      console.warn(
        'Log rotation symlink failed, retrying without it (filebeat still globs the numbered files):',
        redactDeclaredSensitive(symlinkError)
      );
      dest = await pinoRoll({ ...rollOpts, symlink: false });
    }
    return dest as NodeJS.WritableStream;
  }

  // sync:true — see setupSyncFilePassthrough() for why async open is unsafe
  // for short-lived processes ("sonic boom is not ready yet" on exit).
  return pino.destination({ dest: logFile, sync: true, mkdir: true }) as unknown as NodeJS.WritableStream;
  } catch (error) {
    // Matches the pre-existing setupFileLogging() fallback: never crash the
    // process because the file destination failed — fall back to stdout.
    console.warn('Failed to setup file logging, falling back to stdout:', redactDeclaredSensitive(error));
    return process.stdout;
  }
}

/**
 * Create a PassThrough stream that pipes to a sync file destination.
 * Used by createLogger() and getRootLogger() for synchronous file logging.
 *
 * @returns Object with { passthrough, dest } if file logging is active,
 *          or null if stdout should be used instead.
 */
function setupSyncFilePassthrough(): { passthrough: PassThrough; dest: NodeJS.WritableStream | ReturnType<typeof pino.destination> } | null {
  if (!isFileLogMode() || process.env.NODE_ENV === 'test') {
    return null;
  }

  const logDir = process.env.LOG_DIR ?? './logs';
  const logsPath = path.resolve(process.cwd(), logDir);

  if (!fs.existsSync(logsPath)) {
    fs.mkdirSync(logsPath, { recursive: true });
  }

  const logFile = path.join(logsPath, 'disclaude-combined.log');
  const passthrough = new PassThrough();
  // sync:true — the fd is opened synchronously in the constructor. With
  // sync:false the file open is async, and a short-lived process that calls
  // process.exit() before the open completes triggers pino's on-exit
  // flushSync() while fd is still -1 → "sonic boom is not ready yet".
  // CLI entry points (push-cli) hit exactly this window on error exits.
  const dest = pino.destination({ dest: logFile, sync: true, mkdir: true });

  // Handle PassThrough errors to prevent silent log loss
  passthrough.on('error', (err: Error) => {
    console.warn('Log passthrough stream error:', redactDeclaredSensitive(err.message));
  });

  const fileDry = dest as unknown as NodeJS.WritableStream;
  passthrough.pipe(fileDry);
  passthroughTargets.push(fileDry);
  // Mirror (Issue #4786): LOG_TO_FILE=tee or LOG_MIRROR_STDOUT=true duplicates
  // the file records to stdout so docker logs / the json-file driver can still
  // capture them without dropping the file copy. Piping the same PassThrough to
  // process.stdout sends each datum to both writables.
  if (resolveMirror(false)) {
    passthrough.pipe(process.stdout);
    passthroughTargets.push(process.stdout);
  }
  activeFileDest = fileDry;
  return { passthrough, dest: fileDry };
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
const credentialProtection: LoggerOptions = {
  hooks: {
    // Filter the final structured record, after Pino interpolation/serializers
    // and child bindings, before any file/stdout/pretty transport receives it.
    streamWrite: line => `${JSON.stringify(redactDeclaredSensitive(JSON.parse(line)))}\n`,
  },
};

function getDevelopmentConfig(): LoggerOptions {
  const baseConfig: LoggerOptions = {
    ...credentialProtection,
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
    ...credentialProtection,
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
    }
    // No `base` override: pino's default base emits the real process pid
    // and hostname on every entry. Overriding base (as this config once did
    // with literal `true` values) replaces those fields with the boolean,
    // making multi-instance logs unattributable (issue #4577).
  };
}

/**
 * Create a redaction serializer for sensitive fields
 */
function createRedactionSerializer(fields: string[]) {
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
 * @returns Promise resolving to the root logger instance. Async since #4777:
 *          the rotating (pino-roll) destination is built asynchronously, so
 *          every call site MUST await it — logging before it resolves is
 *          dropped or hits "sonic boom is not ready yet".
 *
 * @example
 * ```typescript
 * import { initLogger } from '@disclaude/core';
 *
 * const logger = await initLogger();
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

  // Field selection is an explicit caller declaration, never an inferred default.
  if (config.redact) {
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

  // Issue #4777: honor `logging.rotate` (and LOG_ROTATE) for real — the flag
  // previously existed in config but was never consumed here. Issue #4786:
  // optionally mirror to stdout so docker logs still captures the app log.
  const rotate = resolveRotate(config.rotate);
  const mirror = resolveMirror(config.mirror);

  // Reuse the shared PassThrough proxy so already-created child loggers keep
  // working. Module-scope createLogger('...') calls (e.g. cli-main, channels)
  // run BEFORE main() calls initLogger(), creating rootLogger over a synchron
  // non-rotating passthrough. Because every child writes through this one
  // stream, re-pointing its pipe switches the whole tree onto the final
  // (rotating/mirrored) destination. Without this, initLogger() would
  // early-return on the existing rootLogger and rotation would never engage —
  // exactly the #4777 49GB unbounded-growth bug.
  let passthrough: PassThrough | null = logPassthrough;

  if (!passthrough) {
    // First init: create the proxy destination for pino. Every child logger
    // writes through this single stream.
    passthrough = new PassThrough();
    passthrough.on('error', (err: Error) => {
      console.warn('Log passthrough stream error:', redactDeclaredSensitive(err.message));
    });
    logPassthrough = passthrough;
  }

  // Detach whatever the passthrough is currently piped to (e.g. the short-lived
  // sync file dest or an earlier stdout pipe), then attach the final targets.
  for (const target of passthroughTargets) {
    passthrough.unpipe(target);
  }
  passthroughTargets = [];
  // Release the module-scope sync file destination that created rootLogger
  // before initLogger() ran — it is superseded by the rotating destination.
  // (SonicBoom flushes on exit; this just frees the fd sooner.)
  if (currentLogDest && currentLogDest !== activeFileDest && typeof currentLogDest.destroy === 'function') {
    try {
      currentLogDest.destroy();
    } catch {
      // already destroyed
    }
  }
  currentLogDest = null;

  if (shouldFileLog) {
    // Build the file destination. buildFileDestination() handles its own errors
    // and falls back to stdout. Applies pino-roll rotation when rotate is set.
    const fileDest = await buildFileDestination(logDir, rotate);
    activeFileDest = fileDest;
    passthrough.pipe(fileDest);
    passthroughTargets.push(fileDest);
    if (mirror) {
      // Issue #4786: also hand a copy to stdout for docker logs collection.
      passthrough.pipe(process.stdout);
      passthroughTargets.push(process.stdout);
    }
  } else {
    passthrough.pipe(process.stdout);
    passthroughTargets.push(process.stdout);
  }

  if (!rootLogger) {
    rootLogger = pino(options, passthrough);
  } else if (config.level) {
    rootLogger.level = config.level;
  }

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
    const isDev = isDevelopment();
    const options = isDev ? getDevelopmentConfig() : getProductionConfig();

    // Setup file logging if LOG_TO_FILE is enabled
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
 * Respects LOG_TO_FILE env var for file-based logging.
 *
 * @returns The root logger instance
 */
export function getRootLogger(): Logger {
  if (!rootLogger) {
    const isDev = isDevelopment();
    const options = isDev ? getDevelopmentConfig() : getProductionConfig();

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
 * Uses SonicBoom's flush() method to ensure all buffered writes reach
 * the filesystem. Flushes both the PassThrough proxy (if active) and
 * the underlying file stream.
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

    // Collect the underlying file destinations to flush. activeFileDest covers
    // BOTH the initLogger()-created destination (incl. a pino-roll SonicBoom)
    // and the sync passthrough path; currentLogDest is its sync-passthrough
    // alias, so dedupe when they're the same stream.
    const dests = new Set(
      [activeFileDest, currentLogDest].filter(Boolean) as NodeJS.WritableStream[]
    );
    for (const dest of dests) {
      const target = dest as unknown as { flush: (cb: (err?: Error | null) => void) => void; destroyed?: boolean };
      if (typeof target.flush === 'function' && !target.destroyed) {
        pending.push(
          new Promise<void>((res) => {
            // Invoke as a method on `target` (never a detached reference) so
            // SonicBoom's internal `this` stays bound to the stream.
            target.flush((err?: Error | null) => {
              if (err) {
                // Use rootLogger when safe, fallback to console.warn during flush
                if (rootLogger && !flushInProgress) {
                  rootLogger.error({ err }, 'Logger flush error');
                } else {
                  console.warn('Logger flush error:', redactDeclaredSensitive(err.message));
                }
              }
              res();
            });
          })
        );
      }
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
 * Use this before process.exit() to ensure all buffered log entries
 * are written to disk and file handles are released.
 *
 * After calling this, the logger can be re-initialized with initLogger().
 *
 * @returns Promise that resolves when all streams are flushed and closed
 */
export async function closeLogger(): Promise<void> {
  await flushLogger();
  const passthrough = logPassthrough;
  const fileTargets = passthroughTargets.filter(
    (target) => target !== process.stdout && target !== process.stderr
  );
  if (passthrough && !passthrough.destroyed && !passthrough.writableEnded) {
    // flushLogger() only flushes data already received by the destination.
    // Ending the proxy supplies a stream-level barrier: pipe() ends each file
    // target after all queued log chunks, and finished() waits for its final
    // rotation/write before resetLogger() destroys the handles.
    passthrough.end();
    await Promise.all(fileTargets.map(async (target) => await finished(target)));
  }
  resetLogger();
}
