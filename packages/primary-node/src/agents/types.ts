/**
 * Agent type definitions for Primary Node.
 *
 * Issue #2717: Migrated from @disclaude/worker-node to @disclaude/primary-node.
 * The Worker Node concept is being removed — agents now live where they are used.
 *
 * ChatAgentCallbacks defines the contract between ChatAgent and the
 * communication layer (channels). Each channel implementation provides
 * callbacks that satisfy this interface.
 */

import type { FeishuCard, ChannelCapabilities, BaseAgentConfig, MessageBuilderOptions } from '@disclaude/core';

// ============================================================================
// ChatAgentCallbacks
// ============================================================================

/**
 * Callback functions for platform-specific operations.
 *
 * Used when creating ChatAgent instances. The communication layer
 * (channels) provides implementations of these callbacks.
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
  sendCard: (chatId: string, card: FeishuCard, description?: string, parentMessageId?: string) => Promise<void>;

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

// ============================================================================
// ChatAgentConfig
// ============================================================================

/**
 * Configuration options for ChatAgent.
 *
 * Issue #644: Added chatId binding for session isolation.
 * Issue #857: Added complexityThreshold for task progress tracking.
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
   * SDK message inactivity timeout in milliseconds.
   *
   * If no SDK message is received within this duration during an active
   * agent loop, the session is considered hung and will be terminated
   * with an error notification to the user. The query is then cancelled
   * and the existing restart/circuit-breaker logic takes over.
   *
   * Default: 300000 (5 minutes). Set to 0 to disable.
   *
   * Issue #2993: Session inactivity timeout detection.
   */
  sessionInactivityTimeoutMs?: number;
}

// Re-export MessageData from core for backward compatibility (Issue #1492)
export type { MessageData } from '@disclaude/core';
