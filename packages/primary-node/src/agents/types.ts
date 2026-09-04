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

import type { FeishuCard, ChannelCapabilities, BaseAgentConfig, MessageBuilderOptions, CwdProvider, CwdResolution } from '@disclaude/core';

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
  sendMessage: (chatId: string, text: string, parentMessageId?: string) => Promise<string | void>;

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

  /**
   * Get chat log file paths for a given chatId.
   *
   * Issue #3996: Returns the list of log file absolute paths so the agent
   * can Read them to access conversation history beyond the context window.
   *
   * @param chatId - Platform-specific chat identifier
   * @returns Array of absolute file paths to chat log files
   */
  getChatLogFilePaths?: (chatId: string) => Promise<string[]>;

  // --------------------------------------------------------------------------
  // Streaming contract — Issue #4208 P2-a (#4397)
  // --------------------------------------------------------------------------
  // All three are optional. If a channel does not support streaming (i.e.
  // `capabilities.supportsStreaming === false`) OR declines per-call, it leaves
  // these unset / returns null, and ChatAgent degrades to `sendMessage` — the
  // reply is never lost. No caller wires these yet (Phase 2b will); until then
  // they are pure contract.
  // --------------------------------------------------------------------------

  /**
   * Begin a streaming reply. Creates the in-place message/card to patch and
   * returns a stream handle (e.g. card/message id), or `null` to signal
   * "degrade to sendMessage" for this turn.
   * @param chatId - Platform-specific chat identifier
   * @param parentMessageId - Optional parent message id for thread replies
   */
  startStreaming?: (chatId: string, parentMessageId?: string) => Promise<string | null>;

  /**
   * Patch the in-flight stream identified by `id` (returned by startStreaming)
   * with the latest accumulated `text` (replace-semantics unless a future
   * Phase opts into append).
   */
  streamText?: (id: string, text: string) => Promise<void>;

  /**
   * Finalize (freeze) the in-flight stream identified by `id`. No further
   * streamText calls will be made for this id.
   */
  finalizeStreaming?: (id: string) => Promise<void>;
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
   * Dynamic cwd resolution callback for project-scoped Agent context switching.
   *
   * When provided, the ChatAgent calls this at each startAgentLoop() to resolve
   * the working directory for the current chatId. Returns undefined for default
   * project (SDK falls back to Config.getWorkspaceDir()).
   *
   * @see Issue #1916 (unified ProjectContext system)
   */
  cwdProvider?: CwdProvider;

  /**
   * Structured cwd resolver — same inputs as `cwdProvider` but returns *why*
   * the cwd resolved the way it did (bound / unbound / bound-missing).
   *
   * Issue #4448 (direction #1): when the chat is bound to a directory that
   * does not exist, the agent silently falls back to the workspace while
   * `/project info` still shows the (stale) target. `cwdProvider` alone can't
   * distinguish that from "unbound" (both return `undefined`), so the ChatAgent
   * uses this resolver — when present — to push a user-visible warning to the
   * chat on the `bound-missing` fallback. Optional: without it the agent keeps
   * the plain `cwdProvider` behavior.
   *
   * @see ProjectManager.resolveCwd
   */
  cwdResolver?: (chatId: string) => CwdResolution;

  /**
   * Skip loading persisted and first-message history on agent startup.
   *
   * Issue #3696: When true, the agent starts with an empty context window,
   * ignoring any previously persisted chat history. Used by /reset --no-context.
   *
   * This flag is consumed once during agent creation and does not persist
   * across subsequent startAgentLoop() calls.
   */
  skipHistory?: boolean;

}

// Re-export MessageData from core for backward compatibility (Issue #1492)
export type { MessageData } from '@disclaude/core';
