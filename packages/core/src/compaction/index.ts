/**
 * Compaction module - Framework-level context compaction for active agents.
 *
 * Provides consistent context management across different SDK providers,
 * independent of SDK-specific compaction behavior.
 *
 * @module compaction
 * @see Issue #1336
 */

export {
  CompactionManager,
  DEFAULT_COMPACTION_CONFIG,
} from './compaction-manager.js';

export type {
  CompactionConfig,
  ResolvedCompactionConfig,
  CompactionStrategy,
  ContextUsage,
  CompactionEvent,
  CompactionEventType,
  CompactionEventCallback,
} from './types.js';
