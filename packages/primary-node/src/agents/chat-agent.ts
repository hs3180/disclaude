/**
 * ChatAgent - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Issue #644: Refactored to ensure complete isolation between chat sessions.
 * Each ChatAgent instance is bound to a single chatId at construction time.
 *
 * Issue #697: Extracted types and message builder to separate modules.
 *
 * Key Features:
 * - Streaming Input Mode: Uses SDK's streamInput() for real-time message delivery
 * - Single chatId binding: Each ChatAgent serves exactly one chatId
 * - Persistent Context: Session context persists until manual reset (/reset) or shutdown
 *
 * Architecture (Issue #644):
 * ```
 * AgentPool
 *     └── Map<chatId, ChatAgent>
 *             └── Each ChatAgent handles ONE chatId only
 *                     └── Single Query + Channel pair
 * ```
 *
 * Separation of Concerns:
 * - ConversationOrchestrator: Thread root and context tracking
 * - RestartManager: Restart policy and circuit breaker
 * - MessageBuilder: Enhanced content building (Issue #697)
 * - ChatAgent: Orchestration, callbacks, and main logic flow
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration building
 * - Iterator timeout handling
 * - GLM logging
 * - Error handling
 *
 * Issue #2717: Migrated from @disclaude/worker-node to @disclaude/primary-node.
 * The Worker Node concept is being removed — agents now live where they are used.
 */

import { Config, BaseAgent, MessageBuilder, MessageChannel, RestartManager, ConversationOrchestrator, getErrorStderr, isStartupFailure, type StreamingUserMessage, type QueryHandle, type ChatAgent as ChatAgentInterface, type AgentUserInput, type AgentMessage, type MessageData } from '@disclaude/core';
import { createChannelMcpServer } from '@disclaude/mcp-server';
import type { ChatAgentCallbacks, ChatAgentConfig } from './types.js';

// Type alias for backward compatibility within this module
type UserInput = AgentUserInput;

// Re-export types for backward compatibility
export type { ChatAgentCallbacks, ChatAgentConfig, MessageData } from './types.js';

/**
 * ChatAgent - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Issue #644: Each ChatAgent instance is bound to a single chatId.
 * No session management needed - each ChatAgent = one chatId.
 */
export class ChatAgent extends BaseAgent implements ChatAgentInterface {
  /** Agent type identifier (Issue #282) */
  readonly type = 'chat' as const;

  /** Agent name for logging */
  readonly name = 'ChatAgent';

  /** The chatId this ChatAgent is bound to (Issue #644) */
  private readonly boundChatId: string;

  private readonly callbacks: ChatAgentCallbacks;

  // Single Query and Channel for this chatId (Issue #644: no longer using SessionManager)
  private queryHandle?: QueryHandle;
  private channel?: MessageChannel;
  private isSessionActive = false;

  // Issue #2926: AbortController for immediate stop/reset of running Agent loop
  private abortController: AbortController | null = null;

  // Managers for separated concerns
  private readonly conversationOrchestrator: ConversationOrchestrator;
  private readonly restartManager: RestartManager;

  // Message builder (Issue #697)
  private readonly messageBuilder: MessageBuilder;

  // Session restoration (Issue #955)
  private persistedHistoryContext?: string;
  private historyLoaded = false;
  private historyLoadPromise?: Promise<void>;

  // First message chat history (Issue #1230)
  private firstMessageHistoryContext?: string;
  private firstMessageHistoryLoaded = false;
  private firstMessageHistoryLoadPromise?: Promise<void>;

  // Issue #3124: One-shot mode & task completion
  // When onceMode is true, processIterator closes the channel after the first
  // `result` message and resolves the completion promise, enabling blocking
  // one-shot execution via processMessage + taskComplete.
  private onceMode = false;
  private taskCompletionPromise?: Promise<void>;
  private taskCompletionResolve?: () => void;
  private taskCompletionReject?: (error: Error) => void;

  constructor(config: ChatAgentConfig) {
    super(config);

    // Issue #644: Bind chatId at construction time
    this.boundChatId = config.chatId;
    this.callbacks = config.callbacks;

    // Initialize managers
    this.conversationOrchestrator = new ConversationOrchestrator({ logger: this.logger });
    this.restartManager = new RestartManager({
      logger: this.logger,
      maxRestarts: 3,
      initialBackoffMs: 5000,  // Start with 5 seconds
      maxBackoffMs: 60000,     // Max 1 minute
    });

    // Initialize message builder with channel-specific options (Issue #697, #1492, #1499)
    // When messageBuilderOptions is provided (e.g., by primary-node), use those;
    // otherwise, create a default MessageBuilder with no channel-specific extensions.
    this.messageBuilder = new MessageBuilder(config.messageBuilderOptions);

    this.logger.info({ chatId: this.boundChatId }, 'ChatAgent created for chatId');
  }

  protected getAgentName(): string {
    return 'ChatAgent';
  }

  /**
   * Get the chatId this ChatAgent is bound to.
   */
  getChatId(): string {
    return this.boundChatId;
  }

