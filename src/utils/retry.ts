/**
 * Retry utility for transient failures.
 *
 * Re-exported from @disclaude/core for backward compatibility.
 * New code should import directly from '@disclaude/core'.
 *
 * @deprecated Import from '@disclaude/core' instead
 */

export {
  retry,
  retryAsyncIterable,
  withRetry,
} from '@disclaude/core';

export type { RetryOptions } from '@disclaude/core';
