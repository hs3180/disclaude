/**
 * Retry utility for transient failures.
 *
 * Provides exponential backoff retry logic for operations that may fail
 * due to transient issues (network, timeouts, etc.).
 */

import { isRetryable } from './error-handler.js';

/**
 * Retry configuration options.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000ms) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000ms) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Whether to jitter the delay (default: true) */
  jitter?: boolean;
  /** Callback called before each retry */
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Default retry options.
 */
const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
  onRetry: () => {},
};

/**
 * Compute the (jittered) exponential-backoff delay for a retry attempt.
 *
 * Issue #4192: the backoff curve is defined once here (previously duplicated
 * inline in `retry` and `retryAsyncIterable`) so the provider/loop retry layers
 * can reuse it instead of reinventing it. Behavior is identical to the previous
 * inline calculation: `min(initialDelayMs * multiplier ** attempt, maxDelayMs)`,
 * scaled by `(0.5 + random*0.5)` when `jitter` is on (i.e. into
 * `[0.5*delay, delay]`, "half-jitter" to avoid thundering herd).
 *
 * @param attempt - 0-based retry attempt index.
 * @param opts - Timing options (only these four fields are read).
 * @param random - Injectable RNG in `[0, 1]` for deterministic tests. Defaults to `Math.random`.
 * @returns Delay in milliseconds.
 */
export function computeBackoffDelay(
  attempt: number,
  opts: {
    initialDelayMs: number;
    backoffMultiplier: number;
    maxDelayMs: number;
    jitter: boolean;
  },
  random: () => number = Math.random,
): number {
  const baseDelay = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt);
  const delay = Math.min(baseDelay, opts.maxDelayMs);
  return opts.jitter ? delay * (0.5 + random() * 0.5) : delay;
}

/**
 * Retry an operation with exponential backoff.
 *
 * @param operation - Operation to retry (should return a Promise)
 * @param options - Retry configuration options
 * @returns Result of the operation
 * @throws Last error if all retries fail
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // Attempt the operation
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this is the last attempt
      if (attempt === opts.maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryable(lastError)) {
        break;
      }

      // Calculate delay with exponential backoff (+ jitter). Issue #4192: the
      // curve lives in computeBackoffDelay so it's defined once and reusable.
      const jitteredDelay = computeBackoffDelay(attempt, opts);

      // Call retry callback
      opts.onRetry(attempt + 1, lastError);

      // Wait before retrying
      await delayMs(jitteredDelay);
    }
  }

  // All retries failed
  throw lastError;
}

/**
 * Retry an async iterable operation with exponential backoff.
 *
 * This is useful for SDK queries that return async iterables.
 * If an error occurs during iteration, the entire operation is retried.
 *
 * @param operation - Operation to retry (should return an AsyncIterable)
 * @param options - Retry configuration options
 * @returns AsyncIterable of the operation results
 */
export async function* retryAsyncIterable<T>(
  operation: () => AsyncIterable<T>,
  options: RetryOptions = {}
): AsyncIterable<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };

  let attempt = 0;

  while (attempt <= opts.maxRetries) {
    try {
      // Attempt the operation
      yield* operation();
      return; // Success
    } catch (error) {
      const lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this is the last attempt
      if (attempt === opts.maxRetries) {
        throw lastError;
      }

      // Check if error is retryable
      if (!isRetryable(lastError)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff (+ jitter). Issue #4192: reuse
      // the shared computeBackoffDelay curve (same as retry() above).
      const jitteredDelay = computeBackoffDelay(attempt, opts);

      // Call retry callback
      opts.onRetry(attempt + 1, lastError);

      // Wait before retrying
      await delayMs(jitteredDelay);

      // Increment attempt counter
      attempt++;
    }
  }
}

/**
 * Delay helper.
 *
 * @param ms - Milliseconds to delay
 * @returns Promise that resolves after delay
 */
function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a retry wrapper for a function with default options.
 *
 * @param operation - Operation to wrap
 * @param defaultOptions - Default retry options
 * @returns Wrapped function with retry logic
 */
export function withRetry<T extends (...args: unknown[]) => Promise<unknown>>(
  operation: T,
  defaultOptions: RetryOptions = {}
): T {
  return ((...args: Parameters<T>) => {
    return retry(() => operation(...args), defaultOptions);
  }) as T;
}
