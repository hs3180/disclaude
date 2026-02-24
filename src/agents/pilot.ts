/**
 * Pilot - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * The Pilot class manages conversational AI interactions using Claude Agent SDK's
 * streaming input mode. It maintains persistent Agent instances per chatId, allowing
 * for context persistence across multiple user messages indefinitely.
 *
 * Key Features:
 * - Streaming Input Mode: Uses SDK's AsyncGenerator-based input for real-time interaction
 * - Per-chatId Agent Instances: Each chatId has its own persistent Agent instance
 * - Message Queue: Messages are queued and processed sequentially per chatId
 * - Persistent Context: Session context persists until manual reset (/reset) or shutdown
 *
 * Architecture:
 * ```
 * User Message → Pilot.processMessage()
 *                    ↓
 *              Get/Create state for chatId
 *                    ↓
 *              Push message to queue
 *                    ↓
 *              Message queued → Generator yields → SDK processes
 *                    ↓
 *              SDK output → Callbacks → Platform (Feishu/CLI)
 * ```
 *
 * Extends BaseAgent to inherit:
 * - SDK configuration building
 * - Iterator timeout handling
 * - GLM logging
 * - Error handling
 */

import type { SDKUserMessage, Query } from '@anthropic-ai/claude-agent-sdk';
import { Config } from '../config/index.js';
import { feishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';
import { taskSkillSdkMcpServer } from '../mcp/task-skill-mcp.js';
import { BaseAgent, type BaseAgentConfig } from './base-agent.js';

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
}

/**
 * Configuration options for Pilot.
 *
 * Note: apiKey, model, apiBaseUrl, and permissionMode are optional.
 * If not provided, they will be fetched from Config.getAgentConfig().
 * This maintains backward compatibility with existing code.
 */
export interface PilotConfig {
  /** API key (if not provided, uses Config.getAgentConfig()) */
  apiKey?: string;
  /** Model identifier (if not provided, uses Config.getAgentConfig()) */
  model?: string;
  /** API base URL (if not provided, uses Config.getAgentConfig()) */
  apiBaseUrl?: string;
  /** Permission mode (default: 'bypassPermissions' for all modes) */
  permissionMode?: 'default' | 'bypassPermissions';
  /**
   * Callback functions for platform-specific operations.
   */
  callbacks: PilotCallbacks;
  /**
   * Whether running in CLI mode (vs Feishu bot mode).
   * CLI mode doesn't need Feishu MCP servers.
   */
  isCliMode?: boolean;
}

/**
 * Queued message waiting to be processed by the Agent.
 */
interface QueuedMessage {
  text: string;
  messageId: string;
  senderOpenId?: string;
}

/**
 * Per-chatId state for managing Agent instances.
 */
interface PerChatIdState {
  /** Message queue for streaming input */
  messageQueue: QueuedMessage[];
  /** Resolver for signaling new messages */
  messageResolver?: (() => void);
  /** SDK Query instance */
  queryInstance?: Query;
  /** Pending Write tool files */
  pendingWriteFiles: Set<string>;
  /** Whether this chatId is closed */
  closed: boolean;
  /** Last activity timestamp */
  lastActivity: number;
  /** Whether the Agent loop has been started */
  started: boolean;
  /** Current thread root message ID for replies (the latest user message) */
  currentThreadRootId?: string;
}

/**
 * Pilot - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Manages conversational AI interactions via streaming SDK queries.
 * Each chatId gets its own persistent Agent instance that maintains
 * conversation context across multiple messages indefinitely.
 *
 * Session context is NOT automatically reset on inactivity - it persists
 * until manually reset via /reset command or application shutdown.
 *
 * Extends BaseAgent to inherit common functionality while adding
 * Pilot-specific features like per-chatId state management.
 */
export class Pilot extends BaseAgent {
  private readonly callbacks: PilotCallbacks;
  private readonly isCliMode: boolean;

  // Per-chatId Agent states
  private states = new Map<string, PerChatIdState>();

  constructor(config: PilotConfig) {
    // Get API config from Config if not provided (backward compatibility)
    const agentConfig = Config.getAgentConfig();

    // Build BaseAgentConfig with required fields
    const baseConfig: BaseAgentConfig = {
      apiKey: config.apiKey || agentConfig.apiKey,
      model: config.model || agentConfig.model,
      apiBaseUrl: config.apiBaseUrl || agentConfig.apiBaseUrl,
      permissionMode: config.permissionMode ?? 'bypassPermissions',
    };

    super(baseConfig);

    this.callbacks = config.callbacks;
    this.isCliMode = config.isCliMode ?? false;
  }

