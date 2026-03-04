/**
 * Pilot - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * The Pilot class manages conversational AI interactions using Claude Agent SDK's
 * streaming input mode. It maintains persistent Query instances per chatId, allowing
 * for context persistence across multiple user messages indefinitely.
 *
 * Key Features:
 * - Streaming Input Mode: Uses SDK's streamInput() for real-time message delivery
 * - Per-chatId Query Instances: Each chatId has its own persistent Query instance
 * - Persistent Context: Session context persists until manual reset (/reset) or shutdown
 *
 * Architecture:
 * ```
 * User Message → Pilot.processMessage()
 *                    ↓
 *              SessionManager.getOrCreate()
 *                    ↓
 *              ConversationContext.trackThread()
 *                    ↓
 *              Query.streamInput() → SDK processes
 *                    ↓
 *              SDK output → Callbacks → Platform (Feishu/CLI)
 * ```
 *
 * Separation of Concerns (refactored from #218):
 * - SessionManager: Query and Channel lifecycle management
 * - ConversationContext: Thread root and context tracking
 * - Pilot: Orchestration, callbacks, and main logic flow
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration building
 * - Iterator timeout handling
 * - GLM logging
 * - Error handling
 */

import type { StreamingUserMessage } from '../sdk/index.js';
import { Config } from '../config/index.js';
import { createFeishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';
import type { ChatAgent, UserInput } from './types.js';
import type { AgentMessage } from '../types/agent.js';
import type { FileRef } from '../file-transfer/types.js';
import type { ChannelCapabilities } from '../channels/types.js';
import { MessageChannel } from './message-channel.js';
import { SessionManager } from './session-manager.js';
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
 * Uses ChatAgentConfig for unified configuration structure (Issue #327).
 * Use AgentFactory.createPilot() for convenient instance creation with defaults.
 *
 * Note: The special default value logic from Config.getAgentConfig() has been removed.
 * Callers must provide all required fields, or use AgentFactory which handles defaults.
 */
export interface PilotConfig extends BaseAgentConfig {
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
 * Simplified implementation using SDK's streamInput() for message delivery.
 * Each chatId gets its own persistent Query instance.
 *
 * Refactored to use:
 * - SessionManager for Query/Channel lifecycle
 * - ConversationOrchestrator for conversation management (from #237)
 */
export class Pilot extends BaseAgent implements ChatAgent {
  /** Agent type identifier (Issue #282) */
  readonly type = 'chat' as const;

  /** Agent name for logging */
  readonly name = 'Pilot';

  private readonly callbacks: PilotCallbacks;

  // Separated concerns
  private readonly sessionManager: SessionManager;
  private readonly conversationOrchestrator: ConversationOrchestrator;
  private readonly restartManager: RestartManager;

  constructor(config: PilotConfig) {
    super(config);

    this.callbacks = config.callbacks;

    // Initialize separated managers
    this.sessionManager = new SessionManager({ logger: this.logger });
    this.conversationOrchestrator = new ConversationOrchestrator({ logger: this.logger });
    this.restartManager = new RestartManager({
      logger: this.logger,
      maxRestarts: 3,
      initialBackoffMs: 5000,  // Start with 5 seconds
      maxBackoffMs: 60000,     // Max 1 minute
    });
  }

  protected getAgentName(): string {
    return 'Pilot';
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
    this.logger.debug('Pilot start() called - sessions are created on-demand');
    return Promise.resolve();
  }

  /**
   * Handle streaming user input and yield responses (ChatAgent interface).
   *
   * This method provides a unified interface for processing user messages
   * from an async generator and yielding AgentMessage responses.
   *
   * The UserInput.metadata.chatId is used to route messages to the correct session.
   *
   * @param input - AsyncGenerator yielding UserInput messages
   * @yields AgentMessage responses
   */
  async *handleInput(input: AsyncGenerator<UserInput>): AsyncGenerator<AgentMessage> {
    for await (const userInput of input) {
      const chatId = userInput.metadata?.chatId ?? 'default';
      const messageId = userInput.metadata?.parentMessageId ?? `msg-${Date.now()}`;
      const senderOpenId = userInput.metadata?.fileRefs?.[0]?.name; // Not applicable in this context

      // Track thread root
      this.conversationOrchestrator.setThreadRoot(chatId, messageId);

      // Get or create session
      if (!this.sessionManager.has(chatId)) {
        this.startAgentLoop(chatId);
      }

      // Build the user message
      const enhancedContent = this.buildEnhancedContent(chatId, {
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
      const channel = this.sessionManager.getChannel(chatId);
      if (channel) {
        channel.push(streamingMessage);
      }

      // For now, yield a simple acknowledgment
      // The actual response will come through the iterator callback
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
   * @param chatId - Platform-specific chat identifier
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
    // Note: EnterPlanMode is disabled for Pilot as it's a task dispatch agent
    // that should not proactively enter plan mode (Issue #403)
    const sdkOptions = this.createSdkOptions({
      disallowedTools: ['AskUserQuestion', 'EnterPlanMode'],
      mcpServers,
    });

    // Build enhanced content with context
    const enhancedContent = this.buildEnhancedContent(chatId, {
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
   * If no channel exists for this chatId, one is created automatically via startAgentLoop.
   *
   * @param chatId - Platform-specific chat identifier
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
    this.logger.info(
      { chatId, messageId, textLength: text.length, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext },
      'processMessage called'
    );

    // Track thread root using ConversationContext
    this.conversationOrchestrator.setThreadRoot(chatId, messageId);

    // Get or create session using SessionManager
    if (!this.sessionManager.has(chatId)) {
      this.logger.info({ chatId }, 'No existing session, starting agent loop');
      this.startAgentLoop(chatId);
    }

    // Build the user message
    const enhancedContent = this.buildEnhancedContent(chatId, { text, messageId, senderOpenId, attachments, chatHistoryContext });

    const userMessage: StreamingUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: enhancedContent,
      },
      parent_tool_use_id: null,
      session_id: '',
    };

    // Push message to channel - generator will yield it to SDK
    const channel = this.sessionManager.getChannel(chatId);
    if (channel) {
      channel.push(userMessage);
    } else {
      this.logger.error({ chatId, messageId }, 'No channel found after session creation');
    }
  }

  /**
   * Start the Agent loop for a chatId.
   *
   * Creates a MessageChannel and Query, using the channel's generator for streaming input.
   */
  private startAgentLoop(chatId: string): void {
    // Add MCP servers
    const mcpServers: Record<string, unknown> = {
      'feishu-context': createFeishuSdkMcpServer(),
    };

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
    // Note: EnterPlanMode is disabled for Pilot as it's a task dispatch agent
    // that should not proactively enter plan mode (Issue #403)
    const sdkOptions = this.createSdkOptions({
      disallowedTools: ['AskUserQuestion', 'EnterPlanMode'],
      mcpServers,
    });

    this.logger.info(
      { chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}) },
      'Starting SDK query with message channel'
    );

    // Create message channel for this chatId
    const channel = new MessageChannel();

    // Create streaming query using channel's generator
    const { handle, iterator } = this.createQueryStream(
      channel.generator(),
      sdkOptions
    );

    // Create session using SessionManager
    this.sessionManager.create(chatId, handle, channel);

    // Process SDK messages in background
    this.processIterator(chatId, iterator).catch((err) => {
      this.logger.error({
        err,
        chatId,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      }, 'Agent loop error');
      this.sessionManager.deleteTracking(chatId);
    });
  }

  /**
   * Process the SDK iterator for a chatId.
   *
   * IMPORTANT: This method preserves conversation context by NOT deleting the Query/Channel
   * when the iterator ends unexpectedly. Only explicit close (reset)
   * removes the Query and Channel from the maps.
   *
   * If the iterator ends without explicit close, we use RestartManager to:
   * - Limit consecutive restarts (max 3 by default)
   * - Apply exponential backoff between restarts
   * - Open circuit breaker after max restarts exceeded
   */
  private async processIterator(
    chatId: string,
    iterator: AsyncGenerator<{ parsed: { type: string; content?: string } }>
  ): Promise<void> {
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

    // Check if this was an explicit close (reset removed the session)
    // If session is still tracked, it means the iterator ended unexpectedly
    const wasExplicitClose = !this.sessionManager.has(chatId);

    if (wasExplicitClose) {
      this.logger.info({ chatId }, 'Agent loop completed (explicit close)');
      return;
    }

    // Iterator ended without explicit close - this is unexpected
    // Remove the stale session tracking, then check restart policy
    this.sessionManager.deleteTracking(chatId);

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
    this.startAgentLoop(chatId);
    this.logger.info({ chatId }, 'Agent loop restarted');
  }

  /**
   * Build enhanced content with Feishu context.
   *
   * **IMPORTANT**: For skill commands (messages starting with `/`):
   * - Keep the command at START for SDK skill detection
   * - Append minimal context AFTER the command for skill to extract
   * - Do NOT wrap with system prompt template
   *
   * **Capability-aware**: Adjusts available tools based on channel capabilities (Issue #582).
   */
  private buildEnhancedContent(chatId: string, msg: MessageData): string {
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

    // Build suggestions section if enabled (Issue #470)
    const suggestionsSection = this.buildSuggestionsSection();

    // For regular messages: context FIRST, then user message
    if (msg.senderOpenId) {
      const mentionSection = capabilities?.supportsMention !== false
        ? `

---

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
${toolsSection}${suggestionsSection}

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
    }

    return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
${chatHistorySection}
## Tools
${toolsSection}${suggestionsSection}

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
  }

  /**
   * Build capability-aware tools section for the prompt.
   * Adjusts available tools based on channel capabilities (Issue #582).
   *
   * @param chatId - Chat ID for tool usage
   * @param messageId - Message ID for thread replies
   * @param capabilities - Channel capabilities (optional, defaults to all enabled)
   * @param _senderOpenId - Optional sender Open ID for mentions
   * @returns Tools section string for the prompt
   */
  private buildToolsSection(
    chatId: string,
    messageId: string,
    capabilities?: ChannelCapabilities,
    _senderOpenId?: string
  ): string {
    const parts: string[] = [];

    // Always include send_user_feedback (text format)
    parts.push(`When using send_user_feedback, use:
- Chat ID: \`${chatId}\`
- parentMessageId: \`${messageId}\` (for thread replies)`);

    // Include card support note if supported
    if (capabilities?.supportsCard !== false) {
      parts.push(`
- For rich content, use format: "card" with a valid Feishu card structure`);
    } else {
      parts.push(`
- Note: This channel does not support interactive cards. Use text format only.`);
    }

    // Include file support if supported
    if (capabilities?.supportsFile !== false) {
      parts.push(`
- send_file_to_feishu is available for sending files`);
    } else {
      parts.push(`
- Note: send_file_to_feishu is NOT supported on this channel. Files will not be sent.`);
    }

    // Include thread support note
    if (capabilities?.supportsThread === false) {
      parts.push(`
- Note: Thread replies are NOT supported on this channel.`);
    }

    return parts.join('\n');
  }

  /**
   * Build suggestions section for the prompt.
   * When enabled, Agent will suggest follow-up actions after completing a task.
   * @see Issue #470
   *
   * @returns Suggestions section string for the prompt, or empty string if disabled
   */
  private buildSuggestionsSection(): string {
    const suggestionsConfig = Config.getSuggestionsConfig();

    if (!suggestionsConfig.enabled) {
      return '';
    }

    const maxSuggestions = suggestionsConfig.maxSuggestions ?? 4;

    return `

---

## Task Completion Suggestions

After completing the user's task, suggest ${maxSuggestions} relevant follow-up actions based on:
- The task you just completed
- The context of the conversation
- What would be most helpful for the user

Format your suggestions at the end of your response:

\`\`\`
─────────────
💡 接下来你可以：

1. [emoji] [操作描述]
2. [emoji] [操作描述]
3. [emoji] [操作描述]
4. [emoji] [操作描述]
\`\`\`

**Guidelines:**
- Analyze the task context to generate relevant suggestions
- Each suggestion should be actionable and specific
- Use appropriate emojis for visual clarity
- Maximum ${maxSuggestions} suggestions
- Only show suggestions after completing a meaningful task, not for simple queries`;
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
   * Reset all agent sessions (ChatAgent interface).
   *
   * Clears all conversation history and state across all sessions.
   * For resetting a specific session, use resetSession(chatId).
   */
  reset(): void {
    this.logger.info('Resetting all Pilot sessions');

    // Close all sessions
    this.sessionManager.closeAll();

    // Clear all conversation context
    this.conversationOrchestrator.clearAll();

    // Clear all restart states
    this.restartManager.clearAll();
  }

  /**
   * Reset state for a specific chatId (close session and remove from map).
   *
   * This is useful for /reset commands that clear conversation context for a specific chat.
   *
   * IMPORTANT: Deletes session from tracking BEFORE closing, so processIterator
   * can distinguish explicit close from unexpected iterator end.
   *
   * @param chatId - Platform-specific chat identifier
   */
  resetSession(chatId: string): void {
    // Delete session (this closes channel and query)
    const deleted = this.sessionManager.delete(chatId);

    // Reset restart state
    this.restartManager.reset(chatId);

    if (deleted) {
      // Also clear thread root
      this.conversationOrchestrator.deleteThreadRoot(chatId);
      this.logger.info({ chatId }, 'State reset for chatId');
    } else {
      this.logger.debug({ chatId }, 'No state to reset for chatId');
    }
  }

  /**
   * Get the number of active sessions.
   */
  getActiveSessionCount(): number {
    return this.sessionManager.size();
  }

  /**
   * Dispose of resources held by this agent.
   *
   * Implements Disposable interface (Issue #328).
   * Called when agent is no longer needed. Delegates to shutdown().
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
    this.logger.info('Shutting down Pilot');

    // Close all sessions via SessionManager
    this.sessionManager.closeAll();

    // Clear all context via ConversationContext
    this.conversationOrchestrator.clearAll();

    // Clear restart states
    this.restartManager.clearAll();

    this.logger.info('Pilot shutdown complete');
  }
}