  /**
   * Promise that resolves when the current task completes (Issue #3124).
   *
   * Set when a session is started via processMessage().
   * Resolves when the SDK returns a `result` message.
   * Rejects if an error occurs during processing.
   *
   * Consumers (e.g., ScheduleExecutor) can use this to await task completion:
   * ```typescript
   * agent.processMessage(chatId, prompt, messageId, userId);
   * await agent.taskComplete;
   * ```
   */
  get taskComplete(): Promise<void> | undefined {
    return this.taskCompletionPromise;
  }

  /**
   * Build MCP servers configuration (Issue #3124).
   *
   * Extracted from startAgentLoop and the former executeOnce to eliminate
   * duplication of MCP server config building.
   *
   * @param skipChannelMcp - If true, skips the channel MCP server (for one-shot/CLI mode)
   * @returns MCP servers configuration object
   */
  private buildMcpServers(skipChannelMcp: boolean): Record<string, unknown> {
    const chatId = this.boundChatId;
    const mcpServers: Record<string, unknown> = {};

    if (!skipChannelMcp) {
      // Get channel capabilities for MCP server filtering (Issue #590 Phase 3)
      const capabilities = this.callbacks.getCapabilities?.(chatId);
      const supportedMcpTools = capabilities?.supportedMcpTools;

      // Determine if we should include Context MCP server
      const contextTools = ['send_text', 'send_card', 'send_interactive', 'send_file'];
      const shouldIncludeContextMcp = supportedMcpTools === undefined ||
        contextTools.some(tool => supportedMcpTools.includes(tool));

      // Use inline transport for channel MCP server
      if (shouldIncludeContextMcp) {
        mcpServers['channel-mcp'] = createChannelMcpServer();

        this.logger.info({
          ipcSocket: process.env.DISCLAUDE_WORKER_IPC_SOCKET,
        }, 'Configured channel MCP server (inline transport)');
      }
    }

    // Merge configured external MCP servers from config file
    const configuredMcpServers = Config.getMcpServersConfig();
    if (configuredMcpServers) {
      for (const [name, config] of Object.entries(configuredMcpServers)) {
        mcpServers[name] = {
          type: 'stdio',
          command: config.command,
          args: config.args || [],
          ...(config.env && { env: config.env }),
        };
      }
    }

    return mcpServers;
  }

  /**
   * Load persisted chat history from MessageLogger (Issue #955).
   *
   * This method loads recent chat history from the file-based message logs
   * to restore context after service restart. The history is loaded once
   * and cached for the lifetime of this ChatAgent instance.
   *
   * @returns Promise that resolves when history is loaded
   */
  private async loadPersistedHistory(): Promise<void> {
    // If already loading, wait for the existing promise
    if (this.historyLoadPromise) {
      return this.historyLoadPromise;
    }

    // If already loaded, return immediately
    if (this.historyLoaded) {
      return;
    }

    // Start loading history
    this.historyLoadPromise = this.doLoadPersistedHistory();
    try {
      await this.historyLoadPromise;
    } finally {
      this.historyLoadPromise = undefined;
    }
  }

  /**
   * Internal method to perform the actual history loading.
   * Uses configurable parameters from Config.getSessionRestoreConfig().
   *
   * TODO(Issue #1041): This method should use a callback instead of direct messageLogger access.
   * For now, it uses the getChatHistory callback if available.
   */
  private async doLoadPersistedHistory(): Promise<void> {
    // Check if callback is available
    if (!this.callbacks.getChatHistory) {
      this.logger.debug(
        { chatId: this.boundChatId },
        'getChatHistory callback not available, skipping persisted history load'
      );
      this.historyLoaded = true;
      return;
    }

    try {
      const sessionConfig = Config.getSessionRestoreConfig();

      this.logger.info(
        { chatId: this.boundChatId, days: sessionConfig.historyDays },
        'Loading persisted chat history for session restoration'
      );

      // Use callback instead of direct messageLogger access
      const history = await this.callbacks.getChatHistory(this.boundChatId);

      if (history && history.trim()) {
        // Truncate if too long
        this.persistedHistoryContext = history.length > sessionConfig.maxContextLength
          ? history.slice(-sessionConfig.maxContextLength)
          : history;

        this.logger.info(
          { chatId: this.boundChatId, historyLength: this.persistedHistoryContext.length },
          'Persisted chat history loaded successfully'
        );
      } else {
        this.logger.debug(
          { chatId: this.boundChatId },
          'No persisted chat history found'
        );
      }

      this.historyLoaded = true;
    } catch (error) {
      this.logger.error(
        { err: error, chatId: this.boundChatId },
        'Failed to load persisted chat history'
      );
      // Mark as loaded even on error to prevent retry loops
      this.historyLoaded = true;
      // Issue #1357: Notify user that history restoration failed
      this.callbacks.sendMessage(
        this.boundChatId,
        '⚠️ 加载历史记录失败，将以全新会话开始。如果需要历史上下文，请发送 /reset 重置会话。',
      ).catch(() => {});
    }
  }

