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
 * Dialogue/Agent loop configuration
 */
export const DIALOGUE = {
  /** Maximum number of iterations in the dialogue loop */
  MAX_ITERATIONS: 20,
} as const;

/**
 * Message logging configuration
 */
export const MESSAGE_LOGGING = {
  /** Directory for message logs */
  LOGS_DIR: 'chat',

  /** Regex to extract message IDs from MD files */
  MD_PARSE_REGEX: /message_id:\s*([^\)]+)/g,
} as const;

/**
 * Reaction emoji constants for message feedback
 */
export const REACTIONS = {
  /** Emoji to indicate the bot is typing/processing (👀 = 正在查看/处理中) */
  TYPING: 'Typing',
} as const;
