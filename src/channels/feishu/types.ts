/**
 * Feishu Channel Type Definitions.
 *
 * Shared types for Feishu channel modules.
 */

/**
 * Feishu channel configuration.
 */
export interface FeishuChannelConfig {
  /** Channel ID */
  id?: string;
  /** Feishu App ID */
  appId?: string;
  /** Feishu App Secret */
  appSecret?: string;
}

/**
 * Result of a message filter check.
 */
export interface FilterResult {
  /** Whether the message should be filtered (skipped) */
  filtered: boolean;
  /** Reason for filtering, if any */
  reason?: 'duplicate' | 'bot' | 'old' | 'unsupported' | 'empty' | 'passive_mode';
  /** Additional metadata about the filter decision */
  metadata?: Record<string, unknown>;
}

/**
 * Context for processing a Feishu message.
 */
export interface MessageContext {
  /** Message ID */
  messageId: string;
  /** Chat ID */
  chatId: string;
  /** Chat type (p2p, group, topic) */
  chatType?: string;
  /** User's open_id */
  userId?: string;
  /** Message content */
  content: string;
  /** Message type (text, post, image, file, media) */
  messageType: string;
  /** Message creation timestamp */
  timestamp?: number;
  /** Thread ID for replies */
  threadId: string;
  /** Whether bot was mentioned */
  botMentioned: boolean;
  /** Text content with mentions stripped */
  textWithoutMentions: string;
  /** Parsed command (if any) */
  command?: {
    name: string;
    args: string[];
  };
}