  /**
   * Load chat history for first message context (Issue #1230).
   *
   * This method loads recent chat history to be attached to the first message
   * in a new agent session, providing context for the agent.
   *
   * Issue #1863: Added promise caching to prevent duplicate loads and
   * enable awaiting from processMessage() to fix race condition.
   *
   * @returns Promise that resolves when history is loaded
   */
  private async loadFirstMessageHistory(): Promise<void> {
    // If already loading, wait for the existing promise
    if (this.firstMessageHistoryLoadPromise) {
      return this.firstMessageHistoryLoadPromise;
    }

    // If already loaded, return immediately
    if (this.firstMessageHistoryLoaded) {
      return;
    }

    // Start loading history
    this.firstMessageHistoryLoadPromise = this.doLoadFirstMessageHistory();
    try {
      await this.firstMessageHistoryLoadPromise;
    } finally {
      this.firstMessageHistoryLoadPromise = undefined;
    }
  }

  /**
   * Internal method to perform the actual first message history loading.
   */
  private async doLoadFirstMessageHistory(): Promise<void> {
    try {
      this.logger.info(
        { chatId: this.boundChatId },
        'Loading chat history for first message context'
      );

      const history = await this.callbacks.getChatHistory?.(this.boundChatId);

      if (history && history.trim()) {
        this.firstMessageHistoryContext = history;
        this.logger.info(
          { chatId: this.boundChatId, historyLength: this.firstMessageHistoryContext.length },
          'Chat history for first message loaded successfully'
        );
      } else {
        this.logger.debug(
          { chatId: this.boundChatId },
          'No chat history found for first message'
        );
      }

      this.firstMessageHistoryLoaded = true;
    } catch (error) {
      this.logger.error(
        { err: error, chatId: this.boundChatId },
        'Failed to load chat history for first message'
      );
      // Mark as loaded even on error to prevent retry loops
      this.firstMessageHistoryLoaded = true;
      // Issue #1357: Notify user about history load failure
      this.callbacks.sendMessage(
        this.boundChatId,
        '⚠️ 加载聊天记录失败，第一条消息可能缺少上下文。',
      ).catch(() => {});
    }
  }

  /**
   * Start the agent session (ChatAgent interface).
   *
   * Called once before processing any messages. For ChatAgent, this is a no-op
   * since sessions are created on-demand via processMessage().
   *
   * @returns Promise that resolves when started
   */
  start(): Promise<void> {
    this.logger.debug({ chatId: this.boundChatId }, 'ChatAgent start() called - session is created on-demand');
    return Promise.resolve();
  }

  /**
   * Handle streaming user input and yield responses (ChatAgent interface).
   *
   * This method provides a unified interface for processing user messages
   * from an async generator and yielding AgentMessage responses.
   *
   * @param input - AsyncGenerator yielding UserInput messages
   * @yields AgentMessage responses
   */
  async *handleInput(input: AsyncGenerator<UserInput>): AsyncGenerator<AgentMessage> {
    for await (const userInput of input) {
      const chatId = userInput.metadata?.chatId ?? 'default';
      const messageId = userInput.metadata?.parentMessageId ?? `msg-${Date.now()}`;
      const senderOpenId = userInput.metadata?.fileRefs?.[0]?.name;

      // Issue #644: Verify chatId matches bound chatId
      if (chatId !== this.boundChatId) {
        this.logger.warn(
          { boundChatId: this.boundChatId, receivedChatId: chatId },
          'Received message for different chatId, ignoring'
        );
        continue;
      }

      // Track thread root
      this.conversationOrchestrator.setThreadRoot(chatId, messageId);

      // Start session if needed
      if (!this.isSessionActive) {
        this.startAgentLoop();
      }

      // Get capabilities for message building
      const capabilities = this.callbacks.getCapabilities?.(chatId);

      // Build the user message using MessageBuilder (Issue #697)
      const enhancedContent = this.messageBuilder.buildEnhancedContent({
        text: userInput.content,
        messageId,
        senderOpenId,
      }, chatId, capabilities);

      const streamingMessage: StreamingUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: enhancedContent,
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      // Push message to channel (Issue #2007)
      // Attempt delivery with one retry on failure — channel may have been closed
      // between session start and this point due to an agent loop crash.
      if (!this.tryPushMessage(streamingMessage, chatId, messageId)) {
        // Don't retry if session was intentionally closed (e.g., /reset).
        // Retrying would re-create the session the user just terminated.
        if (!this.isSessionActive) {
          this.logger.info({ chatId, messageId }, 'handleInput: session is not active, skipping retry');
          yield {
            content: '⚠️ 当前会话已重置，请直接发送新消息。',
            role: 'assistant',
            messageType: 'text',
          };
          continue;
        }

        // Cancel old query to prevent orphaned processIterator from sending
        // duplicate messages while the new session starts.
        if (this.queryHandle) {
          this.logger.info({ chatId }, 'handleInput: cancelling old queryHandle before retry');
          this.queryHandle.cancel();
          this.queryHandle = undefined;
        }

        this.logger.warn({ chatId, messageId }, 'handleInput: first push failed, attempting session restart');
        try {
          this.startAgentLoop();
        } catch (restartErr) {
          this.logger.error({ err: restartErr, chatId, messageId }, 'handleInput: session restart failed');
        }
        if (!this.tryPushMessage(streamingMessage, chatId, messageId)) {
          this.logger.error({ chatId, messageId }, 'handleInput: retry also failed, yielding error');
          yield {
            content: '⚠️ 消息未能送达，会话已结束。请发送 /reset 重置会话后重试。',
            role: 'assistant',
            messageType: 'text',
          };
          continue;
        }
      }

      // Yield acknowledgment (internal diagnostic, not user-facing).
      // Uses 'notification' type so consumers can filter it from user messages.
      yield {
        content: '✓',
        role: 'assistant',
        messageType: 'notification',
      };
    }
  }

