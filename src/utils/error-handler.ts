/**
 * Enhanced Error Handling Module
 *
 * Provides utilities for consistent error handling, classification, and logging:
 * - Error categorization (operational vs programming)
 * - Error context enrichment
 * - Retry/transient error detection
 * - Standardized error logging with Pino
 *
 * @module utils/error-handler
 */

import { Logger } from 'pino';
import { createLogger } from './logger.js';

/**
 * Error categories for classification and handling
 */
export enum ErrorCategory {
  /** Configuration errors (missing/invalid config) */
  CONFIGURATION = 'CONFIGURATION',
  /** Network errors (timeouts, connection failures) */
  NETWORK = 'NETWORK',
  /** API errors (HTTP errors, rate limits) */
  API = 'API',
  /** Validation errors (invalid input) */
  VALIDATION = 'VALIDATION',
  /** Permission errors (access denied) */
  PERMISSION = 'PERMISSION',
  /** Timeout errors */
  TIMEOUT = 'TIMEOUT',
  /** File system errors */
  FILESYSTEM = 'FILESYSTEM',
  /** WebSocket errors */
  WEBSOCKET = 'WEBSOCKET',
  /** SDK errors */
  SDK = 'SDK',
  /** Unknown/unclassified errors */
  UNKNOWN = 'UNKNOWN'
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  /** Fatal - process should exit */
  FATAL = 'fatal',
  /** Error - operation failed but system can continue */
  ERROR = 'error',
  /** Warning - operation succeeded with issues */
  WARN = 'warn'
}

/**
 * Standard error context interface
 */
export interface ErrorContext {
  /** Unique identifier for tracking */
  errorId?: string;
  /** Error category */
  category?: ErrorCategory;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Whether the error is transient (temporary) */
  transient?: boolean;
  /** User-friendly message */
  userMessage?: string;
  /** Additional context data */
  [key: string]: unknown;
}

/**
 * Enriched Error class with additional metadata
 */
