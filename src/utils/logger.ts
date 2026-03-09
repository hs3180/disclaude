/**
 * Logger Factory Module
 *
 * Re-exported from @disclaude/core for backward compatibility.
 * New code should import directly from '@disclaude/core'.
 *
 * @deprecated Import from '@disclaude/core' instead
 * @module utils/logger
 */

export {
  createLogger,
  initLogger,
  getRootLogger,
  resetLogger,
  setLogLevel,
  isLevelEnabled,
  flushLogger,
} from '@disclaude/core';

export type { LoggerConfig, LogLevel } from '@disclaude/core';
