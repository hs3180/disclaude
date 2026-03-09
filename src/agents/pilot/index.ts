/**
 * Pilot - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Issue #644: Refactored to ensure complete isolation between chat sessions.
 * Each Pilot instance is bound to a single chatId at construction time.
 *
 * Issue #697: Extracted types and message builder to separate modules.
 *
 * Key Features:
 * - Streaming Input Mode: Uses SDK's streamInput() for real-time message delivery
 * - Single chatId binding: Each Pilot serves exactly one chatId
 * - Persistent Context: Session context persists until manual reset (/reset) or shutdown
 *
 * Architecture (Issue #644):
 * ```
 * AgentPool
 *     └── Map<chatId, Pilot>
 *             └── Each Pilot handles ONE chatId only
 *                     └── Single Query + Channel pair
 * ```
 *
 * Separation of Concerns:
 * - ConversationOrchestrator: Thread root and context tracking
 * - RestartManager: Restart policy and circuit breaker
 * - MessageBuilder: Enhanced content building (Issue #697)
 * - Pilot: Orchestration, callbacks, and main logic flow
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration building
 * - Iterator timeout handling
 * - GLM logging
 * - Error handling
 */

import type { StreamingUserMessage, QueryHandle } from '../../sdk/index.js';
import { Config } from '../../config/index.js';
import { SESSION_RESTORE } from '../../config/constants.js';
import { createFeishuSdkMcpServer } from '../../mcp/feishu-context-mcp.js';
import { messageLogger } from '../../feishu/message-logger.js';
import { BaseAgent } from '../base-agent.js';
import type { ChatAgent, UserInput } from '../types.js';
import type { AgentMessage } from '../../types/agent.js';
import { MessageChannel } from '../message-channel.js';
import { RestartManager } from '../restart-manager.js';
import { ConversationOrchestrator } from '../../conversation/index.js';
import { MessageBuilder } from './message-builder.js';
import type { PilotCallbacks, PilotConfig, MessageData } from './types.js';
// TaskComplexityAgent removed - Issue #857 refactored to use simple progress reporting

// Re-export types for backward compatibility
export type { PilotCallbacks, PilotConfig, MessageData } from './types.js';

/**
 * Pilot - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Issue #644: Each Pilot instance is bound to a single chatId.
 * No session management needed - each Pilot = one chatId.
 */
export class Pilot extends BaseAgent implements ChatAgent {
  /** Agent type identifier (Issue #282) */
  readonly type = 'chat' as const;

  /** Agent name for logging */
  readonly name = 'Pilot';

  /** The chatId this Pilot is bound to (Issue #644) */
  private readonly boundChatId: string;

  private readonly callbacks: PilotCallbacks;

  // Single Query and Channel for this chatId (Issue #644: no longer using SessionManager)
  private queryHandle?: QueryHandle;
  private channel?: MessageChannel;
  private isSessionActive = false;

  // Managers for separated concerns
  private readonly conversationOrchestrator: ConversationOrchestrator;
  private readonly restartManager: RestartManager;

  // Message builder (Issue #697)
  private readonly messageBuilder: MessageBuilder;

  // Session restoration (Issue #955)
  private persistedHistoryContext?: string;
  private historyLoaded = false;
  private historyLoadPromise?: Promise<void>;

  constructor(config: PilotConfig) {
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

    // Initialize message builder (Issue #697)
    this.messageBuilder = new MessageBuilder();

    this.logger.info({ chatId: this.boundChatId }, 'Pilot created for chatId');
  }

  protected getAgentName(): string {
    return 'Pilot';
  }

  /**
   * Get the chatId this Pilot is bound to.
   */
  getChatId(): string {
    return this.boundChatId;
  }

  /**
   * Load persisted chat history from MessageLogger (Issue #955).
   *
   * This method loads recent chat history from the file-based message logs
   * to restore context after service restart. The history is loaded once
   * and cached for the lifetime of this Pilot instance.
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
   */
  private async doLoadPersistedHistory(): Promise<void> {
    try {
      this.logger.info(
        { chatId: this.boundChatId, days: SESSION_RESTORE.HISTORY_DAYS },
        'Loading persisted chat history for session restoration'
      );

      const history = await messageLogger.getChatHistory(
        this.boundChatId,
        SESSION_RESTORE.HISTORY_DAYS
      );

      if (history && history.trim()) {
        // Truncate if too long
        this.persistedHistoryContext = history.length > SESSION_RESTORE.MAX_CONTEXT_LENGTH
          ? history.slice(-SESSION_RESTORE.MAX_CONTEXT_LENGTH)
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
    }
  }

  /**
   * Start the agent session (ChatAgent interface).
   *
   * Called once before processing any messages. For Pilot, this is a no-op
   * since sessions are created on-demand via processMessage().
   *
   * @returns Promise that resolves when started
   */
  start(): Promise<void> {
    this.logger.debug({ chatId: this.boundChatId }, 'Pilot start() called - session is created on-demand');
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

      // Push message to channel
      if (this.channel) {
        this.channel.push(streamingMessage);
      }

      yield {
        content: `Message received for session ${chatId}`,
        role: 'assistant',
        messageType: 'text',
      };
    }
  }