  protected getAgentName(): string {
    return 'Pilot';
  }

  /**
   * Execute a one-shot query (CLI mode).
   *
   * This method is blocking - it waits for the query to complete before returning.
   * Uses direct string prompt instead of streaming input generator.
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
    messageId: string,
    senderOpenId?: string
  ): Promise<void> {
    this.logger.info({ chatId, messageId, textLength: text.length }, 'CLI mode: executing one-shot query');

    // Add MCP servers for task tools
    const mcpServers: Record<string, unknown> = {
      'task-skill': taskSkillSdkMcpServer,
    };

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
      messageId,
      senderOpenId,
    });

    this.logger.info({ chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}) }, 'Starting CLI query with direct prompt');

    // Track pending Write tool files for this execution
    const pendingWriteFiles = new Set<string>();

    try {
      // Use BaseAgent's queryOnce for one-shot query with timeout protection
      for await (const { parsed } of this.queryOnce(enhancedContent, sdkOptions)) {
        // Check for completion - result type means query is done
        if (parsed.type === 'result') {
          this.logger.debug({ chatId, content: parsed.content }, 'CLI query result received, breaking loop');
          break;
        }

        // Track Write tool operations
        const isWriteTool =
          parsed.type === 'tool_use' && parsed.metadata?.toolName === 'Write';

        if (isWriteTool && parsed.metadata?.toolInputRaw) {
          const toolInput = parsed.metadata.toolInputRaw as Record<string, unknown>;
          const filePath =
            (toolInput.file_path || toolInput.filePath) as string | undefined;

          if (filePath) {
            pendingWriteFiles.add(filePath);
            this.logger.debug({ filePath, chatId }, 'Write tool detected');
          }
        }

        // Send file when Write tool completes
        if (parsed.type === 'tool_result' && pendingWriteFiles.size > 0) {
          const filePaths = Array.from(pendingWriteFiles);
          pendingWriteFiles.clear();
          this.logger.debug(
            { fileCount: filePaths.length, chatId },
            'Write tool completed'
          );

          for (const filePath of filePaths) {
            try {
              await this.callbacks.sendFile(chatId, filePath);
              this.logger.info({ filePath, chatId }, 'File sent');
            } catch (error) {
              const err = error as Error;
              this.logger.error({ err, filePath, chatId }, 'Failed to send file');
              await this.callbacks.sendMessage(
                chatId,
                `❌ Failed to send file: ${filePath}`,
                messageId // Use current message as thread root for CLI mode
              );
            }
          }
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
   * This method is non-blocking - it queues the message and returns immediately.
   * The message will be processed by the Agent instance for this chatId.
   *
   * If no Agent state exists for this chatId, one is created automatically.
   * If the Agent loop is not healthy (closed or not started), it will be restarted.
   *
   * @param chatId - Platform-specific chat identifier
   * @param text - User's message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender's open_id for @ mentions
   */
  processMessage(
    chatId: string,
    text: string,
    messageId: string,
    senderOpenId?: string
  ): void {
    this.logger.debug({ chatId, messageId, textLength: text.length }, 'Processing message');

    // Get or create state for this chatId (handles health check and restart)
    const state = this.getOrCreateState(chatId);

    // Update last activity
    state.lastActivity = Date.now();

    // Set this message as the current thread root for replies
    // All bot responses will be threaded to this user message
    state.currentThreadRootId = messageId;
    this.logger.debug({ chatId, messageId }, 'Set current thread root for replies');

    // Push message to the queue
    state.messageQueue.push({ text, messageId, senderOpenId });

    // Log health status for debugging
    if (state.closed || !state.started) {
      this.logger.warn(
        { chatId, closed: state.closed, started: state.started },
        'Loop not healthy, restart triggered by getOrCreateState'
      );
    }

    // Signal the generator that a new message is available
    if (state.messageResolver) {
      state.messageResolver();
    }
  }

