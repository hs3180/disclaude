/**
 * Application-wide constants.
 */

/**
 * Message deduplication constants
 */
export const DEDUPLICATION = {
  /** Maximum number of message IDs to keep in memory */
  MAX_PROCESSED_IDS: 1000,

  /** Maximum age of messages to process (milliseconds) */
  MAX_MESSAGE_AGE: 60 * 1000, // 1 minute

  /** Message deduplication record expiration time (milliseconds) */
  RECORD_EXPIRATION_MS: 2 * 60 * 1000, // 2 minutes
} as const;

/**
 * Long task configuration
 */
export const LONG_TASK = {
  /** Default timeout for long tasks (milliseconds) */
  DEFAULT_TASK_TIMEOUT_MS: 24 * 60 * 60 * 1000, // 24 hours

  /** Maximum number of concurrent long tasks per chat */
  MAX_CONCURRENT_TASKS_PER_CHAT: 1,
} as const;

/**
 * Throttling constants
 */
export const THROTTLING = {
  /** Minimum interval between progress messages (milliseconds) */
  PROGRESS_MESSAGE_INTERVAL_MS: 2000, // 2 seconds
} as const;

/**
 * File deduplication configuration
 */
export const FILE_DEDUPLICATION = {
  /** Directory for deduplication records */
  DEDUPE_DIR: './dedupe-records',

  /** Maximum number of records to keep per chat */
  MAX_RECORDS_PER_CHAT: 100,
} as const;

/**
 * Dialogue/Agent loop configuration
 */
export const DIALOGUE = {
  /** Maximum number of iterations in the dialogue loop */
  MAX_ITERATIONS: 3,
} as const;
