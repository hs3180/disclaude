/**
 * Context compression type definitions (Issue #1311).
 *
 * Defines the types for AI-based context compression that replaces
 * hard truncation with intelligent summarization.
 */

/**
 * Configuration for context compression.
 *
 * Controls how chat history is compressed when it exceeds the threshold:
 * - History is split into "older" and "recent" parts
 * - Older messages are summarized by AI
 * - Recent messages are kept intact
 * - Result is summary + recent messages
 */
export interface ContextCompressionConfig {
  /** Enable/disable AI-based context compression (default: false) */
  enabled?: boolean;

  /**
   * Character threshold for triggering compression.
   * When history exceeds this length, compression is applied.
   * Default: 3000 characters.
   */
  threshold?: number;

  /**
   * Number of recent messages to keep intact (not summarized).
   * Default: 4 messages.
   */
  keepRecentMessages?: number;

  /**
   * Maximum tokens for the AI-generated summary.
   * Used as a guideline in the summarization prompt.
   * Default: 500 tokens.
   */
  summaryMaxTokens?: number;
}

/**
 * Result of a context compression operation.
 */
export interface CompressionResult {
  /** Whether compression was applied */
  compressed: boolean;

  /** The resulting content (either compressed or original) */
  content: string;

  /** Original content length in characters */
  originalLength: number;

  /** Compressed content length in characters */
  compressedLength: number;

  /** Length of the AI-generated summary (0 if not compressed) */
  summaryLength: number;
}

/**
 * Internal state for tracking compression statistics.
 */
export interface CompressionStats {
  /** Total number of compressions performed */
  totalCompressions: number;

  /** Total characters saved by compression */
  totalCharsSaved: number;

  /** Last compression timestamp */
  lastCompressedAt?: number;
}

/**
 * Message boundary found during history splitting.
 */
export interface MessageBoundary {
  /** Start index of the message */
  start: number;
  /** End index of the message (exclusive) */
  end: number;
  /** The message content */
  content: string;
}
