/**
 * Message routing types for implementing message level-based routing.
 *
 * This module defines the types for the message routing system that:
 * - Routes execution progress to admin chats
 * - Routes only key interactions to user chats
 *
 * @see Issue #266
 */

import type { AgentMessageType } from '../types/agent.js';

/**
 * Message level enum for routing decisions.
 *
 * - DEBUG: Debug information → Admin only
 * - PROGRESS: Execution progress → Admin only
 * - INFO: General information → Admin only
 * - NOTICE: Notification → User + Admin
 * - IMPORTANT: Important information → User + Admin (strong alert)
 * - ERROR: Error information → User + Admin
 * - RESULT: Final result → User + Admin
 */
export enum MessageLevel {
  DEBUG = 'debug',
  PROGRESS = 'progress',
  INFO = 'info',
  NOTICE = 'notice',
  IMPORTANT = 'important',
  ERROR = 'error',
  RESULT = 'result',
}

/**
 * Default message levels visible to users.
 */
export const DEFAULT_USER_LEVELS: MessageLevel[] = [
  MessageLevel.NOTICE,
  MessageLevel.IMPORTANT,
  MessageLevel.ERROR,
  MessageLevel.RESULT,
];

/**
 * All message levels (admin receives all).
 */
export const ALL_LEVELS: MessageLevel[] = [
  MessageLevel.DEBUG,
  MessageLevel.PROGRESS,
  MessageLevel.INFO,
  MessageLevel.NOTICE,
  MessageLevel.IMPORTANT,
  MessageLevel.ERROR,
  MessageLevel.RESULT,
];

/**
 * Message routed through the routing system.
 */
export interface RoutedMessage {
  /** Message content */
  content: string;
  /** Message level for routing decision */
  level: MessageLevel;
  /** Optional metadata */
  metadata?: RoutedMessageMetadata;
}

/**
 * Metadata for routed messages.
 */
export interface RoutedMessageMetadata {
  /** Tool name if this is a tool message */
  toolName?: string;
  /** Task ID if this is part of a task */
  taskId?: string;
  /** Original message type from agent */
  originalType?: AgentMessageType;
}

/**
 * Configuration for message routing.
 */
export interface MessageRouteConfig {
  /** Admin chat ID (receives all messages) */
  adminChatId?: string;
  /** User chat ID (receives filtered messages) */
  userChatId: string;
  /** Message levels visible to users */
  userMessageLevels?: MessageLevel[];
  /** Whether to show task lifecycle messages to users */
  showTaskLifecycle?: {
    showStart?: boolean;
    showProgress?: boolean;
    showComplete?: boolean;
  };
  /** Error handling options */
  errors?: {
    /** Whether to show stack traces to users */
    showStack?: boolean;
    /** Who can see detailed errors: 'admin' | 'all' */
    showDetails?: 'admin' | 'all';
  };
}

/**
 * Message router interface.
 */
export interface IMessageRouter {
  /**
   * Route a message to appropriate chat(s).
   * @param message - The message to route
   */
  route(message: RoutedMessage): Promise<void>;

  /**
   * Get the target chat IDs for a message level.
   * @param level - The message level
   * @returns Array of chat IDs to send to
   */
  getTargets(level: MessageLevel): string[];

  /**
   * Get the user chat ID.
   * @returns The user chat ID
   */
  getUserChatId(): string;
}

/**
 * Message sender interface for the router.
 */
export interface IMessageSender {
  /**
   * Send a text message to a chat.
   * @param chatId - Target chat ID
   * @param content - Message content
   */
  sendText(chatId: string, content: string): Promise<void>;

  /**
   * Send a card message to a chat.
   * @param chatId - Target chat ID
   * @param card - Card content
   * @param description - Card description
   */
  sendCard?(chatId: string, card: Record<string, unknown>, description?: string): Promise<void>;
}

/**
 * Map AgentMessageType to MessageLevel.
 */
export function mapAgentMessageTypeToLevel(
  messageType: AgentMessageType,
  content?: string
): MessageLevel {
  switch (messageType) {
    case 'tool_progress':
      return MessageLevel.PROGRESS;

    case 'tool_use':
    case 'tool_result':
      return MessageLevel.DEBUG;

    case 'error':
      return MessageLevel.ERROR;

    case 'result':
      // Check if it's a completion message (internal, not user-facing)
      if (content?.startsWith('✅ Complete')) {
        return MessageLevel.DEBUG;
      }
      return MessageLevel.RESULT;

    case 'notification':
      return MessageLevel.NOTICE;

    case 'task_completion':
      return MessageLevel.RESULT;

    case 'max_iterations_warning':
      return MessageLevel.IMPORTANT;

    case 'status':
      return MessageLevel.INFO;

    case 'text':
    default:
      return MessageLevel.INFO;
  }
}