  /**
   * Execute a one-shot query (Issue #3124).
   *
   * This method uses the unified streaming path (processMessage + taskComplete)
   * instead of a separate code path. It:
   * 1. Enables once-mode on the agent
   * 2. Calls processMessage to start the session and push the message
   * 3. Awaits taskComplete which resolves when the SDK returns a result
   *
   * The once-mode flag causes processIterator to close the channel after
   * receiving the first `result` message, effectively making the session
   * one-shot.
   *
   * @param chatId - Platform-specific chat identifier (must match bound chatId)
   * @param text - User's message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender's open_id for @ mentions
   */
  async runOnce(
    chatId: string,
    text: string,
    messageId?: string,
    senderOpenId?: string
  ): Promise<void> {
    // Issue #644: Verify chatId matches bound chatId
    if (chatId !== this.boundChatId) {
      this.logger.error(
        { boundChatId: this.boundChatId, receivedChatId: chatId },
        'runOnce called with wrong chatId'
      );
      throw new Error(`ChatAgent bound to ${this.boundChatId} cannot execute for ${chatId}`);
    }

    this.logger.info({ chatId, messageId, textLength: text.length }, 'One-shot mode: executing via unified streaming path');

    // Enable once-mode: processIterator will close channel after first result
    this.onceMode = true;

    try {
      // Use processMessage to push the message through the unified streaming path.
      // The processIterator running in the background will handle the SDK responses
      // and resolve/reject the taskComplete promise.
      const effectiveMessageId = messageId ?? `once-${Date.now()}`;
      await this.processMessage(chatId, text, effectiveMessageId, senderOpenId);

      // Wait for the task to complete via the unified streaming path
      if (this.taskCompletionPromise) {
        await this.taskCompletionPromise;
      }

      this.logger.info({ chatId }, 'One-shot task completed normally');
    } finally {
      // Clean up once-mode state
      this.onceMode = false;
    }
  }