export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly transient: boolean;
  readonly userMessage?: string;
  readonly errorId: string;
  readonly context?: Record<string, unknown>;
  readonly originalError?: Error;

  constructor(
    message: string,
    category: ErrorCategory = ErrorCategory.UNKNOWN,
    severity: ErrorSeverity = ErrorSeverity.ERROR,
    options: {
      retryable?: boolean;
      transient?: boolean;
      userMessage?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.category = category;
    this.severity = severity;
    this.retryable = options.retryable ?? false;
    this.transient = options.transient ?? false;
    this.userMessage = options.userMessage;
    this.context = options.context;
    this.originalError = options.cause;
    this.errorId = this.generateErrorId();

    // Ensure proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  private generateErrorId(): string {
    return `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  toJSON() {
    return {
      errorId: this.errorId,
      name: this.name,
      message: this.message,
      category: this.category,
      severity: this.severity,
      retryable: this.retryable,
      transient: this.transient,
      userMessage: this.userMessage,
      context: this.context,
      stack: this.stack,
      originalError: this.originalError ? {
        name: this.originalError.name,
        message: this.originalError.message,
        stack: this.originalError.stack
      } : undefined
    };
  }
}

/**
 * Logger instance for error handler
 */
let errorLogger: Logger;

/**
 * Initialize error handler logger
 */
function getErrorHandlerLogger(): Logger {
  if (!errorLogger) {
    errorLogger = createLogger('ErrorHandler');
  }
  return errorLogger;
}

/**
 * Classify an error based on its type and message
 */
export function classifyError(error: Error | unknown): ErrorCategory {
  // If it's already an AppError, return its category
  if (error instanceof AppError) {
    return error.category;
  }

  if (!(error instanceof Error)) {
    return ErrorCategory.UNKNOWN;
  }

  const message = error.message.toLowerCase();
  const name = error.constructor.name.toLowerCase();

  // Network errors
  if (
    name.includes('network') ||
    name.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('enotfound') ||
    message.includes('econnrefused') ||
    message.includes('econnreset')
  ) {
    return ErrorCategory.NETWORK;
  }

  // Timeout errors
  if (
    message.includes('timeout') ||
    name.includes('timeout')
  ) {
    return ErrorCategory.TIMEOUT;
  }

  // API/HTTP errors
  if (
    name.includes('http') ||
    name.includes('api') ||
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('500')
  ) {
    return ErrorCategory.API;
  }

  // Validation errors
  if (
    name.includes('validation') ||
    message.includes('invalid') ||
    message.includes('required') ||
    message.includes('missing')
  ) {
    return ErrorCategory.VALIDATION;
  }

  // Permission errors
  if (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('permission') ||
    message.includes('access denied')
  ) {
    return ErrorCategory.PERMISSION;
  }

  // File system errors
  if (
    name.includes('enoent') ||
    name.includes('eacces') ||
    message.includes('no such file') ||
    message.includes('permission denied')
  ) {
    return ErrorCategory.FILESYSTEM;
  }

  // WebSocket errors
  if (
    name.includes('websocket') ||
    message.includes('websocket')
  ) {
    return ErrorCategory.WEBSOCKET;
  }

  return ErrorCategory.UNKNOWN;
}

/**
 * Determine if an error is retryable
 */
export function isRetryable(error: Error | unknown): boolean {
  if (error instanceof AppError) {
    return error.retryable;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const category = classifyError(error);

  // Network and timeout errors are typically retryable
  const retryableCategories = [
    ErrorCategory.NETWORK,
    ErrorCategory.TIMEOUT,
    ErrorCategory.API
  ];

  // Check for specific retryable error patterns
  const message = error.message.toLowerCase();
  const isRetryablePattern =
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('rate limit') ||
    message.includes('503') ||
    message.includes('502');

  return retryableCategories.includes(category) || isRetryablePattern;
}

/**
 * Determine if an error is transient (temporary)
 */
export function isTransient(error: Error | unknown): boolean {
  if (error instanceof AppError) {
    return error.transient;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const category = classifyError(error);

  // Network and timeout errors are typically transient
  const transientCategories = [
    ErrorCategory.NETWORK,
    ErrorCategory.TIMEOUT
  ];

  const message = error.message.toLowerCase();
  const isTransientPattern =
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('rate limit');

  return transientCategories.includes(category) || isTransientPattern;
}

/**
 * Determine the severity level for an error
 */
export function getSeverity(error: Error | unknown): ErrorSeverity {
  if (error instanceof AppError) {
    return error.severity;
  }

  const category = classifyError(error);

  // Configuration errors are fatal
  if (category === ErrorCategory.CONFIGURATION) {
    return ErrorSeverity.FATAL;
  }

  // Permission errors are typically fatal (need admin intervention)
  if (category === ErrorCategory.PERMISSION) {
    return ErrorSeverity.FATAL;
  }

  // Default to error level
  return ErrorSeverity.ERROR;
}

/**
 * Create a user-friendly error message
 */
export function createUserMessage(error: Error | unknown): string {
  if (error instanceof AppError) {
    return error.userMessage || error.message;
  }

  if (!(error instanceof Error)) {
    return 'An unknown error occurred';
  }

  const category = classifyError(error);

  switch (category) {
    case ErrorCategory.NETWORK:
      return 'Network error. Please check your connection and try again.';
    case ErrorCategory.TIMEOUT:
      return 'Operation timed out. Please try again.';
    case ErrorCategory.API:
      return 'Service unavailable. Please try again later.';
    case ErrorCategory.VALIDATION:
      return 'Invalid input. Please check your request and try again.';
    case ErrorCategory.PERMISSION:
      return 'You do not have permission to perform this action.';
    case ErrorCategory.CONFIGURATION:
      return 'Configuration error. Please contact support.';
    case ErrorCategory.FILESYSTEM:
      return 'File system error. Please check file permissions.';
    case ErrorCategory.WEBSOCKET:
      return 'Connection error. Reconnecting...';
    default:
      return 'An unexpected error occurred. Please try again.';
  }
}

/**
 * Enrich error with additional context
 */
export function enrichError(
  error: Error | unknown,
  context: ErrorContext = {}
): AppError {
  // If it's already an AppError, merge context
  if (error instanceof AppError) {
    return new AppError(
      error.message,
      error.category,
      error.severity,
      {
        ...error.context,
        ...context,
        cause: error.originalError || error
      }
    );
  }

  // Convert unknown error to Error
  const errorObj = error instanceof Error ? error : new Error(String(error));

  // Classify the error
  const category = context.category || classifyError(errorObj);
  const severity = context.errorId ? ErrorSeverity.FATAL : getSeverity(errorObj);
  const retryable = context.retryable ?? isRetryable(errorObj);
  const transient = context.transient ?? isTransient(errorObj);
  const userMessage = context.userMessage || createUserMessage(errorObj);

  return new AppError(
    errorObj.message,
    category,
    severity,
    {
      retryable,
      transient,
      userMessage,
      context,
      cause: errorObj
    }
  );
}

/**
 * Log an error with full context using Pino
 */
export function logError(
  error: Error | unknown,
  context: ErrorContext = {},
  customLogger?: Logger
): void {
  const logger = customLogger || getErrorHandlerLogger();
  const enriched = enrichError(error, context);

  const {severity} = enriched;
  const logData: Record<string, unknown> = {
    err: error instanceof Error ? error : undefined,
    errorId: enriched.errorId,
    category: enriched.category,
    retryable: enriched.retryable,
    transient: enriched.transient,
    userMessage: enriched.userMessage,
    ...context
  };

  // Log at appropriate level
  switch (severity) {
    case ErrorSeverity.FATAL:
      logger.fatal(logData, enriched.message);
      break;
    case ErrorSeverity.ERROR:
      logger.error(logData, enriched.message);
      break;
    case ErrorSeverity.WARN:
      logger.warn(logData, enriched.message);
      break;
  }
}

/**
 * Handle an error with logging and optional user notification
 */
export function handleError(
  error: Error | unknown,
  context: ErrorContext = {},
  options: {
    log?: boolean;
    throwOnError?: boolean;
    userNotifier?: (message: string) => void | Promise<void>;
    customLogger?: Logger;
  } = {}
): AppError {
  const {
    log = true,
    throwOnError = false,
    userNotifier,
    customLogger
  } = options;

  const enriched = enrichError(error, context);

  // Log the error
  if (log) {
    logError(error, context, customLogger);
  }

  // Notify user if notifier provided
  if (userNotifier) {
    const userMessage = enriched.userMessage || enriched.message;
    void userNotifier(userMessage);
  }

  // Throw if requested
  if (throwOnError) {
    throw enriched;
  }

  return enriched;
}
