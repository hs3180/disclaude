/**
 * Conversation Management Layer
 *
 * This module provides agent-agnostic conversation management components:
 *
 * - **ConversationOrchestrator**: High-level API for conversation management
 * - **ConversationSessionManager**: Session lifecycle management
 * - **MessageQueue**: Producer-consumer pattern for message streaming
 * - **Types**: Shared interfaces and types
 *
 * ## Architecture
 *
 * ```
 * src/conversation/
 * ├── index.ts                      # This file - public exports
 * ├── types.ts                      # Shared interfaces
 * ├── message-queue.ts              # Queue + Resolver pattern
 * ├── session-manager.ts            # Session lifecycle management
 * └── conversation-orchestrator.ts  # Main entry point
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { ConversationOrchestrator, type QueuedMessage } from './conversation';
 *
 * const orchestrator = new ConversationOrchestrator({
 *   logger,
 *   callbacks: {
 *     onMessage: async (chatId, text, threadId) => { ... },
 *     onDone: async (chatId, threadId) => { ... },
 *   },
 * });
 *
 * // Process a message
 * const result = orchestrator.processMessage(chatId, {
 *   text: 'Hello',
 *   messageId: 'msg-123',
 * });
 *
 * // Reset a session
 * orchestrator.reset(chatId);
 *
 * // Shutdown
 * await orchestrator.shutdown();
 * ```
 *
 * ## Design Principles
 *
 * 1. **Single Responsibility**: Each module has one clear purpose
 * 2. **Dependency Injection**: Accepts callbacks, doesn't create them
 * 3. **Agent-Agnostic**: Can be used by any agent type (Pilot, CLI, etc.)
 * 4. **Interface Segregation**: Small, focused interfaces
 */

// Main entry point
export { ConversationOrchestrator, type ConversationOrchestratorConfig } from './conversation-orchestrator.js';

// Session management
export {
  ConversationSessionManager,
  type ConversationSessionManagerConfig,
} from './session-manager.js';

// Message queue
export { MessageQueue } from './message-queue.js';

// Types
export type {
  QueuedMessage,
  SessionState,
  SessionCallbacks,
  CreateSessionOptions,
  ProcessMessageResult,
  SessionStats,
  MessageContext,
} from './types.js';

// Thread management (Issue #1072)
export {
  ThreadManager,
  type Thread,
  type ChatThreadState,
  type ThreadManagerConfig,
} from './thread-manager.js';
