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
 * WebSocket health monitoring constants (Issue #1351)
 *
 * Controls the detection of zombie WebSocket connections and auto-reconnect behavior.
 * The Feishu SDK's WSClient uses an application-layer Ping/Pong protocol over the `ws`
 * npm package (NOT standard WebSocket ping/pong frames). This manager attaches its
 * own listener to the SDK's internal WebSocket instance to detect Pong responses
 * as a transport-level liveness signal.
 *
 * When NAT/firewall silently drops a connection, the SDK's pingLoop sends pings but
 * may not receive Pong responses. The health check detects this absence and triggers
 * a reconnect before the SDK's own close event fires.
 */
export const WS_HEALTH = {
  /**
   * Maximum duration without receiving any server message before considering
   * the connection dead. Should be > SDK's pingInterval (default 120s,
   * configurable by server via Pong response). If no message (data, pong,
   * or control) arrives within this window, the connection is force-closed
   * and reconnection is triggered.
   *
   * Set to 5 minutes to allow for 2-3 missed Pong cycles (pingInterval=120s)
   * before triggering reconnect, avoiding false positives during temporary
   * network glitches.
   */
  DEAD_CONNECTION_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes

  /**
   * Interval between health checks. Each tick compares now against
   * lastPongAt (primary) or lastMessageReceived (fallback) to detect
   * zombie connections.
   */
  HEALTH_CHECK_INTERVAL_MS: 30 * 1000, // 30 seconds

  /**
   * Exponential backoff configuration for reconnection attempts.
   * Uses: delay = min(baseDelay × 2^attempt + jitter, maxDelay)
   * Jitter range: [0, jitterMs) to spread out concurrent reconnects.
   */
  RECONNECT: {
    /** Base delay before first reconnect attempt (ms) */
    BASE_DELAY_MS: 1000,
    /** Maximum delay cap between attempts (ms) */
    MAX_DELAY_MS: 60 * 1000,
    /** Exponential multiplier per attempt */
    BACKOFF_MULTIPLIER: 2,
    /** Random jitter range (ms) to prevent thundering herd */
    JITTER_MS: 500,
    /** Maximum number of reconnect attempts (-1 = infinite) */
    MAX_ATTEMPTS: -1,
  },

  /**
   * Offline message queue configuration.
   * Messages sent during reconnection are queued and flushed after reconnect.
   */
  OFFLINE_QUEUE: {
    /** Maximum number of messages to buffer while offline */
    MAX_SIZE: 100,
    /** Maximum age of queued messages before discarding (ms) */
    MAX_MESSAGE_AGE_MS: 10 * 60 * 1000, // 10 minutes
  },
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
