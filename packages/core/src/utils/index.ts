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

// SDK Utilities (Issue #1040)
export {
  getNodeBinDir,
  extractText,
  buildSdkEnv,
} from './sdk.js';

// CDP Health Check (Issue #1040)
export type { CdpHealthCheckResult } from './cdp-health-check.js';
export {
  parseCdpEndpoint,
  checkCdpEndpointHealth,
  formatCdpHealthError,
} from './cdp-health-check.js';

// Output Adapter (Issue #1040)
export type { OutputAdapter, MessageMetadata, FeishuOutputAdapterOptions } from './output-adapter.js';
export {
  CLIOutputAdapter,
  FeishuOutputAdapter,
} from './output-adapter.js';

// Mention Parser (Issue #689)
export type { ParsedMention } from './mention-parser.js';
export {
  parseMentions,
  isUserMentioned,
  extractMentionedOpenIds,
  normalizeMentionPlaceholders,
  stripLeadingMentions,
} from './mention-parser.js';

// Skills Setup
export {
  setupSkillsInWorkspace,
} from './skills-setup.js';

// Agents Setup (Issue #1410)
export {
  setupAgentsInWorkspace,
} from './agents-setup.js';

// File Utils (Issue #1637)
export {
  detectFileExtension,
  mimeToExtension,
  getContentTypeFromHeaders,
  ensureFileExtension,
  ensureFileExtensionFromPath,
} from './file-utils.js';

// Project Context (Issue #1506)
export {
  readProjectClaudeMd,
  MAX_PROJECT_CONTEXT_SIZE,
} from './project-context.js';
