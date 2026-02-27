/**
 * Conversation Layer - Agent-agnostic conversation management components.
 *
 * This module provides a unified interface for managing conversations
 * independent of the agent implementation (Claude, OpenAI, etc.) and
 * platform (Feishu, REST API, etc.).
 *
 * ## Architecture
 *
 * ```
 * Pilot (or other Agent)
 *       ↓
 * ConversationOrchestrator (high-level API)
 *       ↓
 * ConversationSessionManager (session lifecycle)
 *       ↓
 * MessageQueue (message buffering)
 *       ↓
 * Types (shared interfaces)
 * ```
 *
 * ## Components
 *
 * | Component | Purpose |
 * |-----------|---------|
 * | `types` | Shared type definitions |
 * | `MessageQueue` | Producer-consumer message queue |
 * | `ConversationSessionManager` | Session lifecycle management |
 * | `ConversationOrchestrator` | High-level API |
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   ConversationOrchestrator,
 *   type QueuedMessage,
 *   type SessionCallbacks
 * } from './conversation/index.js';
 *
 * const orchestrator = new ConversationOrchestrator({ logger });
 *
 * // Process a message
 * const message: QueuedMessage = {
 *   text: 'Hello',
 *   messageId: '123'
 * };
 * const isNewSession = await orchestrator.processMessage(chatId, message, callbacks);
 *
 * // Get active session count
 * const count = orchestrator.getActiveSessionCount();
 *
 * // Reset a session
 * orchestrator.reset(chatId);
 *
 * // Shutdown
 * await orchestrator.shutdown();
 * ```
 */

// Types
export type {
  QueuedMessage,
  SessionState,
  SessionCallbacks,
  CreateSessionOptions,
  ProcessMessageResult,
  ConversationStats,
  ConversationOrchestratorOptions,
  SessionStats,
  MessageContext,
} from './types.js';

// Components
export { MessageQueue } from './message-queue.js';
export {
  ConversationSessionManager,
  type ConversationSessionManagerConfig,
  type CreateSessionOptions as SessionCreateOptions,
} from './session-manager.js';
export {
  ConversationOrchestrator,
  type ConversationOrchestratorConfig,
  type OnCreateSession,
} from './conversation-orchestrator.js';
