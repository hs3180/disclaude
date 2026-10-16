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
 * Prefer the stored tag and structured status; wording is the final fallback.
 */
export function classifyError(error: Error | unknown): ErrorCategory {
  const cached = getErrorCategoryTag(error);
  if (cached) { return cached.category; }
  // If it's already an AppError, return its category
  if (error instanceof AppError) {
    return error.category;
  }

  const evidence = structuredErrorEvidence(error);
  if (evidence) { return evidence.category; }

  if (!(error instanceof Error)) {
    return ErrorCategory.UNKNOWN;
  }

  const message = error.message.toLowerCase();
  const name = error.constructor.name.toLowerCase();

  // WebSocket errors (check before network to prioritize)
  if (
    name.includes('websocket') ||
    message.includes('websocket')
  ) {
    return ErrorCategory.WEBSOCKET;
  }

  // Network errors
  if (
    name.includes('network') ||
    message.includes('network') ||
    message.includes('connection') ||
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
    messageHttpStatus(message) !== undefined
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

  return ErrorCategory.UNKNOWN;
}

/**
 * Determine if an error is retryable
 */
export function isRetryable(error: Error | unknown): boolean {
  if (error instanceof AppError) {
    return error.retryable;
  }

  return tagErrorCategory(error).transient;
}

/** Only recognized HTTP error forms may supply a status through text. */
function messageHttpStatus(message: string): number | undefined {
  const match = /\b(?:http(?:\/\d(?:\.\d)?)?(?:\s+(?:status|error))?|api\s+error|status(?:\s+code)?)\s*[:=]?\s*\[?\s*([45]\d{2})\b/i.exec(message)
    ?? /^\s*([45]\d{2})(?=\s*(?:$|:)|\s+(?:too many requests|bad gateway|service unavailable)\b)/i.exec(message)
    ?? /\b(?:bad gateway|service unavailable)\s*\(?\s*(50[23])\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function validHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function transientHttpStatus(status: number): boolean {
  return [408, 409, 425, 429].includes(status) || status >= 500;
}

/** Read machine-owned fields before looking at wording, including a bounded cause chain. */
function structuredErrorEvidence(error: unknown): ErrorCategoryTag | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) { break; }
    seen.add(current);
    const entry = current as Record<string, unknown>;
    const response = entry.response && typeof entry.response === 'object'
      ? entry.response as Record<string, unknown> : undefined;
    const status = [entry.apiErrorStatus, entry.status, entry.statusCode, response?.status].find(validHttpStatus);
    const transient = typeof entry.apiErrorIsTransient === 'boolean' ? entry.apiErrorIsTransient : undefined;
    if (status !== undefined || transient !== undefined) {
      return { category: status === 401 || status === 403 ? ErrorCategory.PERMISSION : ErrorCategory.API,
        transient: transient ?? (status !== undefined && transientHttpStatus(status)),
        ...(status === undefined ? {} : { status }), source: 'structured' };
    }
    if (typeof entry.code === 'string' && /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)$/.test(entry.code)) {
      return { category: ErrorCategory.NETWORK, transient: true, source: 'structured' };
    }
    current = entry.cause;
  }
  return undefined;
}

/**
 * Derive the transient flag from an already-computed {@link ErrorCategory} and
 * lowercased message. Single source of truth shared by {@link isTransient} and
 * {@link tagErrorCategory}, so an error is classified at most once per tag.
 *
 * Only covers plain-`Error` classification; {@link AppError} short-circuits in
 * the callers via its stored `transient` field.
 */
function isTransientFor(category: ErrorCategory, message: string): boolean {
  // Network and timeout errors are typically transient.
  if (category === ErrorCategory.NETWORK || category === ErrorCategory.TIMEOUT) {
    return true;
  }

  const status = messageHttpStatus(message);
  return (
    /\b(?:timeout|etimedout|econnreset|rate limit(?:ed)?|rate_limit(?:_error)?|too many requests)\b/.test(message) ||
    (status !== undefined && [429, 502, 503].includes(status))
  );
}

/**
 * Determine if an error is transient (temporary)
 */
export function isTransient(error: Error | unknown): boolean {
  return tagErrorCategory(error).transient;
}

/**
 * Symbol under which {@link tagErrorCategory} attaches its classification so
 * downstream handlers can branch on it without re-classifying. Issue #4192 (L0).
 */
const ERROR_CATEGORY_SYMBOL = Symbol('errorCategory');

/**
 * Classified error category + transient flag, attachable to an Error.
 * Issue #4192 (L0): lets the agent loop / restart manager branch on the
 * classified category (e.g. retry transient NETWORK/TIMEOUT, surface CONFIG)
 * without re-running classification.
 */
export interface ErrorCategoryTag {
  category: ErrorCategory;
  transient: boolean;
  status?: number;
  source?: 'structured';
}

/**
 * Classify an error and attach the result to it (mirrors the `STDERR_SYMBOL`
 * pattern in the Claude provider). Returns the classification so the caller
 * can also log it inline. Idempotent — safe to call on an already-tagged error.
 *
 * Issue #4192 (L0): wires `classifyError`/`isTransient` into the error path so
 * the category is available both in structured logs and to later recovery
 * layers (L1 in-request retry, L2 turn replay).
 */
export function tagErrorCategory(error: unknown, evidence?: unknown): ErrorCategoryTag {
  const cached = evidence === undefined ? getErrorCategoryTag(error) : undefined;
  if (cached) { return cached; }
  // Classify once and derive `transient` from the same category (Issue #4192
  // review nit #1) — avoids the previous double `classifyError` via `isTransient`.
  const structured = error instanceof AppError && evidence === undefined ? undefined
    : structuredErrorEvidence(evidence ?? error);
  const category = structured?.category ?? classifyError(error);
  const transient =
    structured ? structured.transient : error instanceof AppError
      ? error.transient
      : isTransientFor(category, error instanceof Error ? error.message.toLowerCase() : '');
  const status = structured?.status ?? (error instanceof Error ? messageHttpStatus(error.message) : undefined);
  const tag = { category, transient, ...(status === undefined ? {} : { status }),
    ...(structured?.source ? { source: structured.source } : {}) };
  if (error instanceof Error && Object.isExtensible(error)) {
    (error as Error & { [ERROR_CATEGORY_SYMBOL]: ErrorCategoryTag })[ERROR_CATEGORY_SYMBOL] = tag;
  }
  return tag;
}

/**
 * Read a previously-attached {@link ErrorCategoryTag}. Returns `undefined` if
 * the error was never tagged or is not an Error. Issue #4192 (L0).
 *
 * Caveat (Issue #4192, L1/L2): the tag lives on one specific `Error` object.
 * If a downstream layer re-wraps the error (`new Error(...)`, or throws a fresh
 * error carrying only `.cause`), this returns `undefined` — re-tag the new
 * error, or read the original via `cause`, instead of relying on the tag here.
 */
export function getErrorCategoryTag(error: unknown): ErrorCategoryTag | undefined {
  if (error instanceof Error) {
    return (error as Error & { [ERROR_CATEGORY_SYMBOL]: ErrorCategoryTag })[ERROR_CATEGORY_SYMBOL];
  }
  return undefined;
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

/**
 * Format an error for logging.
 *
 * @param error - Error to format
 * @returns Formatted error object suitable for logging
 */
export function formatError(error: Error | unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return error.toJSON();
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: 'UnknownError',
    message: String(error),
  };
}