  /**
   * Execute a one-shot query (CLI mode).
   *
   * This method is blocking - it waits for the query to complete before returning.
   * Uses direct string prompt instead of streaming input.
   * No session state is maintained - each call is independent.
   *
   * @param chatId - Platform-specific chat identifier (must match bound chatId)
   * @param text - User's message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender's open_id for @ mentions
   */
  async executeOnce(
    chatId: string,
    text: string,
    messageId?: string,
    senderOpenId?: string
  ): Promise<void> {
    // Issue #644: Verify chatId matches bound chatId
    if (chatId !== this.boundChatId) {
      this.logger.error(
        { boundChatId: this.boundChatId, receivedChatId: chatId },
        'executeOnce called with wrong chatId'
      );
      throw new Error(`Pilot bound to ${this.boundChatId} cannot execute for ${chatId}`);
    }

    this.logger.info({ chatId, messageId, textLength: text.length }, 'CLI mode: executing one-shot query');

    // Add MCP servers
    const mcpServers: Record<string, unknown> = {};

    // CLI mode doesn't need Feishu MCP server
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

    // Build SDK options using BaseAgent's createSdkOptions
    const sdkOptions = this.createSdkOptions({
      disallowedTools: ['AskUserQuestion', 'EnterPlanMode'],
      mcpServers,
    });

    // Get capabilities for message building
    const capabilities = this.callbacks.getCapabilities?.(chatId);

    // Build enhanced content using MessageBuilder (Issue #697)
    const enhancedContent = this.messageBuilder.buildEnhancedContent({
      text,
      messageId: messageId ?? `cli-${Date.now()}`,
      senderOpenId,
    }, chatId, capabilities);

    this.logger.info({ chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}) }, 'Starting CLI query with direct prompt');

    try {
      // Use BaseAgent's queryOnce for one-shot query with timeout protection
      for await (const { parsed } of this.queryOnce(enhancedContent, sdkOptions)) {
        // Check for completion - result type means query is done
        if (parsed.type === 'result') {
          this.logger.debug({ chatId, content: parsed.content }, 'CLI query result received, breaking loop');
          break;
        }

        // Send message content to callback (with thread support)
        if (parsed.content) {
          await this.callbacks.sendMessage(chatId, parsed.content, messageId);
        }
      }

      this.logger.info({ chatId }, 'CLI query completed normally');
    } catch (error) {
      const err = error as Error;
      this.logger.error({
        err,
        chatId,
        errorMessage: err.message,
        errorStack: err.stack,
        errorName: err.constructor.name,
        errorCause: err.cause,
      }, 'CLI query error');

      await this.callbacks.sendMessage(chatId, `❌ Session error: ${err.message}`, messageId);
      throw err;
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
   *
   * @param chatId - Platform-specific chat identifier (must match bound chatId)
   * @param text - User's message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender's open_id for @ mentions
   * @param attachments - Optional file attachments
   * @param chatHistoryContext - Optional chat history context for passive mode (Issue #517)
   */
  processMessage(
    chatId: string,
    text: string,
    messageId: string,
    senderOpenId?: string,
    attachments?: MessageData['attachments'],
    chatHistoryContext?: string
  ): void {
    // Issue #644: Verify chatId matches bound chatId
    if (chatId !== this.boundChatId) {
      this.logger.error(
        { boundChatId: this.boundChatId, receivedChatId: chatId },
        'processMessage called with wrong chatId - this should not happen'
      );
      return;
    }

    this.logger.info(
      { chatId, messageId, textLength: text.length, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext, hasPersistedHistory: !!this.persistedHistoryContext },
      'processMessage called'
    );

    // Track thread root
    this.conversationOrchestrator.setThreadRoot(chatId, messageId);

    // Start session if needed
    if (!this.isSessionActive) {
      this.logger.info({ chatId }, 'No active session, starting agent loop');
      this.startAgentLoop();
    }

    // Get capabilities for message building
    const capabilities = this.callbacks.getCapabilities?.(chatId);

    // Build the user message using MessageBuilder (Issue #697)
    // Issue #955: Include persisted history context for session restoration
    const enhancedContent = this.messageBuilder.buildEnhancedContent({
      text, messageId, senderOpenId, attachments, chatHistoryContext,
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
      this.channel.push(userMessage);
    } else {
      this.logger.error({ chatId, messageId }, 'No channel found after session creation');
    }
  }

  /**
   * Start the Agent loop for this chatId.
   *
   * Creates a MessageChannel and Query, using the channel's generator for streaming input.
   * Issue #590 Phase 3: Filters MCP servers based on channel capabilities.
   * Issue #955: Triggers background loading of persisted chat history.
   */
  private startAgentLoop(): void {
    const chatId = this.boundChatId;

    // Issue #955: Trigger background loading of persisted history
    if (!this.historyLoaded) {
      this.loadPersistedHistory().catch((err) => {
        this.logger.error({ err, chatId }, 'Failed to load persisted history in background');
      });
    }

    // Get channel capabilities for MCP server filtering (Issue #590 Phase 3)
    const capabilities = this.callbacks.getCapabilities?.(chatId);
    const supportedMcpTools = capabilities?.supportedMcpTools;

    // Determine if we should include Context MCP server
    const contextTools = ['send_message', 'send_file'];
    const shouldIncludeContextMcp = supportedMcpTools === undefined ||
      contextTools.some(tool => supportedMcpTools.includes(tool));

    // Add MCP servers
    const mcpServers: Record<string, unknown> = {};

    // Only add Context MCP server if channel supports any context tools
    if (shouldIncludeContextMcp) {
      mcpServers['context-mcp'] = createFeishuSdkMcpServer();
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

    // Build SDK options using BaseAgent's createSdkOptions
    const sdkOptions = this.createSdkOptions({
      disallowedTools: ['AskUserQuestion', 'EnterPlanMode'],
      mcpServers,
    });

    this.logger.info(
      { chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}), supportedMcpTools },
      'Starting SDK query with message channel'
    );

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
    this.processIterator(iterator).catch((err) => {
      this.logger.error({
        err,
        chatId,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      }, 'Agent loop error');
      this.isSessionActive = false;
    });
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
   */
  private async processIterator(
    iterator: AsyncGenerator<{ parsed: { type: string; content?: string } }>
  ): Promise<void> {
    const chatId = this.boundChatId;
    let iteratorError: Error | null = null;
    let messageCount = 0;

    try {
      for await (const { parsed } of iterator) {
        messageCount++;
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
          this.logger.info({ chatId, content: parsed.content }, 'Result received, turn complete');

          // Record success to reset restart state
          this.restartManager.recordSuccess(chatId);

          if (this.callbacks.onDone) {
            const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
            await this.callbacks.onDone(chatId, threadRoot);
          }
        }
      }
    } catch (error) {
      iteratorError = error as Error;
      this.logger.error({
        err: iteratorError,
        chatId,
        messageCount,
        errorMessage: iteratorError.message,
        errorStack: iteratorError.stack,
        errorName: iteratorError.constructor.name,
        errorCause: iteratorError.cause,
      }, 'Iterator error');

      const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
      await this.callbacks.sendMessage(chatId, `❌ Session error: ${iteratorError.message}`, threadRoot);

      if (this.callbacks.onDone) {
        await this.callbacks.onDone(chatId, threadRoot);
      }
    }

    // Check if this was an explicit close (reset cleared the session)
    const wasExplicitClose = !this.isSessionActive;

    if (wasExplicitClose) {
      this.logger.info({ chatId }, 'Agent loop completed (explicit close)');
      return;
    }

    // Iterator ended without explicit close - this is unexpected
    this.isSessionActive = false;

    // Use RestartManager to decide if we should restart
    const errorMessage = iteratorError?.message ?? 'Unknown error';
    const decision = this.restartManager.shouldRestart(chatId, errorMessage);

    if (!decision.allowed) {
      // Circuit breaker opened - notify user and stop
      this.logger.error(
        { chatId, reason: decision.reason, restartCount: decision.restartCount },
        'Restart blocked by circuit breaker'
      );

      const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
      const blockMessage = decision.reason === 'max_restarts_exceeded'
        ? `🚫 会话多次异常中断，已暂停处理。请发送 /reset 重置会话。\n\n最近错误: ${errorMessage}`
        : `🚫 会话已暂停，请发送 /reset 重置。\n\n原因: ${decision.reason}`;
      await this.callbacks.sendMessage(chatId, blockMessage, threadRoot);
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
   * Clears conversation history and state for this Pilot's bound chatId.
   *
   * @param chatId - Optional chat ID (must match bound chatId if provided)
   */
  reset(chatId?: string): void {
    // Issue #644: If chatId is provided, it must match bound chatId
    if (chatId && chatId !== this.boundChatId) {
      this.logger.warn(
        { boundChatId: this.boundChatId, requestedChatId: chatId },
        'Reset called for different chatId, ignoring'
      );
      return;
    }

    this.logger.info({ chatId: this.boundChatId }, 'Resetting Pilot session');

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
  }

  /**
   * Get the number of active sessions (always 0 or 1 for bound Pilot).
   */
  getActiveSessionCount(): number {
    return this.isSessionActive ? 1 : 0;
  }

  /**
   * Check if this Pilot has an active session.
   */
  hasActiveSession(): boolean {
    return this.isSessionActive;
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
    this.logger.info({ chatId: this.boundChatId }, 'Shutting down Pilot');

    // Mark session as inactive
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
    this.conversationOrchestrator.clearAll();

    // Clear restart states
    this.restartManager.clearAll();

    this.logger.info({ chatId: this.boundChatId }, 'Pilot shutdown complete');
  }
}
