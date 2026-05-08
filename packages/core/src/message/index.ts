/**
 * Message module — Unified message routing (RFC #3329 Phase 1).
 *
 * Provides the UnifiedMessageRouter for routing UserMessage, SystemMessage,
 * and AgentMessage to ChatAgent instances.
 *
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 * @see Issue #3331 (Phase 1: NonUserMessage type definition and routing layer)
 */

export {
  UnifiedMessageRouter,
  // Dependency interfaces
  type RouteableAgent,
  type RouteableAgentPool,
  type ProjectConfigResolver,
  type ProjectRoutingInfo,
  type UnifiedMessageRouterConfig,
  type RouteResult,
} from './unified-message-router.js';
