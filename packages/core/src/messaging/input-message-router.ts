/**
 * InputMessageRouter — Unified routing for Message types to ChatAgent (Issue #3329 Phase 1).
 *
 * Routes all input Message types through a single path:
 * - UserMessage: chatId from message → AgentPool.getOrCreate(chatId) → processMessage
 * - SystemMessage with projectKey: resolve chatId from project config → AgentPool → runOnce
 * - SystemMessage without projectKey: legacy path (caller handles routing)
 *
 * @see Issue #3329 (RFC: Message — Unified Agent Input Abstraction)
 * @see Issue #3580 (Phase 1: Message types + MessageRouter)
 */

import type { ChatAgent } from '../agents/types.js';
import type { AgentPool } from '../agents/agent-pool.js';
import { createLogger, type Logger } from '../utils/logger.js';
import {
  isUserMessage,
  isSystemMessage,
  type InputMessage,
  type UserMessage,
  type SystemMessage,
} from '../types/message.js';

const defaultLogger = createLogger('InputMessageRouter');

// ============================================================================
// Project ChatId Resolution
// ============================================================================

/**
 * Resolves a projectKey to a chatId.
 *
 * Phase 2 will provide a real implementation backed by ProjectConfig.
 * Phase 1 uses a simple callback-based resolver for testing and future wiring.
 */
export interface ProjectChatIdResolver {
  /**
   * Resolve a projectKey to its bound chatId.
   *
   * @param projectKey - Project identifier (e.g. 'hs3180/disclaude')
   * @returns The bound chatId, or undefined if the project is not configured
   */
  resolve(projectKey: string): string | undefined;
}

// ============================================================================
// Route Result
// ============================================================================

/**
 * Result of routing a message.
 */
export interface RouteResult {
  /** Whether the message was successfully routed to an agent */
  routed: true;
  /** The chatId that was resolved for routing */
  chatId: string;
  /** How chatId was determined */
  method: 'user-direct' | 'project-resolved';
  /** The agent that received the message */
  agent: ChatAgent;
}

/**
 * Result when a message cannot be routed.
 */
export interface RouteFallback {
  /** The message was not routed through this router */
  routed: false;
  /** Reason for fallback */
  reason: 'no-project-key' | 'unknown-project' | 'missing-chat-id';
}

/**
 * Union type for route results.
 */
export type InputRouteResult = RouteResult | RouteFallback;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for InputMessageRouter.
 */
export interface InputMessageRouterConfig {
  /** Agent pool for getting/creating ChatAgent instances */
  agentPool: AgentPool;
  /** Resolver for projectKey → chatId (Phase 2 will provide a real implementation) */
  projectChatIdResolver?: ProjectChatIdResolver;
  /** Optional logger */
  logger?: Logger;
}

// ============================================================================
// InputMessageRouter
// ============================================================================

/**
 * InputMessageRouter — Unified routing for all Message types.
 *
 * Routes messages to the appropriate ChatAgent via AgentPool:
 * - UserMessage → direct chatId routing
 * - SystemMessage → projectKey-based chatId resolution → routing
 * - SystemMessage without projectKey → fallback (legacy path)
 */
export class InputMessageRouter {
  private readonly agentPool: AgentPool;
  private readonly projectChatIdResolver?: ProjectChatIdResolver;
  private readonly log: Logger;

  constructor(config: InputMessageRouterConfig) {
    this.agentPool = config.agentPool;
    this.projectChatIdResolver = config.projectChatIdResolver;
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Route a message to the appropriate ChatAgent.
   *
   * @param message - The message to route
   * @returns Route result indicating success or fallback reason
   */
  route(message: InputMessage): InputRouteResult {
    if (isUserMessage(message)) {
      return this.routeUserMessage(message);
    }

    if (isSystemMessage(message)) {
      return this.routeSystemMessage(message);
    }

    // Exhaustive check — should never reach here
    const _exhaustive: never = message;
    return _exhaustive;
  }

  /**
   * Route a UserMessage by its chatId.
   *
   * UserMessage carries its own chatId, so routing is direct:
   * chatId → AgentPool.getOrCreate(chatId) → processMessage
   */
  private routeUserMessage(message: UserMessage): RouteResult {
    const { chatId } = message;
    if (!chatId) {
      // Should never happen since chatId is required on UserMessage,
      // but handle defensively
      this.log.error({ messageId: message.id }, 'UserMessage missing chatId');
      return { routed: false, reason: 'missing-chat-id' };
    }

    this.log.debug(
      { chatId, messageId: message.id },
      'Routing UserMessage via direct chatId'
    );

    const agent = this.agentPool.getOrCreateChatAgent(chatId);
    agent.processMessage(
      chatId,
      message.payload,
      message.messageId,
      message.senderOpenId,
      undefined, // attachments — Phase 1 passes through payload only
      message.chatHistoryContext
    );

    return {
      routed: true,
      chatId,
      method: 'user-direct',
      agent,
    };
  }

  /**
   * Route a SystemMessage via projectKey resolution.
   *
   * - With projectKey → resolve chatId → AgentPool → runOnce
   * - Without projectKey → fallback (legacy path, caller handles routing)
   */
  private routeSystemMessage(message: SystemMessage): InputRouteResult {
    if (!message.projectKey) {
      this.log.debug(
        { messageId: message.id, trigger: message.trigger },
        'SystemMessage has no projectKey — falling back to legacy path'
      );
      return { routed: false, reason: 'no-project-key' };
    }

    if (!this.projectChatIdResolver) {
      this.log.warn(
        { projectKey: message.projectKey, messageId: message.id },
        'SystemMessage has projectKey but no resolver configured — falling back'
      );
      return { routed: false, reason: 'unknown-project' };
    }

    const chatId = this.projectChatIdResolver.resolve(message.projectKey);
    if (!chatId) {
      this.log.warn(
        { projectKey: message.projectKey, messageId: message.id },
        'Unknown projectKey — cannot resolve chatId'
      );
      return { routed: false, reason: 'unknown-project' };
    }

    this.log.debug(
      { chatId, projectKey: message.projectKey, messageId: message.id },
      'Routing SystemMessage via project-resolved chatId'
    );

    const agent = this.agentPool.getOrCreateChatAgent(chatId);
    // SystemMessage uses runOnce for blocking execution (suitable for scheduled tasks)
    void agent.runOnce(chatId, message.payload, message.id);

    return {
      routed: true,
      chatId,
      method: 'project-resolved',
      agent,
    };
  }
}
