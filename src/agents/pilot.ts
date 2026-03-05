/**
 * Pilot - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Issue #644: Refactored to ensure complete isolation between chat sessions.
 * Each Pilot instance is bound to a single chatId at construction time.
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
 * - Pilot: Orchestration, callbacks, and main logic flow
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration building
 * - Iterator timeout handling
 * - GLM logging
 * - Error handling
 */

import type { StreamingUserMessage, QueryHandle } from '../sdk/index.js';
import { Config } from '../config/index.js';
import { createFeishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';
import type { ChatAgent, UserInput } from './types.js';
import type { AgentMessage } from '../types/agent.js';
import type { FileRef } from '../file-transfer/types.js';
import type { ChannelCapabilities } from '../channels/types.js';
import { MessageChannel } from './message-channel.js';
import { RestartManager } from './restart-manager.js';
import { ConversationOrchestrator } from '../conversation/index.js';

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
}

/**
 * Configuration options for Pilot.
 *
 * Issue #644: Added chatId binding for session isolation.
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
}

/**
 * Message data for processing.
 */
interface MessageData {
  text: string;
  messageId?: string;
  senderOpenId?: string;
  attachments?: FileRef[];
  /** Chat history context for passive mode (Issue #517) */
  chatHistoryContext?: string;
}

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

      // Build the user message
      const enhancedContent = this.buildEnhancedContent({
        text: userInput.content,
        messageId,
        senderOpenId,
      });

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

    // Build enhanced content with context
    const enhancedContent = this.buildEnhancedContent({
      text,
      messageId: messageId ?? `cli-${Date.now()}`,
      senderOpenId,
    });

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
    attachments?: FileRef[],
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
      { chatId, messageId, textLength: text.length, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext },
      'processMessage called'
    );

    // Track thread root
    this.conversationOrchestrator.setThreadRoot(chatId, messageId);

    // Start session if needed
    if (!this.isSessionActive) {
      this.logger.info({ chatId }, 'No active session, starting agent loop');
      this.startAgentLoop();
    }

    // Build the user message
    const enhancedContent = this.buildEnhancedContent({ text, messageId, senderOpenId, attachments, chatHistoryContext });

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
   */
  private startAgentLoop(): void {
    const chatId = this.boundChatId;

    // Get channel capabilities for MCP server filtering (Issue #590 Phase 3)
    const capabilities = this.callbacks.getCapabilities?.(chatId);
    const supportedMcpTools = capabilities?.supportedMcpTools;

    // Determine if we should include Feishu MCP server
    const feishuTools = ['send_user_feedback', 'send_file_to_feishu', 'update_card', 'wait_for_interaction'];
    const shouldIncludeFeishuMcp = supportedMcpTools === undefined ||
      feishuTools.some(tool => supportedMcpTools.includes(tool));

    // Add MCP servers
    const mcpServers: Record<string, unknown> = {};

    // Only add Feishu MCP server if channel supports any Feishu tools
    if (shouldIncludeFeishuMcp) {
      mcpServers['feishu-context'] = createFeishuSdkMcpServer();
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
   * Build enhanced content with Feishu context.
   *
   * Uses boundChatId for context (Issue #644).
   */
  private buildEnhancedContent(msg: MessageData): string {
    const chatId = this.boundChatId;

    // Check if this is a skill command (starts with /)
    const isSkillCommand = msg.text.trimStart().startsWith('/');

    // Get channel capabilities (Issue #582)
    const capabilities = this.callbacks.getCapabilities?.(chatId);

    // Build chat history section if available (Issue #517)
    const chatHistorySection = msg.chatHistoryContext
      ? `

---

## Recent Chat History

You were @mentioned in a group chat. Here's the recent conversation context:

${msg.chatHistoryContext}

---
`
      : '';

    if (isSkillCommand) {
      // For skill commands: command first, then minimal context for skill to use
      const contextInfo = msg.senderOpenId
        ? `

---
**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
**Sender Open ID:** ${msg.senderOpenId}${this.buildAttachmentsInfo(msg.attachments)}`
        : `

---
**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}${this.buildAttachmentsInfo(msg.attachments)}`;

      return `${msg.text}${contextInfo}`;
    }

    // Build capability-aware tools section (Issue #582)
    const toolsSection = this.buildToolsSection(chatId, msg.messageId || '', capabilities, msg.senderOpenId);

    // For regular messages: context FIRST, then user message
    if (msg.senderOpenId) {
      const mentionSection = capabilities?.supportsMention !== false
        ? `

## @ Mention the User

To notify the user in your FINAL response, use:
\`\`\`
<at user_id="${msg.senderOpenId}">@用户</at>
\`\`\`

**Rules:**
- Use @ ONLY in your **final/complete response**, NOT in intermediate messages
- This triggers a Feishu notification to the user`
        : '';

      return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
**Sender Open ID:** ${msg.senderOpenId}
${chatHistorySection}${mentionSection}

---

## Tools
${toolsSection}

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
    }

    return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
${chatHistorySection}
## Tools
${toolsSection}

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
  }

  /**
   * Build capability-aware tools section for the prompt.
   */
  private buildToolsSection(
    chatId: string,
    messageId: string,
    capabilities?: ChannelCapabilities,
    _senderOpenId?: string
  ): string {
    const parts: string[] = [];
    const supportedTools = capabilities?.supportedMcpTools;

    // If supportedMcpTools is defined, use it for dynamic tool filtering
    const hasTool = (toolName: string): boolean => {
      if (supportedTools === undefined) {
        // Legacy behavior: check individual capability flags
        if (toolName === 'send_file_to_feishu') {
          return capabilities?.supportsFile !== false;
        }
        if (toolName === 'update_card' || toolName === 'wait_for_interaction') {
          return capabilities?.supportsCard !== false;
        }
        return true; // send_user_feedback is always available
      }
      return supportedTools.includes(toolName);
    };

    // send_user_feedback tool
    if (hasTool('send_user_feedback')) {
      parts.push(`When using send_user_feedback, use:
- Chat ID: \`${chatId}\`
- parentMessageId: \`${messageId}\` (for thread replies)`);

      // Include card support note if supported
      if (hasTool('update_card') || hasTool('wait_for_interaction')) {
        parts.push(`
- For rich content, use format: "card" with a valid Feishu card structure`);
      } else {
        parts.push(`
- Note: This channel does not support interactive cards. Use text format only.`);
      }
    }

    // send_file_to_feishu tool
    if (hasTool('send_file_to_feishu')) {
      parts.push(`
- send_file_to_feishu is available for sending files`);
    } else if (supportedTools !== undefined) {
      parts.push(`
- Note: send_file_to_feishu is NOT supported on this channel. Files will not be sent.`);
    }

    // update_card tool
    if (hasTool('update_card')) {
      parts.push(`
- update_card is available for updating existing cards`);
    }

    // wait_for_interaction tool
    if (hasTool('wait_for_interaction')) {
      parts.push(`
- wait_for_interaction is available for waiting for user card interactions`);
    }

    // Include thread support note
    if (capabilities?.supportsThread === false) {
      parts.push(`
- Note: Thread replies are NOT supported on this channel.`);
    }

    return parts.join('\n');
  }

  /**
   * Build attachments info string for the message content.
   */
  private buildAttachmentsInfo(attachments?: FileRef[]): string {
    if (!attachments || attachments.length === 0) {
      return '';
    }

    const attachmentList = attachments
      .map((att, index) => {
        const sizeInfo = att.size ? ` (${(att.size / 1024).toFixed(1)} KB)` : '';
        return `${index + 1}. **${att.fileName}**${sizeInfo}
   - File ID: \`${att.id}\`
   - Local path: \`${att.localPath}\`
   - MIME type: ${att.mimeType || 'unknown'}`;
      })
      .join('\n');

    return `

--- Attachments ---
The user has attached ${attachments.length} file(s). These files have been downloaded to local storage:

${attachmentList}

You can read these files using the Read tool with the local paths above.`;
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