  /**
   * Get or create a PerChatIdState for a chatId.
   *
   * Handles three scenarios:
   * 1. Existing state is active → reuse
   * 2. Existing state is not started → start it
   * 3. Existing state is closed → restart (preserve queued messages)
   * 4. No existing state → create new
   */
  private getOrCreateState(chatId: string): PerChatIdState {
    const existing = this.states.get(chatId);

    if (existing) {
      // Already active → reuse
      if (!existing.closed && existing.started) {
        this.logger.debug({ chatId }, 'Reusing existing active state');
        return existing;
      }

      // Exists but not started → start it
      if (!existing.started && !existing.closed) {
        this.logger.info({ chatId }, 'Starting existing idle state');
        this.startAgentLoop(chatId).catch((err) => {
          this.logger.error({ err, chatId }, 'Failed to start Agent loop');
        });
        return existing;
      }

      // Exists but closed → restart (preserve queued messages)
      if (existing.closed) {
        this.logger.info({ chatId }, 'Restarting closed state');
        existing.closed = false;
        existing.started = false;
        this.startAgentLoop(chatId).catch((err) => {
          this.logger.error({ err, chatId }, 'Failed to restart Agent loop');
        });
        return existing;
      }
    }

    // Create new state
    this.logger.info({ chatId }, 'Creating new state');

    const state: PerChatIdState = {
      messageQueue: [],
      messageResolver: undefined,
      queryInstance: undefined,
      pendingWriteFiles: new Set(),
      closed: false,
      lastActivity: Date.now(),
      started: false,
      currentThreadRootId: undefined,
    };

    this.states.set(chatId, state);

    // Start the Agent loop
    this.startAgentLoop(chatId).catch((err) => {
      this.logger.error({ err, chatId }, 'Failed to start Agent loop');
    });

    return state;
  }

