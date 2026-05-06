/**
 * NonUserMessage module — system-driven task pipeline for ChatAgent.
 *
 * This module provides:
 * - `NonUserMessage` type definition
 * - `NonUserMessageRouter` for routing system messages to ChatAgents
 * - Dependency injection interfaces (`IProjectRoutingProvider`, `IAgentMessageDelivery`)
 *
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 * @see Issue #3329 (RFC: NonUserMessage — System-Driven Task Pipeline for ChatAgent 0.4.0)
 */

export type {
  NonUserMessage,
  NonUserMessageType,
  NonUserMessagePriority,
  ProjectRoutingConfig,
  RouteResult,
  IProjectRoutingProvider,
  IAgentMessageDelivery,
} from './types.js';

export {
  NonUserMessageRouter,
} from './non-user-message-router.js';

export type {
  NonUserMessageRouterConfig,
} from './non-user-message-router.js';
