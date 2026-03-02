/**
 * Universal Message Format (UMF) - Platform-agnostic message types.
 *
 * This module defines a unified message format that can be converted to
 * any platform-specific format (Feishu, Slack, Discord, CLI, etc.).
 *
 * Architecture:
 * ```
 *   Exec Node (Agent)
 *         │
 *         ▼  Universal Message Format (UMF)
 *   Message Service
 *         │
 *    ┌────┼────┐
 *    ▼    ▼    ▼
 * Feishu CLI  REST
 * Adapter Adapter Adapter
 * ```
 *
 * @see Issue #480
 */

/**
 * Platform-agnostic text content.
 */
export interface TextContent {
  type: 'text';
  /** Text content (may contain markdown) */
  text: string;
}

/**
 * Platform-agnostic markdown content.
 */
export interface MarkdownContent {
  type: 'markdown';
  /** Markdown content */
  text: string;
}

/**
 * Platform-agnostic card action (button, menu, etc.)
 */
export interface CardAction {
  /** Action type */
  type: 'button' | 'select' | 'link';
  /** Action label/tooltip */
  label: string;
  /** Action value (returned when user interacts) */
  value: string;
  /** Visual style (for buttons) */
  style?: 'primary' | 'default' | 'danger';
  /** URL for link actions */
  url?: string;
  /** Options for select actions */
  options?: Array<{ label: string; value: string }>;
}

/**
 * Platform-agnostic card section.
 */
export interface CardSection {
  /** Section type */
  type: 'text' | 'markdown' | 'divider' | 'actions' | 'columns' | 'image';
  /** Text content (for text/markdown types) */
  content?: string;
  /** Actions (for actions type) */
  actions?: CardAction[];
  /** Columns (for columns type) */
  columns?: CardColumn[];
  /** Image URL (for image type) */
  imageUrl?: string;
  /** Image alt text */
  imageAlt?: string;
}

/**
 * Platform-agnostic card column.
 */
export interface CardColumn {
  /** Column width weight (for proportional sizing) */
  weight?: number;
  /** Column content sections */
  sections: CardSection[];
}

/**
 * Platform-agnostic card content.
 */
export interface CardContent {
  type: 'card';
  /** Card title */
  title: string;
  /** Card subtitle */
  subtitle?: string;
  /** Card sections */
  sections: CardSection[];
  /** Card-level actions */
  actions?: CardAction[];
  /** Card color/theme */
  theme?: 'default' | 'blue' | 'green' | 'red' | 'orange' | 'purple';
}

/**
 * Platform-agnostic file content.
 */
export interface FileContent {
  type: 'file';
  /** File name */
  fileName: string;
  /** File path (local or URL) */
  filePath: string;
  /** MIME type */
  mimeType?: string;
  /** File size in bytes */
  size?: number;
}

/**
 * Task completion signal (for REST sync mode).
 */
export interface DoneContent {
  type: 'done';
  /** Task success status */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Union type for all message content types.
 */
export type MessageContent =
  | TextContent
  | MarkdownContent
  | CardContent
  | FileContent
  | DoneContent;

/**
 * Universal message format - platform-agnostic message structure.
 */
export interface UniversalMessage {
  /** Target chat/conversation ID */
  chatId: string;
  /** Thread/reply message ID (for threaded responses) */
  threadId?: string;
  /** Message content */
  content: MessageContent;
  /** Message metadata */
  metadata?: UniversalMessageMetadata;
}

/**
 * Universal message metadata.
 */
export interface UniversalMessageMetadata {
  /** Original message ID (for updates) */
  messageId?: string;
  /** Message level for routing */
  level?: 'debug' | 'progress' | 'info' | 'notice' | 'important' | 'error' | 'result';
  /** Timestamp */
  timestamp?: number;
  /** Additional platform-specific data */
  extra?: Record<string, unknown>;
}

/**
 * Channel capabilities declaration.
 * Used for capability negotiation between MessageService and Adapters.
 */
export interface ChannelCapabilities {
  /** Supports interactive card messages */
  supportsCard: boolean;
  /** Supports thread replies */
  supportsThread: boolean;
  /** Supports file attachments */
  supportsFile: boolean;
  /** Supports markdown formatting */
  supportsMarkdown: boolean;
  /** Supports interactive elements (buttons, menus) */
  supportsInteractive: boolean;
  /** Maximum message length (0 = unlimited) */
  maxMessageLength: number;
  /** Supported content types */
  supportedContentTypes: MessageContent['type'][];
}

/**
 * Default capabilities for basic channels.
 */
export const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  supportsCard: false,
  supportsThread: false,
  supportsFile: false,
  supportsMarkdown: true,
  supportsInteractive: false,
  maxMessageLength: 0,
  supportedContentTypes: ['text', 'markdown'],
};

/**
 * Feishu channel capabilities.
 */
export const FEISHU_CAPABILITIES: ChannelCapabilities = {
  supportsCard: true,
  supportsThread: true,
  supportsFile: true,
  supportsMarkdown: true,
  supportsInteractive: true,
  maxMessageLength: 30000,
  supportedContentTypes: ['text', 'markdown', 'card', 'file'],
};

/**
 * CLI channel capabilities.
 */
export const CLI_CAPABILITIES: ChannelCapabilities = {
  supportsCard: false,
  supportsThread: false,
  supportsFile: true,
  supportsMarkdown: true,
  supportsInteractive: false,
  maxMessageLength: 0,
  supportedContentTypes: ['text', 'markdown', 'file', 'done'],
};

/**
 * REST channel capabilities.
 */
export const REST_CAPABILITIES: ChannelCapabilities = {
  supportsCard: true,
  supportsThread: false,
  supportsFile: false,
  supportsMarkdown: true,
  supportsInteractive: false,
  maxMessageLength: 0,
  supportedContentTypes: ['text', 'markdown', 'card', 'done'],
};

/**
 * Type guard: Check if content is TextContent.
 */
export function isTextContent(content: MessageContent): content is TextContent {
  return content.type === 'text';
}

/**
 * Type guard: Check if content is MarkdownContent.
 */
export function isMarkdownContent(content: MessageContent): content is MarkdownContent {
  return content.type === 'markdown';
}

/**
 * Type guard: Check if content is CardContent.
 */
export function isCardContent(content: MessageContent): content is CardContent {
  return content.type === 'card';
}

/**
 * Type guard: Check if content is FileContent.
 */
export function isFileContent(content: MessageContent): content is FileContent {
  return content.type === 'file';
}

/**
 * Type guard: Check if content is DoneContent.
 */
export function isDoneContent(content: MessageContent): content is DoneContent {
  return content.type === 'done';
}

/**
 * Helper: Create a text message.
 */
export function createTextMessage(
  chatId: string,
  text: string,
  threadId?: string
): UniversalMessage {
  return {
    chatId,
    threadId,
    content: { type: 'text', text },
  };
}

/**
 * Helper: Create a markdown message.
 */
export function createMarkdownMessage(
  chatId: string,
  text: string,
  threadId?: string
): UniversalMessage {
  return {
    chatId,
    threadId,
    content: { type: 'markdown', text },
  };
}

/**
 * Helper: Create a card message.
 */
export function createCardMessage(
  chatId: string,
  card: Omit<CardContent, 'type'>,
  threadId?: string
): UniversalMessage {
  return {
    chatId,
    threadId,
    content: { type: 'card', ...card },
  };
}