  /**
   * Build enhanced content with Feishu context.
   *
   * **IMPORTANT**: For skill commands (messages starting with `/`):
   * - Keep the command at START for SDK skill detection
   * - Append minimal context AFTER the command for skill to extract
   * - Do NOT wrap with system prompt template
   */
  private buildEnhancedContent(chatId: string, msg: QueuedMessage): string {
    // Check if this is a skill command (starts with /)
    const isSkillCommand = msg.text.trimStart().startsWith('/');

    if (isSkillCommand) {
      // For skill commands: command first, then minimal context for skill to use
      const contextInfo = msg.senderOpenId
        ? `

---
**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
**Sender Open ID:** ${msg.senderOpenId}`
        : `

---
**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}`;

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
${msg.text}`;
    }

    return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}

When using send_file_to_feishu or send_user_feedback, use:
- Chat ID: \`${chatId}\`
- parentMessageId: \`${msg.messageId}\` (for thread replies)

--- User Message ---
${msg.text}`;
  }

  /**
   * Message generator for SDK streaming input.
   *
   * This AsyncGenerator yields messages from the queue, waiting
   * for new messages when the queue is empty.
   */
  private async *messageGenerator(chatId: string): AsyncGenerator<SDKUserMessage> {
    const state = this.states.get(chatId);
    if (!state) {
      return;
    }

    while (!state.closed) {
      // Yield all queued messages
      while (state.messageQueue.length > 0) {
        const msg = state.messageQueue.shift();
        if (!msg) {
          break;
        }
        this.logger.debug({ messageId: msg.messageId }, 'Yielding message to Agent');

        // Build user message with context
        const enhancedContent = this.buildEnhancedContent(chatId, msg);

        yield {
          type: 'user',
          message: {
            role: 'user',
            content: enhancedContent,
          },
          parent_tool_use_id: null,
          session_id: '', // Empty string - SDK handles session internally
        };
      }

      // If closed, stop the generator
      if (state.closed) {
        return;
      }

      // Wait for new messages
      await new Promise<void>((resolve) => {
        state.messageResolver = resolve;
      });
      state.messageResolver = undefined;
    }
  }

  /**
   * Main Agent loop - processes SDK messages.
   *
   * On completion or error, the state is marked as restartable (started=false, closed=false)
   * to allow automatic recovery on the next processMessage call.
   * Queued messages are preserved for the next session.
   */
  private async startAgentLoop(chatId: string): Promise<void> {
    const state = this.states.get(chatId);
    if (!state) {
      return;
    }

    // Prevent duplicate starts
    if (state.started) {
      this.logger.warn({ chatId }, 'Agent loop already started');
      return;
    }

    state.started = true;
    state.closed = false;

    // Add MCP servers for task tools
    // Start with internal SDK MCP servers
    const mcpServers: Record<string, unknown> = {
      'task-skill': taskSkillSdkMcpServer,
    };

    // Only add Feishu MCP server if NOT in CLI mode
    // CLI mode doesn't need Feishu integration (no Feishu API calls)
    if (!this.isCliMode) {
      mcpServers['feishu-context'] = feishuSdkMcpServer;
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
      disallowedTools: ['AskUserQuestion'],
      mcpServers,
    });

    this.logger.info({ chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}) }, 'Starting SDK query with streaming input');

    try {
      // Create streaming query using BaseAgent's createQueryStream
      const { query: queryInstance, iterator } = this.createQueryStream(
        this.messageGenerator(chatId),
        sdkOptions
      );
      state.queryInstance = queryInstance;

      // Process SDK messages
      for await (const { parsed } of iterator) {
        if (state.closed) {
          break;
        }

        // Update activity timestamp
        state.lastActivity = Date.now();

        // Track Write tool operations
        const isWriteTool =
          parsed.type === 'tool_use' && parsed.metadata?.toolName === 'Write';

        if (isWriteTool && parsed.metadata?.toolInputRaw) {
          const toolInput = parsed.metadata.toolInputRaw as Record<string, unknown>;
          const filePath =
            (toolInput.file_path || toolInput.filePath) as string | undefined;

          if (filePath) {
            state.pendingWriteFiles.add(filePath);
            this.logger.debug({ filePath, chatId }, 'Write tool detected');
          }
        }

        // Send file when Write tool completes
        if (parsed.type === 'tool_result' && state.pendingWriteFiles.size > 0) {
          const filePaths = Array.from(state.pendingWriteFiles);
          state.pendingWriteFiles.clear();
          this.logger.debug(
            { fileCount: filePaths.length, chatId },
            'Write tool completed'
          );

          for (const filePath of filePaths) {
            try {
              await this.callbacks.sendFile(chatId, filePath);
              this.logger.info({ filePath, chatId }, 'File sent');
            } catch (error) {
              const err = error as Error;
              this.logger.error({ err, filePath, chatId }, 'Failed to send file');
              await this.callbacks.sendMessage(
                chatId,
                `❌ Failed to send file: ${filePath}`,
                state.currentThreadRootId
              );
            }
          }
        }

        // Send message content to callback (with thread support)
        if (parsed.content) {
          await this.callbacks.sendMessage(chatId, parsed.content, state.currentThreadRootId);
        }
      }

      this.logger.info({ chatId }, 'Agent loop completed normally');

      // Mark as restartable instead of deleting - preserve queue for next session
      state.started = false;
      // Keep closed=false to allow restart on next message
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, chatId }, 'Agent loop error');

      await this.callbacks.sendMessage(chatId, `❌ Session error: ${err.message}`, state.currentThreadRootId);

      // Mark as restartable instead of deleting - preserve queue for next session
      state.started = false;
      state.closed = false; // Allow restart
    }
  }

  /**
   * Check if an Agent session is active for a chatId.
   *
   * @param chatId - Platform-specific chat identifier
   * @returns true if a session is active
   */
  hasActiveStream(chatId: string): boolean {
    const state = this.states.get(chatId);
    return state?.started === true && state.closed === false;
  }

  /**
   * Clear all state for a chatId (close session and remove from map).
   *
   * @param chatId - Platform-specific chat identifier
   */
  clearQueue(chatId: string): void {
    const state = this.states.get(chatId);
    if (state) {
      state.closed = true;
      if (state.messageResolver) {
        state.messageResolver();
      }
      if (state.queryInstance) {
        state.queryInstance.close();
      }
    }
    this.states.delete(chatId);
    this.logger.debug({ chatId }, 'State cleared');
  }

  /**
   * Clear all pending files for a chatId.
   *
   * Note: In the new implementation, file tracking is internal to the state.
   * This method is kept for API compatibility.
   *
   * @param chatId - Platform-specific chat identifier
   */
  clearPendingFiles(chatId: string): void {
    const state = this.states.get(chatId);
    if (state) {
      state.pendingWriteFiles.clear();
    }
    this.logger.debug({ chatId }, 'Pending files cleared');
  }

  /**
   * Reset all states (close all and start fresh).
   *
   * This is useful for /reset commands that clear all conversation context.
   */
  resetAll(): void {
    this.logger.info('Resetting all states');

    for (const [, state] of this.states) {
      state.closed = true;
      if (state.messageResolver) {
        state.messageResolver();
      }
      if (state.queryInstance) {
        state.queryInstance.close();
      }
    }

    this.states.clear();
    this.logger.info('All states reset');
  }

  /**
   * Get the number of active states.
   */
  getActiveSessionCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.started && !state.closed) {
        count++;
      }
    }
    return count;
  }

  /**
   * Cleanup resources on shutdown.
   */
  async shutdown(): Promise<void> {
    await Promise.resolve(); // No-op to satisfy linter
    this.logger.info('Shutting down Pilot');

    // Close all states
    for (const [, state] of this.states) {
      state.closed = true;
      if (state.messageResolver) {
        state.messageResolver();
      }
      if (state.queryInstance) {
        state.queryInstance.close();
      }
    }

    this.states.clear();
    this.logger.info('Pilot shutdown complete');
  }
}
