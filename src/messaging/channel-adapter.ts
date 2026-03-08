/**
 * Channel Adapter Interface - Platform-specific message conversion.
 *
 * This module defines the interface that all channel adapters must implement
 * to convert Universal Message Format (UMF) to platform-specific formats.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 *
 * @example
 * ```typescript
 * class FeishuAdapter implements IChannelAdapter {
 *   readonly name = 'feishu';
 *   readonly capabilities = {
 *     supportsCard: true,
 *     supportsThread: true,
 *     supportsFile: true,
 *     supportsMarkdown: true,
 *     maxMessageLength: 30000,
 *   };
 *
 *   canHandle(chatId: string): boolean {
 *     return chatId.startsWith('oc_') || chatId.startsWith('ou_');
 *   }
 *
 *   convert(message: UniversalMessage): FeishuCard {
 *     // Convert UMF to Feishu format
 *   }
 *
 *   async send(message: UniversalMessage): Promise<SendResult> {
 *     // Send via Feishu API
 *   }
 * }
 * ```
 */

import type { UniversalMessage, SendResult, CardContent } from './universal-message.js';

// ============================================================================
// Channel Capabilities
// ============================================================================

/**
 * Channel capabilities - Describes what a channel supports.
 *
 * Used for capability negotiation between the agent and the channel.
 * The agent can adjust its output based on channel capabilities.
 */
export interface ChannelCapabilities {
  /** Whether the channel supports interactive cards */
  supportsCard: boolean;
  /** Whether the channel supports threaded replies */
  supportsThread: boolean;
  /** Whether the channel supports file attachments */
  supportsFile: boolean;
  /** Whether the channel supports markdown formatting */
  supportsMarkdown: boolean;
  /** Maximum message length in characters */
  maxMessageLength: number;
  /** Supported content types */
  supportedContentTypes: string[];
  /** Whether the channel supports message updates */
  supportsUpdate: boolean;
  /** Whether the channel supports message deletion */
  supportsDelete: boolean;
  /** Whether the channel supports @mentions */
  supportsMention: boolean;
  /** Whether the channel supports reactions/emoji */
  supportsReactions: boolean;
  /**
   * Supported MCP tools for this channel.
   * Issue #590: MCP Tools 与 Channel 解耦
   */
  supportedMcpTools?: string[];
}

/**
 * Default capabilities for a basic channel.
 */
export const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  supportsCard: false,
  supportsThread: false,
  supportsFile: false,
  supportsMarkdown: false,
  maxMessageLength: 4096,
  supportedContentTypes: ['text'],
  supportsUpdate: false,
  supportsDelete: false,
  supportsMention: false,
  supportsReactions: false,
  supportedMcpTools: [],
};

/**
 * Feishu channel capabilities.
 */
export const FEISHU_CAPABILITIES: ChannelCapabilities = {
  supportsCard: true,
  supportsThread: true,
  supportsFile: true,
  supportsMarkdown: true,
  maxMessageLength: 30000,
  supportedContentTypes: ['text', 'markdown', 'card', 'file'],
  supportsUpdate: true,
  supportsDelete: true,
  supportsMention: true,
  supportsReactions: true,
  supportedMcpTools: ['send_message', 'send_file'],
};

/**
 * CLI channel capabilities.
 */
export const CLI_CAPABILITIES: ChannelCapabilities = {
  supportsCard: false,
  supportsThread: false,
  supportsFile: false,
  supportsMarkdown: true,
  maxMessageLength: Infinity,
  supportedContentTypes: ['text', 'markdown'],
  supportsUpdate: false,
  supportsDelete: false,
  supportsMention: false,
  supportsReactions: false,
  supportedMcpTools: [], // CLI mode doesn't need MCP tools
};

/**
 * REST channel capabilities.
 */
export const REST_CAPABILITIES: ChannelCapabilities = {
  supportsCard: true,
  supportsThread: false,
  supportsFile: false,
  supportsMarkdown: true,
  maxMessageLength: Infinity,
  supportedContentTypes: ['text', 'markdown', 'card', 'file', 'done'],
  supportsUpdate: false,
  supportsDelete: false,
  supportsMention: false,
  supportsReactions: false,
  supportedMcpTools: ['send_message'], // REST channel only supports basic messaging
};

// ============================================================================
// Channel Adapter Interface
// ============================================================================

/**
 * Channel Adapter interface.
 *
 * All channel adapters must implement this interface to:
 * 1. Detect if they can handle a chatId
 * 2. Convert UMF to platform format
 * 3. Send messages via platform API
 */
