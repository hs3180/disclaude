/**
 * Types for the MessageBuilder module.
 *
 * Issue #1492: Extracted from worker-node to core package.
 * MessageBuilder is now framework-agnostic with channel-specific
 * extensions provided via MessageBuilderOptions callbacks.
 *
 * @module agents/message-builder
 */

import type { FileRef } from '../../types/file.js';
import type { ChannelCapabilities } from '../../types/channel.js';

/**
 * Message data for building enhanced content.
 *
 * Contains all information needed to construct the full prompt
 * for an agent, including user text, metadata, and optional context.
 */
export interface MessageData {
  /** User's message text */
  text: string;
  /** Unique message identifier */
  messageId?: string;
  /** Sender's open ID (channel-specific, e.g., Feishu open_id) */
  senderOpenId?: string;
  /** File attachments */
  attachments?: FileRef[];
  /** Chat history context for passive mode (Issue #517) */
  chatHistoryContext?: string;
  /** Persisted history context for session restoration (Issue #955) */
  persistedHistoryContext?: string;
}

/**
 * Context passed to channel section builders.
 *
 * Provides all available information for building channel-specific
 * content sections in the enhanced message.
 */
export interface MessageBuilderContext {
  /** The message data being processed */
  msg: MessageData;
  /** The chat ID for context */
  chatId: string;
  /** Channel capabilities (if available) */
  capabilities?: ChannelCapabilities;
  /** Whether the message is a skill command (starts with /) */
  isSkillCommand: boolean;
}

/**
 * Options for configuring MessageBuilder with channel-specific extensions.
 *
 * Channel-specific sections are provided via callback functions.
 * The core MessageBuilder handles framework-agnostic content:
 * - Metadata (chatId, messageId, senderId)
 * - History sections (chat history, persisted history)
 * - Guidance sections (next-step, output format, location awareness)
 * - Basic attachment info (file list, paths, MIME types)
 *
 * Channel-specific content:
 * - Platform header (e.g., "You are responding in a Feishu chat.")
 * - @ Mention section (e.g., Feishu <at> tag guidance)
 * - Tools section (e.g., MCP tool names and usage)
 * - Extra attachment info (e.g., image analyzer MCP hints)
 */
export interface MessageBuilderOptions {
  /**
   * Build channel-specific header content.
   * Inserted before metadata (chatId, messageId, etc.).
   *
   * Example: "You are responding in a Feishu chat."
   */
  buildHeader?: (ctx: MessageBuilderContext) => string;

  /**
   * Build channel-specific content after history sections.
   * Inserted between history and the guidance/tools separator.
   *
   * Example: @ Mention section for Feishu.
   */
  buildPostHistory?: (ctx: MessageBuilderContext) => string;

  /**
   * Build channel-specific tools/commands section.
   * Inserted after the "## Tools" heading.
   *
   * Example: MCP tool list for Feishu channel.
   */
  buildToolsSection?: (ctx: MessageBuilderContext) => string;

  /**
   * Build extra attachment information.
   * Appended to the basic attachment info section.
   *
   * Example: Image analyzer MCP hints.
   */
  buildAttachmentExtra?: (ctx: MessageBuilderContext) => string;

  /**
   * Build channel-specific content for skill commands.
   * Inserted after the skill command text and metadata.
   *
   * Example: Additional context for skill execution.
   */
  buildSkillCommandExtra?: (ctx: MessageBuilderContext) => string;

  /**
   * User taste (preference) rules for Agent context injection.
   * Issue #2335: Auto-summarize user taste to avoid repeated corrections.
   *
   * When provided, a "User Preferences (Auto-learned)" section is
   * injected into the agent prompt before the user message.
   *
   * Example: ['Use const/let, never var', 'Reply concisely']
   */
  tasteRules?: string[];
}
