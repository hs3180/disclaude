/**
 * Unified Message types for ChatAgent input routing (RFC #3329).
 *
 * Introduces a unified input type hierarchy for ChatAgent that encompasses
 * both user messages and system-driven tasks. Through three concrete types —
 * UserMessage, SystemMessage, AgentMessage — ChatAgent receives input from
 * users, infrastructure triggers, and other agents, all routed through
 * the MessageRouter.
 *
 * Design Principles:
 * - Only UserMessage carries chatId (extracted from channel event)
 * - SystemMessage and AgentMessage resolve chatId from project config
 * - No new Agent type needed — ChatAgent handles everything
 * - chatId is bound at ChatAgent initialization time
 *
 * @see RFC #3329 (Message — Unified Agent Input Abstraction)
 * @see Issue #3331 (Phase 1: Message types & routing layer)
 */

import type { ModelTier } from '../config/types.js';

// ============================================================================
// Source & Trigger Types
// ============================================================================

/**
 * Discriminator for the three message sources.
 */
export type MessageSource = 'user' | 'system' | 'agent';

/**
 * System trigger sub-types.
 *
 * Distinguishes between different infrastructure-driven message origins
 * within a single SystemMessage type — no need for separate classes.
 */
export type SystemTrigger = 'scheduled' | 'signal' | 'command';

/**
 * Priority levels for message routing.
 *
 * Higher-priority messages are processed before lower-priority ones
 * when an agent has queued messages.
 */
export type MessagePriority = 'low' | 'normal' | 'high';

// ============================================================================
// Base Message Type
// ============================================================================

/**
 * Message — Unified base input type for ChatAgent.
 *
 * All messages share a payload (instruction text), differentiated by
 * `source` and source-specific fields.
 *
 * This is the base type. Use the concrete subtypes (UserMessage,
 * SystemMessage, AgentMessage) for actual message creation.
 */
export interface Message {
  /** Unique message identifier */
  id: string;
  /** Message source discriminator */
  source: MessageSource;
  /** Instruction / text content to be processed by ChatAgent */
  payload: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ============================================================================
// UserMessage — Human via Chat
// ============================================================================

/**
 * UserMessage — Message from a human user via chat channel.
 *
 * Carries its own chatId (extracted from the channel event, e.g., Feishu
 * WebSocket event). The MessageRouter uses this chatId directly to find
 * or create the ChatAgent.
 *
 * chatId handling: Extracted from channel event → AgentPool.getOrCreateChatAgent(chatId).
 */
export interface UserMessage extends Message {
  source: 'user';
  /** Chat ID extracted from channel event */
  chatId: string;
  /** Sender's open_id (for @ mentions, optional) */
  senderOpenId?: string;
  /** Platform-specific message ID */
  messageId: string;
  /** File attachments */
  attachments?: Array<{ name: string; path: string; type: string }>;
  /** Chat history context for passive mode */
  chatHistoryContext?: string;
}

// ============================================================================
// SystemMessage — Infrastructure Triggers
// ============================================================================

/**
 * SystemMessage — Message from infrastructure (scheduler, webhook, IPC, admin command).
 *
 * Does NOT carry chatId. When `projectKey` is set, chatId is resolved from
 * project configuration (bound at Agent init time). When absent, falls back
 * to legacy task-based chatId (backward compatible).
 */
export interface SystemMessage extends Message {
  source: 'system';
  /** Trigger sub-type */
  trigger: SystemTrigger;
  /** Target project key — if set, chatId resolved from project config */
  projectKey?: string;
  /** Scheduled task name (for trigger: 'scheduled') */
  taskName?: string;
  /** Model tier override */
  modelTier?: ModelTier;
  /** Trigger-specific data payload */
  data?: Record<string, unknown>;
}

// ============================================================================
// A2AMessage — Agent-to-Agent Delegation
// ============================================================================

/**
 * A2AMessage — Message from one ChatAgent to another (Agent-to-Agent delegation).
 *
 * Enables a ChatAgent to delegate a task to a project-bound agent. The source
 * agent enqueues the message; the target agent processes it asynchronously.
 *
 * Note: Named `A2AMessage` to avoid conflict with the existing `AgentMessage`
 * type in `types/agent.ts` (which represents agent *output* messages).
 * This type represents agent *input* routing messages.
 *
 * chatId handling: Resolved from project configuration via ProjectLookup.
 */
export interface A2AMessage extends Message {
  source: 'agent';
  /** Source agent's chatId (for traceability) */
  fromChatId: string;
  /** Target project key */
  projectKey?: string;
  /** Message priority */
  priority: MessagePriority;
}

// ============================================================================
// Union Types
// ============================================================================

/**
 * Any concrete message type.
 */
export type AnyMessage = UserMessage | SystemMessage | A2AMessage;

/**
 * Non-user messages (system-driven and agent-to-agent).
 *
 * These resolve chatId from project configuration rather than carrying it
 * in the message itself.
 */
export type NonUserMessage = SystemMessage | A2AMessage;

// ============================================================================
// Project Lookup Interface
// ============================================================================

/**
 * Configuration for a project-bound agent.
 *
 * Resolved by MessageRouter from project configuration to determine
 * the chatId and working directory for routing.
 */
export interface ProjectLookupResult {
  /** Bound chatId — agent replies go here */
  chatId: string;
  /** Project working directory — agent operates here */
  workingDir: string;
  /** Model tier for the project (optional) */
  modelTier?: ModelTier;
}

/**
 * Interface for resolving projectKey to project configuration.
 *
 * Implemented by ProjectManager or a simple config-based lookup.
 * This decouples MessageRouter from ProjectManager, allowing
 * Phase 1 to use a simple lookup while Phase 2 extends ProjectManager.
 */
export interface ProjectLookup {
  /**
   * Look up project configuration by project key.
   *
   * @param projectKey - Project identifier (e.g., 'hs3180/disclaude')
   * @returns Project configuration, or undefined if not found
   */
  lookup(projectKey: string): ProjectLookupResult | undefined;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for UserMessage.
 */
export function isUserMessage(message: Message): message is UserMessage {
  return message.source === 'user';
}

/**
 * Type guard for SystemMessage.
 */
export function isSystemMessage(message: Message): message is SystemMessage {
  return message.source === 'system';
}

/**
 * Type guard for A2AMessage.
 */
export function isA2AMessage(message: Message): message is A2AMessage {
  return message.source === 'agent';
}

/**
 * Type guard for NonUserMessage (SystemMessage | A2AMessage).
 */
export function isNonUserMessage(message: Message): message is NonUserMessage {
  return message.source === 'system' || message.source === 'agent';
}
