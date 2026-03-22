/**
 * Conversation module - Core conversation management utilities.
 *
 * This module provides:
 * - MessageQueue: Producer-consumer pattern for message streaming
 * - ConversationSessionManager: Agent-agnostic session lifecycle
 * - ConversationOrchestrator: High-level conversation coordination
 * - ContextCompactManager: Framework-level auto compacting for active agents
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
export {
  ContextCompactManager,
  type ContextCompactCallbacks,
} from './context-compact-manager.js';

export type {
  QueuedMessage,
  SessionState,
  SessionCallbacks,
  CreateSessionOptions,
  ProcessMessageResult,
  SessionStats,
  ConversationMessageContext,
} from './types.js';
