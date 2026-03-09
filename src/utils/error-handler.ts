/**
 * Enhanced Error Handling Module
 *
 * Re-exported from @disclaude/core for backward compatibility.
 * New code should import directly from '@disclaude/core'.
 *
 * @deprecated Import from '@disclaude/core' instead
 * @module utils/error-handler
 */

export {
  AppError,
  ErrorCategory,
  ErrorSeverity,
  classifyError,
  isRetryable,
  isTransient,
  getSeverity,
  createUserMessage,
  enrichError,
  logError,
  handleError,
  formatError,
} from '@disclaude/core';

export type { ErrorContext } from '@disclaude/core';
