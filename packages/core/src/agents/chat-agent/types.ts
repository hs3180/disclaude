/**
 * Type definitions for ChatAgent.
 *
 * Issue #2717 Phase 1: Migrated from @disclaude/worker-node to @disclaude/core.
 * Extracted for better separation of concerns (Issue #697).
 * Issue #1492: MessageData moved to core package, re-exported here for backward compatibility.
 */

import type { ChannelCapabilities } from '../../types/channel.js';
import type { BaseAgentConfig } from '../types.js';
import type { MessageBuilderOptions } from '../message-builder/types.js';

/**
 * Callback functions for platform-specific operations.
 */
export interface ChatAgentCallbacks {
  /**
   * Send a text message to the user.
   * @param chatId - Platform-specific chat identifier
   * @param text - Message content
   * @param parentMessageId - Optional parent message ID for thread replies
   */
  sendMessage: (chatId: string, text: string, parentMessageId?: string) => Promise<void>;

  /**
   * Send an interactive card to the user.
   * @param chatId - Platform-specific chat identifier
   * @param card - Card JSON structure
   * @param description - Optional description for logging
   * @param parentMessageId - Optional parent message ID for thread replies
   */
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;

  /**
   * Send a file to the user.
   * @param chatId - Platform-specific chat identifier
   * @param filePath - Local file path to send
   */
  sendFile: (chatId: string, filePath: string) => Promise<void>;

  /**
   * Called when the Agent query completes (result message received).
   * Used to signal completion to communication layer (e.g., REST sync mode).
   * @param chatId - Platform-specific chat identifier
   * @param parentMessageId - Optional parent message ID for thread replies
   */
  onDone?: (chatId: string, parentMessageId?: string) => Promise<void>;

  /**
   * Get the capabilities of the channel for a specific chat.
   * Used for capability-aware prompt generation (Issue #582).
   * @param chatId - Platform-specific chat identifier
   * @returns Channel capabilities or undefined if not available
   */
  getCapabilities?: (chatId: string) => ChannelCapabilities | undefined;

  /**
   * Get chat history context for the first message in a new session.
   * Issue #1230: Used to attach context only on the first message.
   * @param chatId - Platform-specific chat identifier
   * @returns Chat history context string or undefined if not available
   */
  getChatHistory?: (chatId: string) => Promise<string | undefined>;
}

/**
 * Configuration options for ChatAgent.
 *
 * Issue #644: Added chatId binding for session isolation.
 * Issue #857: Added complexityThreshold for task progress tracking.
 * Issue #2717 Phase 1: Added channelMcpFactory for dependency injection
 * (replaces direct import from @disclaude/mcp-server in AgentLoopManager).
 */
export interface ChatAgentConfig extends BaseAgentConfig {
  /**
   * The chatId this ChatAgent is bound to.
   * Each ChatAgent instance serves exactly one chatId.
   */
  chatId: string;

  /**
   * Callback functions for platform-specific operations.
   */
  callbacks: ChatAgentCallbacks;

  /**
   * Complexity threshold for starting progress tracking.
   * Tasks with complexity >= threshold will show progress cards.
   * Default: 7 (range: 1-10)
   *
   * Issue #857: Task progress tracking for complex tasks.
   */
  complexityThreshold?: number;

  /**
   * Channel-specific MessageBuilder options.
   *
   * When provided, the ChatAgent will use these options for building
   * enhanced message content (e.g., platform headers, tool sections,
   * attachment extras). When omitted, a default empty MessageBuilder
   * is used with no channel-specific extensions.
   *
   * Issue #1499: Decouple Feishu-specific logic from worker-node.
   * Callers (e.g., primary-node) should provide channel-specific
   * options when creating ChatAgent instances.
   */
  messageBuilderOptions?: MessageBuilderOptions;

  /**
   * Factory function to create the channel MCP server configuration.
   *
   * Issue #2717 Phase 1: Injected dependency to break the circular
   * dependency between core and mcp-server packages. Previously,
   * AgentLoopManager imported createChannelMcpServer directly from
   * @disclaude/mcp-server, which prevented migration to core.
   *
   * When provided, this factory is called by AgentLoopManager.buildMcpServers()
   * to generate the channel-mcp server config. When omitted, channel MCP
   * tools are not included in the agent's MCP server list.
   *
   * @returns MCP server configuration object for the channel transport
   */
  channelMcpFactory?: () => unknown;
}

// Re-export MessageData from core for backward compatibility (Issue #1492)
export type { MessageData } from '../message-builder/types.js';