  /**
   * Process a message with the AI agent.
   *
   * This method is non-blocking - it pushes the message to the channel and returns immediately.
   * The message will be processed by the SDK via the channel's generator.
   *
   * Issue #644: Only accepts messages for the bound chatId.
   * Issue #857: Triggers async complexity analysis for progress tracking.
   * Issue #1230: Attachs chat history on first message for new sessions.
   *
   * @param chatId - Platform-specific chat identifier (must match bound chatId)
   * @param text - User's message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender's open_id for @ mentions
   * @param attachments - Optional file attachments
   * @param chatHistoryContext - Optional chat history context for passive mode (Issue #517)
   */
  async processMessage(
    chatId: string,
    text: string,
    messageId: string,
    senderOpenId?: string,
    attachments?: MessageData['attachments'],
    chatHistoryContext?: string
  ): Promise<void> {
    // Issue #644: Verify chatId matches bound chatId
    if (chatId !== this.boundChatId) {
      this.logger.error(
        { boundChatId: this.boundChatId, receivedChatId: chatId },
        'processMessage called with wrong chatId - this should not happen'
      );
      return;
    }

    this.logger.info(
      { chatId, messageId, textLength: text.length, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext, hasPersistedHistory: !!this.persistedHistoryContext, hasFirstMessageHistory: !!this.firstMessageHistoryContext },
      'processMessage called'
    );

    // Track thread root
    this.conversationOrchestrator.setThreadRoot(chatId, messageId);

    // Start session if needed
    if (!this.isSessionActive) {
      this.logger.info({ chatId }, 'No active session, starting agent loop');
      this.startAgentLoop();
    }

    // Issue #1863: Wait for first message history to load before building content.
    // This fixes the race condition where processMessage() checks firstMessageHistoryContext
    // before the async loadFirstMessageHistory() in startAgentLoop() completes.
    if (!this.firstMessageHistoryLoaded) {
      await this.loadFirstMessageHistory();
    }

    // Issue #1230: Attach chat history on first message for new sessions
    // Use pre-loaded firstMessageHistoryContext if no context was provided (passive mode)
    let effectiveChatHistoryContext = chatHistoryContext;
    if (!chatHistoryContext && this.firstMessageHistoryContext) {
      effectiveChatHistoryContext = this.firstMessageHistoryContext;
      this.logger.info(
        { chatId, messageId, historyLength: effectiveChatHistoryContext.length },
        'Using pre-loaded chat history for first message'
      );
      // Clear after first use
      this.firstMessageHistoryContext = undefined;
    }

    // Get capabilities for message building
    const capabilities = this.callbacks.getCapabilities?.(chatId);

    // Build the user message using MessageBuilder (Issue #697)
    // Issue #955: Include persisted history context for session restoration
    const enhancedContent = this.messageBuilder.buildEnhancedContent({
      text, messageId, senderOpenId, attachments, chatHistoryContext: effectiveChatHistoryContext,
      persistedHistoryContext: this.persistedHistoryContext,
    }, chatId, capabilities);

    const userMessage: StreamingUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: enhancedContent,
      },
      parent_tool_use_id: null,
      session_id: '',
    };

    // Push message to channel
    if (this.channel) {
      const accepted = this.channel.push(userMessage);
      if (!accepted) {
        // Issue #2007: Channel is closed — message would be silently dropped.
        // Notify the user so they know the action was not processed.
        this.logger.warn({ chatId, messageId }, 'Message rejected: channel is closed');
        this.callbacks.sendMessage(chatId, '⚠️ 消息未能送达，会话可能已结束。请发送 /reset 重置会话后重试。').catch((notifyErr) => {
          this.logger.error({ err: notifyErr, chatId }, 'Failed to send channel-closed notification');
        });
        return;
      }
    } else {
      this.logger.error({ chatId, messageId }, 'No channel found after session creation');
      // Issue #1357: Notify user — message would otherwise be silently lost
      this.callbacks.sendMessage(chatId, '❌ 会话通道异常，请发送 /reset 重置会话后重试。').catch((notifyErr) => {
        this.logger.error({ err: notifyErr, chatId }, 'Failed to send no-channel error notification');
      });
    }
  }

  /**
   * Attempt to push a message to the channel.
   *
   * Centralizes push logic and handles both "no channel" and "channel closed" cases.
   * Returns true if the message was accepted, false otherwise.
   *
   * @param message - The streaming user message to push
   * @param chatId - Chat ID for logging
   * @param messageId - Message ID for logging
   * @returns true if message was accepted by the channel
   */
  private tryPushMessage(message: StreamingUserMessage, chatId: string, messageId: string): boolean {
    if (!this.channel) {
      this.logger.error({ chatId, messageId }, 'tryPushMessage: no channel available');
      return false;
    }
    const accepted = this.channel.push(message);
    if (!accepted) {
      this.logger.warn({ chatId, messageId }, 'tryPushMessage: push rejected, channel is closed');
      return false;
    }
    return true;
  }

  /**
   * Start the Agent loop for this chatId.
   *
   * Creates a MessageChannel and Query, using the channel's generator for streaming input.
   * Issue #590 Phase 3: Filters MCP servers based on channel capabilities.
   * Issue #955: Triggers background loading of persisted chat history.
   * Issue #1230: Triggers background loading of chat history for first message.
   * Issue #3124: Uses buildMcpServers() for shared MCP config, sets up taskComplete promise.
   */
  private startAgentLoop(): void {
    const chatId = this.boundChatId;

    // Issue #955: Trigger background loading of persisted history
    if (!this.historyLoaded) {
      this.loadPersistedHistory().catch((err) => {
        this.logger.error({ err, chatId }, 'Failed to load persisted history in background');
      });
    }

    // Issue #1230: Load chat history for first message context
    if (!this.firstMessageHistoryLoaded && this.callbacks.getChatHistory) {
      this.loadFirstMessageHistory().catch((err) => {
        this.logger.error({ err, chatId }, 'Failed to load first message history in background');
      });
    }

    // Issue #3124: Use shared buildMcpServers() helper (includes channel MCP + external servers)
    const mcpServers = this.buildMcpServers(false);

    // Build SDK options using BaseAgent's createSdkOptions
    const sdkOptions = this.createSdkOptions({
      disallowedTools: ['EnterPlanMode'],
      mcpServers,
    });

    this.logger.info(
      { chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}) },
      'Starting SDK query with message channel'
    );

    // Issue #2926: Create fresh AbortController for this agent loop
    this.abortController = new AbortController();

    // Issue #3124: Set up task completion promise
    this.taskCompletionPromise = new Promise<void>((resolve, reject) => {
      this.taskCompletionResolve = resolve;
      this.taskCompletionReject = reject;
    });

    // Create message channel
    this.channel = new MessageChannel();

    // Create streaming query using channel's generator
    const { handle, iterator } = this.createQueryStream(
      this.channel.generator(),
      sdkOptions
    );

    this.queryHandle = handle;
    this.isSessionActive = true;

    // Process SDK messages in background
    this.processIterator(iterator).catch(async (err) => {
      this.logger.error({
        err,
        chatId,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      }, 'Agent loop error');
      this.isSessionActive = false;

      // Issue #3124: Reject completion promise on outer catch
      this.taskCompletionReject?.(err instanceof Error ? err : new Error(String(err)));
      this.clearTaskCompletion();

      // Issue #1357: Notify user about the critical failure.
      // This is the outer catch — if processIterator itself throws (not an inner
      // iteration error, which is already handled inside processIterator), the user
      // currently sees complete silence. Send a fallback notification.
      try {
        await this.callbacks.sendMessage(
          chatId,
          '❌ 处理消息时发生严重错误，会话已中断。请发送 /reset 重置会话后重试。',
        );
      } catch (notifyErr) {
        this.logger.error({ err: notifyErr, chatId }, 'Failed to send agent loop error notification');
      }
    });
  }

  /**
   * Clear task completion state (Issue #3124).
   */
  private clearTaskCompletion(): void {
    this.taskCompletionPromise = undefined;
    this.taskCompletionResolve = undefined;
    this.taskCompletionReject = undefined;
  }

  /**
   * Process the SDK iterator for this chatId.
   *
   * IMPORTANT: This method preserves conversation context by NOT clearing the session
   * when the iterator ends unexpectedly. Only explicit close (reset)
   * clears the session.
   *
   * If the iterator ends without explicit close, we use RestartManager to:
   * - Limit consecutive restarts (max 3 by default)
   * - Apply exponential backoff between restarts
   * - Open circuit breaker after max restarts exceeded
   *
   */
  private async processIterator(
    iterator: AsyncGenerator<{ parsed: { type: string; content?: string } }>
  ): Promise<void> {
    const chatId = this.boundChatId;
    let iteratorError: Error | null = null;
    let messageCount = 0;
    const startTime = Date.now(); // Issue #2920: 追踪启动时间

    // Issue #3003: Timing diagnostics for request pipeline
    let firstMessageMs: number | undefined;
    let lastToolCallMs: number | undefined;
    let toolCallCount = 0;

    try {

      for await (const { parsed } of iterator) {
        // Issue #2926: Check abort signal at the start of each iteration.
        // When /stop or /reset is received, we break immediately instead of
        // continuing to process buffered SDK messages.
        if (this.abortController?.signal.aborted) {
          this.logger.info(
            { chatId, messageCount, type: parsed.type },
            'Aborting processIterator: stop/reset signal received'
          );
          break;
        }

        messageCount++;

        // Issue #3003: Track Time-To-First-Token (TTFT)
        if (!firstMessageMs) {
          firstMessageMs = Date.now();
          this.logger.info(
            { chatId, ttftMs: firstMessageMs - startTime, type: parsed.type },
            'First SDK message received (TTFT)'
          );
        }

        // Issue #3003: Track tool call timing
        if (parsed.type === 'tool_use') {
          toolCallCount++;
          const now = Date.now();
          const sinceLastTool = lastToolCallMs ? now - lastToolCallMs : undefined;
          lastToolCallMs = now;
          this.logger.info(
            { chatId, toolCallCount, sinceLastToolMs: sinceLastTool, elapsedMs: now - startTime },
            'Tool call received'
          );
        }

        this.logger.debug(
          { chatId, messageCount, type: parsed.type },
          'SDK message received'
        );

        // Send message content to callback
        if (parsed.content) {
          const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
          await this.callbacks.sendMessage(chatId, parsed.content, threadRoot);
        }

        // Check for completion
        if (parsed.type === 'result') {
          // Issue #3003: Log timing summary on completion
          const completionMs = Date.now() - startTime;
          this.logger.info({
            chatId,
            content: parsed.content,
            completionMs,
            ttftMs: firstMessageMs ? firstMessageMs - startTime : undefined,
            toolCallCount,
            messageCount,
          }, 'Result received, turn complete');

          // Record success to reset restart state
          this.restartManager.recordSuccess(chatId);

          if (this.callbacks.onDone) {
            const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
            await this.callbacks.onDone(chatId, threadRoot);
          }

          // Issue #3124: In once-mode, close channel after result to end the iterator.
          // This enables blocking one-shot execution via processMessage + taskComplete.
          if (this.onceMode) {
            this.logger.info({ chatId }, 'Once-mode: closing channel after result');
            this.isSessionActive = false;
            this.channel?.close();
            this.taskCompletionResolve?.();
            this.clearTaskCompletion();
          }
        }
      }
    } catch (error) {
      iteratorError = error as Error;
      const elapsedMs = Date.now() - startTime; // Issue #2920: 计算耗时

      // Issue #3003: Log detailed timing on iterator error
      this.logger.error({
        err: iteratorError,
        chatId,
        messageCount,
        elapsedMs,
        ttftMs: firstMessageMs ? firstMessageMs - startTime : undefined,
        toolCallCount,
        errorMessage: iteratorError.message,
        errorStack: iteratorError.stack,
        errorName: iteratorError.constructor.name,
        errorCause: iteratorError.cause,
      }, 'Iterator error');

      // Issue #2920: 检测启动阶段失败
      // 启动失败的特征：没有收到任何 SDK 消息且耗时很短。
      // 根因通常是配置错误（MCP 配置无效、API Key 过期等），
      // 重试无法解决，直接向用户展示具体错误。
      if (isStartupFailure(messageCount, elapsedMs)) {
        const stderr = getErrorStderr(iteratorError);
        const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);

        // 提取有用的错误信息：优先使用 stderr 内容
        let diagnosticMessage = iteratorError.message;
        if (stderr) {
          // 取 stderr 最后几行作为诊断信息（去空行，限制长度）
          const stderrLines = stderr.split('\n').filter(l => l.trim());
          const tailLines = stderrLines.slice(-5).join('\n');
          diagnosticMessage = tailLines.length > 800
            ? tailLines.slice(-800)
            : tailLines;
        }

        this.logger.error(
          {
            chatId,
            messageCount,
            elapsedMs,
            stderr: stderr ? stderr.slice(-500) : undefined,
          },
          'Startup failure detected — skipping retry/circuit-breaker'
        );

        await this.callbacks.sendMessage(
          chatId,
          `❌ Agent 启动失败: ${diagnosticMessage}\n\n`
          + '这是一次配置或环境错误，重试无法解决。\n'
          + '请检查上述错误信息，修复后发送 /reset 重置会话。',
          threadRoot,
        );

        // 启动失败不触发重试，直接标记会话为非活跃
        this.isSessionActive = false;

        // Issue #3124: Reject completion promise on startup failure
        this.taskCompletionReject?.(iteratorError);
        this.clearTaskCompletion();

        if (this.callbacks.onDone) {
          await this.callbacks.onDone(chatId, threadRoot);
        }
        return; // 直接返回，不进入重启逻辑
      }

      // Notify user about the error
      {
        const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
        await this.callbacks.sendMessage(chatId, `❌ Session error: ${iteratorError.message}`, threadRoot);
      }

      // Issue #3124: Reject completion promise on runtime error
      this.taskCompletionReject?.(iteratorError);
      this.clearTaskCompletion();

      if (this.callbacks.onDone) {
        const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
        await this.callbacks.onDone(chatId, threadRoot);
      }
    }

    // Check if this was an explicit close (reset cleared the session)
    const wasExplicitClose = !this.isSessionActive;

    // Issue #3003: Log timing summary for the entire agent loop
    if (!wasExplicitClose) {
      const loopElapsedMs = Date.now() - startTime;
      this.logger.warn(
        {
          chatId,
          loopElapsedMs,
          messageCount,
          ttftMs: firstMessageMs ? firstMessageMs - startTime : undefined,
          toolCallCount,
          hadError: !!iteratorError,
        },
        'Agent loop ended unexpectedly — timing summary'
      );
    }

    if (wasExplicitClose) {
      this.logger.info({ chatId }, 'Agent loop completed (explicit close)');
      return;
    }

    // Iterator ended without explicit close - this is unexpected
    this.isSessionActive = false;

    // Issue #3124: In once-mode, resolve completion and skip restart logic.
    // The channel was closed by the result handler or an error occurred.
    if (this.onceMode) {
      this.taskCompletionResolve?.();
      this.clearTaskCompletion();
      return;
    }

    // Iterator ended without explicit close - determine error message for restart logic
    const errorMessage = iteratorError?.message ?? 'Unknown error';
    const decision = this.restartManager.shouldRestart(chatId, errorMessage);

    if (!decision.allowed) {
      // Circuit breaker opened - notify user and stop
      this.logger.error(
        { chatId, reason: decision.reason, restartCount: decision.restartCount },
        'Restart blocked by circuit breaker'
      );

      // Notify user that circuit breaker opened
      {
        const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
        const blockMessage = decision.reason === 'max_restarts_exceeded'
          ? `🚫 会话多次异常中断，已暂停处理。请发送 /reset 重置会话。\n\n最近错误: ${errorMessage}`
          : `🚫 会话已暂停，请发送 /reset 重置。\n\n原因: ${decision.reason}`;
        await this.callbacks.sendMessage(chatId, blockMessage, threadRoot);
      }
      return;
    }

    // Restart allowed - apply backoff
    this.logger.warn(
      { chatId, error: errorMessage, restartCount: decision.restartCount, waitMs: decision.waitMs },
      'Agent loop ended unexpectedly, attempting restart with backoff'
    );

    // Wait for backoff period
    if (decision.waitMs && decision.waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, decision.waitMs));
    }

    // Notify user about the restart
    const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
    const restartMessage = iteratorError
      ? `⚠️ 会话遇到错误，正在重新连接... (${iteratorError.message})`
      : '⚠️ 会话意外断开，正在重新连接...';
    await this.callbacks.sendMessage(chatId, restartMessage, threadRoot);

    // Restart the agent loop to preserve context for future messages
    this.startAgentLoop();
    this.logger.info({ chatId }, 'Agent loop restarted');
  }

  /**
   * Reset the agent session (ChatAgent interface).
   *
   * Clears conversation history and state for this ChatAgent's bound chatId.
   * By default, does NOT reload history context after reset, giving a clean session.
   *
   * @param chatId - Optional chat ID (must match bound chatId if provided)
   * @param keepContext - If true, reloads history context after reset (default: false, uses config)
   */
  reset(chatId?: string, keepContext?: boolean): void {
    // Issue #644: If chatId is provided, it must match bound chatId
    if (chatId && chatId !== this.boundChatId) {
      this.logger.warn(
        { boundChatId: this.boundChatId, requestedChatId: chatId },
        'Reset called for different chatId, ignoring'
      );
      return;
    }

    this.logger.info({ chatId: this.boundChatId, keepContext }, 'Resetting ChatAgent session');

    // Issue #2926: Abort the running agent loop first so processIterator
    // breaks out of its for-await loop immediately, rather than continuing
    // to process buffered SDK messages.
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Mark session as inactive BEFORE closing to signal explicit close
    this.isSessionActive = false;

    // Close channel and query
    if (this.channel) {
      this.channel.close();
      this.channel = undefined;
    }
    if (this.queryHandle) {
      this.queryHandle.close();
      this.queryHandle = undefined;
    }

    // Clear conversation context
    this.conversationOrchestrator.deleteThreadRoot(this.boundChatId);

    // Reset restart state
    this.restartManager.reset(this.boundChatId);

    // Clear persisted history context (Issue #955)
    this.persistedHistoryContext = undefined;
    this.historyLoaded = false;

    // Clear first message history context (Issue #1230)
    this.firstMessageHistoryContext = undefined;
    this.firstMessageHistoryLoaded = false;

    // Issue #3124: Clear once-mode and task completion state
    this.onceMode = false;
    this.clearTaskCompletion();

    // Issue #1213: Reload history only if explicitly requested via keepContext
    if (keepContext) {
      this.logger.info({ chatId: this.boundChatId }, 'Reloading history context after reset');
      this.loadPersistedHistory().catch((err) => {
        this.logger.error({ err, chatId: this.boundChatId }, 'Failed to reload history after reset');
        // Issue #1357: Notify user that context preservation failed
        this.callbacks.sendMessage(
          this.boundChatId,
          '⚠️ 重置后加载历史记录失败，当前会话无历史上下文。',
        ).catch(() => {});
      });
    }
  }

  /**
   * Get the number of active sessions (always 0 or 1 for bound ChatAgent).
   */
  getActiveSessionCount(): number {
    return this.isSessionActive ? 1 : 0;
  }

  /**
   * Check if this ChatAgent has an active session.
   */
  hasActiveSession(): boolean {
    return this.isSessionActive;
  }

  /**
   * Stop the current query without resetting the session.
   * Issue #1349: /stop command
   *
   * Unlike reset(), this only interrupts the current streaming response
   * while preserving the session state and conversation context.
   * The user can continue the conversation after stopping.
   *
   * @param chatId - Optional chat ID (must match bound chatId if provided)
   * @returns true if a query was stopped, false if no active query
   */
  stop(chatId?: string): boolean {
    // Issue #644: If chatId is provided, it must match bound chatId
    if (chatId && chatId !== this.boundChatId) {
      this.logger.warn(
        { boundChatId: this.boundChatId, requestedChatId: chatId },
        'Stop called for different chatId, ignoring'
      );
      return false;
    }

    // Check if there's an active query to stop
    if (!this.queryHandle) {
      this.logger.debug({ chatId: this.boundChatId }, 'No active query to stop');
      return false;
    }

    this.logger.info({ chatId: this.boundChatId }, 'Stopping current query');

    // Issue #2926: Abort the running iterator so processIterator breaks
    // immediately instead of continuing to process buffered messages.
    if (this.abortController) {
      this.abortController.abort();
      // Note: A new AbortController will be created when the agent loop
      // restarts (via processIterator → startAgentLoop).
    }

    // Cancel the current query (not close, to allow continuation)
    this.queryHandle.cancel();
    this.queryHandle = undefined;

    // Note: We do NOT set isSessionActive to false here
    // The session remains active, just the current query is cancelled
    // The channel is preserved so new messages can still be sent

    return true;
  }

  /**
   * Dispose of resources held by this agent.
   *
   * Implements Disposable interface (Issue #328).
   */
  dispose(): void {
    this.shutdown().catch((err) => {
      this.logger.error({ err }, 'Error during dispose shutdown');
    });
    // Call super.dispose() to mark as disposed
    super.dispose();
  }

  /**
   * Cleanup resources on shutdown.
   */
  async shutdown(): Promise<void> {
    await Promise.resolve(); // No-op to satisfy linter
    this.logger.info({ chatId: this.boundChatId }, 'Shutting down ChatAgent');

    // Mark session as inactive
    this.isSessionActive = false;

    // Issue #2926: Abort any running agent loop
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Close channel and query
    if (this.channel) {
      this.channel.close();
      this.channel = undefined;
    }
    if (this.queryHandle) {
      this.queryHandle.close();
      this.queryHandle = undefined;
    }

    // Clear conversation context
    this.conversationOrchestrator.clearAll();

    // Clear restart states
    this.restartManager.clearAll();

    this.logger.info({ chatId: this.boundChatId }, 'ChatAgent shutdown complete');
  }
}
