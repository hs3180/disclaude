/**
 * Universal Message Format (UMF) - Platform-agnostic message types.
 *
 * This module defines a platform-independent message format that can be
 * converted to platform-specific formats (Feishu Card, CLI Text, REST JSON).
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 *
 * @example
 * ```typescript
 * // Text message
 * const textMsg: UniversalMessage = {
 *   chatId: 'oc_xxx',
 *   content: { type: 'text', text: 'Hello!' }
 * };
 *
 * // Card message
 * const cardMsg: UniversalMessage = {
 *   chatId: 'oc_xxx',
 *   content: {
 *     type: 'card',
 *     title: 'Task Complete',
 *     sections: [
 *       { type: 'text', content: 'All files processed.' }
 *     ],
 *     actions: [
 *       { type: 'button', label: 'View Results', value: 'view_results' }
 *     ]
 *   }
 * };
 * ```
 */

// ============================================================================
// Content Types
// ============================================================================

/**
 * Mention target for @mention in messages.
 * Issue #1742: Support inter-bot @mention conversations.
 */
export interface MessageMention {
  /** User/bot ID to mention (platform-specific, e.g. open_id for Feishu) */
  id: string;
  /** Display name for the mention (optional) */
  name?: string;
}

/**
 * Text content - Plain text message.
 */
export interface TextContent {
  type: 'text';
  /** Plain text content */
  text: string;
  /**
   * Optional mention targets for @mention rendering.
   * When provided, the adapter may upgrade to rich text format
   * to support @mention rendering (e.g. Feishu post messages).
   * Issue #1742: Support inter-bot @mention conversations.
   */
  mentions?: MessageMention[];
}

/**
 * Markdown content - Markdown formatted text.
 */
export interface MarkdownContent {
  type: 'markdown';
  /** Markdown formatted content */
  text: string;
}

/**
 * Card section types - Platform-independent section definitions.
 */
export type CardSectionType = 'text' | 'markdown' | 'image' | 'divider' | 'fields';

/**
 * Card section - A section within a card.
 */
export interface CardSection {
  /** Section type */
  type: CardSectionType;
  /** Text content (for text/markdown types) */
  content?: string;
  /** Image URL (for image type) */
  imageUrl?: string;
  /** Field list (for fields type) - label/value pairs */
  fields?: Array<{ label: string; value: string }>;
}

/**
 * Card action types - Platform-independent action definitions.
 */
export type CardActionType = 'button' | 'select' | 'link';

/**
 * Card action - An interactive action within a card.
 */
export interface CardAction {
  /** Action type */
  type: CardActionType;
  /** Button/option label */
  label: string;
  /** Action value (returned when clicked) */
  value: string;
  /** URL for link type */
  url?: string;
  /** Options for select type */
  options?: Array<{ label: string; value: string }>;
  /** Button style (primary, secondary, danger) */
  style?: 'primary' | 'secondary' | 'danger';
}

/**
 * Card content - Platform-independent interactive card.
 */
export interface CardContent {
  type: 'card';
  /** Card title */
  title: string;
  /** Optional subtitle */
  subtitle?: string;
  /** Card sections */
  sections: CardSection[];
  /** Optional interactive actions */
  actions?: CardAction[];
  /** Optional header color theme */
  theme?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';
}

/**
 * File content - File attachment.
 */
export interface FileContent {
  type: 'file';
  /** File path (local or URL) */
  path: string;
  /** File name */
  name?: string;
  /** MIME type */
  mimeType?: string;
}

/**
 * Done content - Task completion signal.
 */
export interface DoneContent {
  type: 'done';
  /** Whether task succeeded */
  success: boolean;
  /** Result message */
  message?: string;
  /** Error details if failed */
  error?: string;
}

/**
 * Union type for all content types.
 */
export type MessageContent =
  | TextContent
  | MarkdownContent
  | CardContent
  | FileContent
  | DoneContent;

// ============================================================================
// Universal Message
// ============================================================================

/**
 * Universal Message - Platform-agnostic message format.
 *
 * This is the core message type that all channels should accept.
 * Channel Adapters convert this to platform-specific formats.
 */
export interface UniversalMessage {
  /** Target chat/conversation ID */
  chatId: string;
  /** Thread ID for replies (optional) */
  threadId?: string;
  /** Message content */
  content: MessageContent;
  /** Optional metadata */
  metadata?: UniversalMessageMetadata;
}

/**
 * Metadata for universal messages.
 */
export interface UniversalMessageMetadata {
  /** Message ID (for updates/references) */
  messageId?: string;
  /** Original message type from agent */
  originalType?: string;
  /** Task ID if part of a task */
  taskId?: string;
  /** Timestamp (ms since epoch) */
  timestamp?: number;
  /** Priority level */
  priority?: 'low' | 'normal' | 'high';
}

// ============================================================================
// Send Result
// ============================================================================

/**
 * Result of sending a message.
 */
export interface SendResult {
  /** Whether the send was successful */
  success: boolean;
  /** Message ID of the sent message (if available) */
  messageId?: string;
  /** Error message if failed */
  error?: string;
  /** Platform-specific data */
  platformData?: Record<string, unknown>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if content is TextContent.
 */
export function isTextContent(content: MessageContent): content is TextContent {
  return content.type === 'text';
}

/**
 * Check if content is MarkdownContent.
 */
export function isMarkdownContent(content: MessageContent): content is MarkdownContent {
  return content.type === 'markdown';
}

/**
 * Check if content is CardContent.
 */
export function isCardContent(content: MessageContent): content is CardContent {
  return content.type === 'card';
}

/**
 * Check if content is FileContent.
 */
export function isFileContent(content: MessageContent): content is FileContent {
  return content.type === 'file';
}

/**
 * Check if content is DoneContent.
 */
export function isDoneContent(content: MessageContent): content is DoneContent {
  return content.type === 'done';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a simple text message.
 */
export function createTextMessage(chatId: string, text: string, threadId?: string): UniversalMessage {
  return {
    chatId,
    threadId,
    content: { type: 'text', text },
  };
}

/**
 * Create a simple markdown message.
 */
export function createMarkdownMessage(chatId: string, text: string, threadId?: string): UniversalMessage {
  return {
    chatId,
    threadId,
    content: { type: 'markdown', text },
  };
}

/**
 * Create a card message.
 */
export function createCardMessage(
  chatId: string,
  title: string,
  sections: CardSection[],
  options?: {
    subtitle?: string;
    actions?: CardAction[];
    theme?: CardContent['theme'];
    threadId?: string;
  }
): UniversalMessage {
  return {
    chatId,
    threadId: options?.threadId,
    content: {
      type: 'card',
      title,
      subtitle: options?.subtitle,
      sections,
      actions: options?.actions,
      theme: options?.theme,
    },
  };
}

/**
 * Create a done signal message.
 */
export function createDoneMessage(
  chatId: string,
  success: boolean,
  message?: string,
  error?: string
): UniversalMessage {
  return {
    chatId,
    content: {
      type: 'done',
      success,
      message,
      error,
    },
  };
}
