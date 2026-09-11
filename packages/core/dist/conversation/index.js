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
export { ConversationSessionManager, } from './conversation-session-manager.js';
export { ConversationOrchestrator, } from './conversation-orchestrator.js';
// Session timeout management (Issue #1313)
export { SessionTimeoutManager, } from './session-timeout-manager.js';
