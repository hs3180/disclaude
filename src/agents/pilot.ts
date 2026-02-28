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
import type { FileRef } from '../file-transfer/types.js';
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
}

/**
 * Configuration options for Pilot.
 *
 * All configuration fields extend BaseAgentConfig for consistency with other agents.
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
export class Pilot extends BaseAgent {
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
    const sdkOptions = this.createSdkOptions({
      disallowedTools: ['AskUserQuestion'],
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
      this.logger.error({ err, chatId }, 'CLI query error');

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
   */
  processMessage(
    chatId: string,
    text: string,
    messageId: string,
    senderOpenId?: string,
    attachments?: FileRef[]
  ): void {
    this.logger.debug({ chatId, messageId, textLength: text.length, hasAttachments: !!attachments }, 'Processing message');

    // Track thread root using ConversationContext
    this.conversationOrchestrator.setThreadRoot(chatId, messageId);

    // Get or create session using SessionManager
    if (!this.sessionManager.has(chatId)) {
      this.startAgentLoop(chatId);
    }

    // Build the user message
    const enhancedContent = this.buildEnhancedContent(chatId, { text, messageId, senderOpenId, attachments });

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
    const sdkOptions = this.createSdkOptions({
      disallowedTools: ['AskUserQuestion'],
      mcpServers,
    });

    this.logger.info({ chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}) }, 'Starting SDK query with message channel');

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
      this.logger.error({ err, chatId }, 'Agent loop error');
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

    try {
      for await (const { parsed } of iterator) {
        // Send message content to callback
        if (parsed.content) {
          const threadRoot = this.conversationOrchestrator.getThreadRoot(chatId);
          await this.callbacks.sendMessage(chatId, parsed.content, threadRoot);
        }

        // Check for completion
        if (parsed.type === 'result') {
          this.logger.debug({ chatId, content: parsed.content }, 'Result received, turn complete');

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
      this.logger.error({ err: iteratorError, chatId }, 'Iterator error');

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
   */
  private buildEnhancedContent(chatId: string, msg: MessageData): string {
    // Check if this is a skill command (starts with /)
    const isSkillCommand = msg.text.trimStart().startsWith('/');

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

    // For regular messages: context FIRST, then user message
    if (msg.senderOpenId) {
      return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
**Sender Open ID:** ${msg.senderOpenId}

---

## @ Mention the User

To notify the user in your FINAL response, use:
\`\`\`
<at user_id="${msg.senderOpenId}">@用户</at>
\`\`\`

**Rules:**
- Use @ ONLY in your **final/complete response**, NOT in intermediate messages
- This triggers a Feishu notification to the user

---

## Tools

When using send_file_to_feishu or send_user_feedback, use:
- Chat ID: \`${chatId}\`
- parentMessageId: \`${msg.messageId}\` (for thread replies)

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
    }

    return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}

When using send_file_to_feishu or send_user_feedback, use:
- Chat ID: \`${chatId}\`
- parentMessageId: \`${msg.messageId}\` (for thread replies)

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
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
   * Reset state for a specific chatId (close session and remove from map).
   *
   * This is useful for /reset commands that clear conversation context for a specific chat.
   *
   * IMPORTANT: Deletes session from tracking BEFORE closing, so processIterator
   * can distinguish explicit close from unexpected iterator end.
   *
   * @param chatId - Platform-specific chat identifier
   */
  reset(chatId: string): void {
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
