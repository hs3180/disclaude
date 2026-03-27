/**
 * Type definitions for Pilot agent.
 *
 * Extracted from pilot.ts for better separation of concerns (Issue #697).
 * Issue #1492: MessageData moved to core package, re-exported here for backward compatibility.
 */

import type { ChannelCapabilities, BaseAgentConfig, MessageBuilderOptions, ResearchModeManager } from '@disclaude/core';

/**
 * Callback functions for platform-specific operations.
 */
export interface PilotCallbacks {
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
 * Configuration options for Pilot.
 *
 * Issue #644: Added chatId binding for session isolation.
 * Issue #857: Added complexityThreshold for task progress tracking.
 */
export interface PilotConfig extends BaseAgentConfig {
  /**
   * The chatId this Pilot is bound to.
   * Each Pilot instance serves exactly one chatId.
   */
  chatId: string;

  /**
   * Callback functions for platform-specific operations.
   */
  callbacks: PilotCallbacks;

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
   * When provided, the Pilot will use these options for building
   * enhanced message content (e.g., platform headers, tool sections,
   * attachment extras). When omitted, a default empty MessageBuilder
   * is used with no channel-specific extensions.
   *
   * Issue #1499: Decouple Feishu-specific logic from worker-node.
   * Callers (e.g., primary-node) should provide channel-specific
   * options when creating Pilot instances.
   */
  messageBuilderOptions?: MessageBuilderOptions;

  /**
   * Research Mode Manager for CWD switching.
   *
   * When provided and research mode is active for this Pilot's chatId,
   * the agent's working directory is switched to the research workspace.
   *
   * Issue #1709: Research Mode — Phase 1.
   */
  researchModeManager?: ResearchModeManager;
}

// Re-export MessageData from core for backward compatibility (Issue #1492)
export type { MessageData } from '@disclaude/core';
