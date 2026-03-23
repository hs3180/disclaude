/**
 * Conversation module - Core conversation management utilities.
 *
 * This module provides:
 * - MessageQueue: Producer-consumer pattern for message streaming
 * - ConversationSessionManager: Agent-agnostic session lifecycle
 * - ConversationOrchestrator: High-level conversation coordination
 *
 * @module conversation
 */

export { MessageQueue } from './message-queue.js';
export {
  ConversationSessionManager,
  type ConversationSessionManagerConfig,
} from './conversation-session-manager.js';
export {
  ConversationOrchestrator,
  type ConversationOrchestratorConfig,
} from './conversation-orchestrator.js';

export type {
  QueuedMessage,
  SessionState,
  SessionCallbacks,
  CreateSessionOptions,
  ProcessMessageResult,
  SessionStats,
  ConversationMessageContext,
} from './types.js';

// Session timeout management (Issue #1313)
export {
  SessionTimeoutManager,
  type SessionTimeoutCallbacks,
  type TimeoutCheckResult,
  type ResolvedTimeoutConfig,
} from './session-timeout-manager.js';

// Compaction management (Issue #1336)
export {
  CompactionManager,
  type CompactionCallbacks,
  type CompactionCheckResult,
  type TokenUsageStats,
  type ResolvedCompactionConfig,
} from './compaction-manager.js';
