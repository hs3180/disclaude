/**
 * Context compression module (Issue #1311).
 *
 * Provides AI-based context compression for chat history,
 * replacing hard truncation with intelligent summarization.
 */

export { ContextCompressor } from './context-compressor.js';
export type {
  ContextCompressionConfig,
  CompressionResult,
  CompressionStats,
  MessageBoundary,
} from './types.js';
