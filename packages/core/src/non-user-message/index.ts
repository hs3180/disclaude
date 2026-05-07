/**
 * NonUserMessage module - System-driven task pipeline for ChatAgent.
 *
 * This module defines the types and interfaces for routing system-originated
 * messages (scheduled tasks, A2A delegation, webhooks) to project-bound
 * ChatAgent instances.
 *
 * Issue #3331: NonUserMessage type definition (Phase 1 of RFC #3329).
 * Issue #3333: Scheduler integration with NonUserMessage (Phase 3).
 *
 * @module @disclaude/core/non-user-message
 */

export {
  // Types
  type NonUserMessage,
  type NonUserMessageType,
  type NonUserMessagePriority,
  // Routing types
  type ProjectRoutingConfig,
  type RouteResult,
  // DI Interfaces
  type IProjectRoutingProvider,
  type IAgentMessageDelivery,
  type INonUserMessageRouter,
} from './types.js';
