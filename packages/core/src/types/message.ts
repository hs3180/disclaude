/**
 * Input Message types for unified agent input abstraction.
 *
 * These types represent messages entering the system from different sources
 * (user chat, system infrastructure) and are routed to ChatAgent via
 * MessageRouter.
 *
 * Issue #3580: Message types (UserMessage + SystemMessage) and MessageRouter
 * Part of RFC #3329: Message — Unified Agent Input Abstraction (Phase 1)
 *
 * Design: Fully decoupled from Project system. All messages carry chatId;
 * MessageRouter routes by chatId only, unaware of projectKey.
 */

import type { FileRef } from './file.js';

// ============================================================================
// Base Message Type
// ============================================================================

/**
 * Base Message — unified input type for ChatAgent.
 *
 * All messages share a payload (instruction text) and are differentiated
 * by source and source-specific fields.
 */
export interface Message {
  /** Unique message identifier */
  id: string;
  /** Message source discriminator */
  source: 'user' | 'system';
  /** Instruction / text content */
  payload: string;
  /** Target chat/conversation ID for routing */
  chatId: string;
  /** ISO 8601 timestamp */
  createdAt: string;
}

// ============================================================================
// UserMessage — Human via Chat
// ============================================================================

/**
 * UserMessage — message from a human user through a chat channel.
 *
 * Carries its own chatId (extracted from the channel event).
 * Routed directly to AgentPool by chatId.
 */
export interface UserMessage extends Message {
  source: 'user';
  /** Sender's open_id for @ mentions */
  senderOpenId?: string;
  /** Platform message ID (e.g., Feishu message_id) */
  messageId: string;
  /** File attachments */
  attachments?: FileRef[];
  /** Chat history context for passive mode (Issue #517) */
  chatHistoryContext?: string;
  /** Chat type (e.g., 'p2p', 'group', 'topic') for context-aware behavior (Issue #3641) */
  chatType?: string;
  /** Thread context for topic groups (Issue #3641 sub-problem 1) */
  threadContext?: string;
  /** Chat type for topic group detection (Issue #3641) — e.g. 'p2p', 'group', 'topic' */
  chatType?: string;
}

// ============================================================================
// SystemMessage — Infrastructure Triggers
// ============================================================================

/**
 * System trigger type — distinguishes the infrastructure source.
 */
export type SystemTrigger = 'scheduled' | 'signal' | 'command';

/**
 * SystemMessage — message from system infrastructure (scheduler, webhook, IPC).
 *
 * Carries chatId for routing. The MessageRouter routes by chatId
 * without knowledge of the Project system.
 */
export interface SystemMessage extends Message {
  source: 'system';
  /** Distinguishes the trigger source */
  trigger: SystemTrigger;
  /** Task name for scheduled tasks */
  taskName?: string;
  /** Model tier override */
  modelTier?: string;
  /** Trigger-specific payload data */
  data?: Record<string, unknown>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a Message is a UserMessage.
 */
export function isUserMessage(message: Message): message is UserMessage {
  return message.source === 'user';
}

/**
 * Check if a Message is a SystemMessage.
 */
export function isSystemMessage(message: Message): message is SystemMessage {
  return message.source === 'system';
}
