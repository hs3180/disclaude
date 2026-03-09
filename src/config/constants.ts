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

/**
 * Feishu API configuration constants (Issue #498, #507)
 */
export const FEISHU_API = {
  /** Request timeout in milliseconds (30 seconds) */
  REQUEST_TIMEOUT_MS: 30 * 1000,

  /** Retry configuration for transient errors */
  RETRY: {
    /** Maximum number of retry attempts */
    MAX_RETRIES: 3,
    /** Initial delay in milliseconds before first retry */
    INITIAL_DELAY_MS: 1000,
    /** Maximum delay in milliseconds between retries */
    MAX_DELAY_MS: 10000,
    /** Multiplier for exponential backoff */
    BACKOFF_MULTIPLIER: 2,
  },
} as const;

/**
 * Chat history configuration for passive mode (Issue #517)
 */
export const CHAT_HISTORY = {
  /** Maximum characters for chat history context */
  MAX_CONTEXT_LENGTH: 8000,

  /** Maximum number of messages to include in context */
  MAX_MESSAGES: 50,
} as const;

/**
 * Session restoration configuration (Issue #955)
 */
export const SESSION_RESTORE = {
  /** Number of days to look back for chat history */
  HISTORY_DAYS: 7,

  /** Maximum characters for restored session context */
  MAX_CONTEXT_LENGTH: 4000,
} as const;

/**
 * Context compression configuration (Issue #1213)
 * AI-based compression to reduce token usage while preserving semantic information
 */
export const CONTEXT_COMPRESSION = {
  /** Enable context compression */
  ENABLED: true,

  /** Character threshold to trigger compression */
  THRESHOLD: 10000,

  /** Number of recent messages to keep uncompressed */
  KEEP_RECENT_MESSAGES: 5,

  /** Maximum length of generated summary */
  SUMMARY_MAX_LENGTH: 2000,
} as const;

/**
 * Error codes that should trigger a retry
 */
export const RETRYABLE_ERROR_CODES = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPROTO',
] as const;
