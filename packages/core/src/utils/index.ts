/**
 * Core utility functions.
 */

// Logger
export type { LoggerConfig, LogLevel } from './logger.js';
export {
  createLogger,
  initLogger,
  getRootLogger,
  resetLogger,
  setLogLevel,
  isLevelEnabled,
  flushLogger,
} from './logger.js';

// Error Handler
export {
  AppError,
  ErrorCategory,
  ErrorSeverity,
} from './error-handler.js';
export type { ErrorContext } from './error-handler.js';
export {
  classifyError,
  isRetryable,
  isTransient,
  getSeverity,
  createUserMessage,
  enrichError,
  logError,
  handleError,
  formatError,
} from './error-handler.js';

// Retry
export type { RetryOptions } from './retry.js';
export {
  retry,
  retryAsyncIterable,
  withRetry,
} from './retry.js';