export interface IChannelAdapter {
  /** Adapter name (e.g., 'feishu', 'cli', 'rest') */
  readonly name: string;

  /** Channel capabilities */
  readonly capabilities: ChannelCapabilities;

  /**
   * Check if this adapter can handle the given chatId.
   * @param chatId - Chat ID to check
   * @returns true if this adapter can handle the chatId
   */
  canHandle(chatId: string): boolean;

  /**
   * Convert Universal Message to platform-specific format.
   * @param message - Universal message to convert
   * @returns Platform-specific message format
   */
  convert(message: UniversalMessage): unknown;

  /**
   * Send a message through this channel.
   * @param message - Universal message to send
   * @returns Send result with success status and message ID
   */
  send(message: UniversalMessage): Promise<SendResult>;

  /**
   * Update an existing message (optional).
   * @param messageId - Message ID to update
   * @param message - New message content
   * @returns Send result
   */
  update?(messageId: string, message: UniversalMessage): Promise<SendResult>;

  /**
   * Delete a message (optional).
   * @param messageId - Message ID to delete
   * @returns Whether deletion was successful
   */
  delete?(messageId: string): Promise<boolean>;
}

// ============================================================================
// Format Conversion Utilities
// ============================================================================

/**
 * Convert UMF Card to a simple text representation.
 * Used for fallback when a channel doesn't support cards.
 *
 * @param card - UMF Card content
 * @returns Plain text representation
 */
export function cardToText(card: CardContent): string {
  const parts: string[] = [];

  // Title
  parts.push(`**${card.title}**`);
  if (card.subtitle) {
    parts.push(card.subtitle);
  }
  parts.push('');

  // Sections
  for (const section of card.sections) {
    switch (section.type) {
      case 'text':
      case 'markdown':
        if (section.content) {
          parts.push(section.content);
        }
        break;
      case 'divider':
        parts.push('---');
        break;
      case 'fields':
        if (section.fields) {
          for (const field of section.fields) {
            parts.push(`**${field.label}**: ${field.value}`);
          }
        }
        break;
      case 'image':
        if (section.imageUrl) {
          parts.push(`[Image: ${section.imageUrl}]`);
        }
        break;
    }
    parts.push('');
  }

  // Actions
  if (card.actions && card.actions.length > 0) {
    parts.push('**Actions:**');
    for (const action of card.actions) {
      parts.push(`[${action.label}]`);
    }
  }

  return parts.join('\n').trim();
}

/**
 * Truncate text to fit within max length.
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length
 * @param suffix - Suffix to add when truncated (default: '...')
 * @returns Truncated text
 */
export function truncateText(text: string, maxLength: number, suffix = '...'): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - suffix.length) + suffix;
}

// ============================================================================
// Capability Negotiation
// ============================================================================

/**
 * Check if a content type is supported by a channel.
 *
 * @param capabilities - Channel capabilities
 * @param contentType - Content type to check
 * @returns true if supported
 */
export function isContentTypeSupported(
  capabilities: ChannelCapabilities,
  contentType: string
): boolean {
  return capabilities.supportedContentTypes.includes(contentType);
}

/**
 * Get fallback content type for unsupported types.
 *
 * @param capabilities - Channel capabilities
 * @param contentType - Original content type
 * @returns Fallback content type or null if no fallback
 */
export function getFallbackContentType(
  capabilities: ChannelCapabilities,
  contentType: string
): string | null {
  if (isContentTypeSupported(capabilities, contentType)) {
    return contentType;
  }

  // Fallback chain
  const fallbacks: Record<string, string[]> = {
    card: ['markdown', 'text'],
    markdown: ['text'],
    file: ['text'],
    done: ['text'],
  };

  const fallbackChain = fallbacks[contentType] || ['text'];
  for (const fallback of fallbackChain) {
    if (isContentTypeSupported(capabilities, fallback)) {
      return fallback;
    }
  }

  return null;
}

/**
 * Negotiate the best content type for a channel.
 *
 * @param capabilities - Channel capabilities
 * @param preferredTypes - Preferred content types in order
 * @returns Best supported content type
 */
export function negotiateContentType(
  capabilities: ChannelCapabilities,
  preferredTypes: string[]
): string | null {
  for (const type of preferredTypes) {
    if (isContentTypeSupported(capabilities, type)) {
      return type;
    }
  }
  return getFallbackContentType(capabilities, preferredTypes[0] || 'text');
}
