/**
 * Pilot - Platform-agnostic direct chat abstraction.
 *
 * The Pilot class handles simple conversational AI interactions without:
 * - Task.md creation (Scout's job)
 * - Command handling (CommandHandlers' job)
 *
 * Instead, Pilot provides:
 * - Message queue management for streaming chats
 * - Persistent coroutine for continuous conversation
 * - Session management via SDK resume parameter
 * - Callback-based output delegation to platform-specific implementations
 *
 * DESIGN PRINCIPLES:
 * - Platform-agnostic: Works with any messaging platform (Feishu, Slack, Discord, etc.)
 * - Queue-based: Supports message queuing for streaming sessions
 * - Persistent: Each messageId maintains its own conversation session via SDK resume
 * - Callback-based: Uses dependency injection for sendMessage/sendCard/sendFile
 *
 * @example
 * ```typescript
 * const pilot = new Pilot({
 *   sendMessage: async (chatId, text) => { ... },
 *   sendCard: async (chatId, card) => { ... },
 *   sendFile: async (chatId, filePath) => { ... },
 * });
 *
 * // Start a conversation
 * await pilot.enqueueMessage(chatId, userMessage, messageId);
 * ```
 */

import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { feishuSdkMcpServer } from '../mcp/feishu-context-mcp.js';

/**
 * Pending message in the chat queue.
 */
interface PendingMessage {
  text: string;
  messageId: string;
  timestamp: number;
  senderOpenId?: string;
}

/**
 * Callback functions for platform-specific operations.
 */
export interface PilotCallbacks {
  /**
   * Send a text message to the user.
   * @param chatId - Platform-specific chat identifier
   * @param text - Message content
   */
  sendMessage: (chatId: string, text: string) => Promise<void>;

  /**
   * Send an interactive card to the user.
   * @param chatId - Platform-specific chat identifier
   * @param card - Card JSON structure
   * @param description - Optional description for logging
   */
  sendCard: (chatId: string, card: Record<string, unknown>, description?: string) => Promise<void>;

  /**
   * Send a file to the user.
   * @param chatId - Platform-specific chat identifier
   * @param filePath - Local file path to send
   */
  sendFile: (chatId: string, filePath: string) => Promise<void>;
}

/**
 * Configuration options for Pilot.
 */
export interface PilotOptions {
  /**
   * Callback functions for platform-specific operations.
   */
  callbacks: PilotCallbacks;
}

/**
 * Pilot - Platform-agnostic direct chat abstraction.
 *
 * Handles simple conversational AI interactions via streaming SDK queries.
 * Each chatId maintains its own persistent coroutine that processes queued messages.
 */
export class Pilot {
  private readonly callbacks: PilotCallbacks;
  private readonly logger = createLogger('Pilot');

  // Per-chatId message queues for streaming sessions
  private chatQueues = new Map<string, PendingMessage[]>();
  private queueReadyCallbacks = new Map<string, () => void>();
  private activeStreams = new Map<string, Promise<void>>();

  // Track pending Write operations to send files after tool completion
  // Map<chatId, Set<filePath>>
  private pendingWriteFiles = new Map<string, Set<string>>();

  constructor(options: PilotOptions) {
    this.callbacks = options.callbacks;
  }

  /**
   * Enqueue a message for processing.
   *
   * This method adds a message to the queue and starts a streaming coroutine
   * if one isn't already running for this chatId.
   *
   * @param chatId - Platform-specific chat identifier
   * @param text - User's message text
   * @param messageId - Unique message identifier for session resume
   * @param senderOpenId - Optional sender's open_id for @ mention on result
   */
  enqueueMessage(
    chatId: string,
    text: string,
    messageId: string,
    senderOpenId?: string
  ): void {
    // Initialize queue for this chatId (if not exists)
    if (!this.chatQueues.has(chatId)) {
      this.chatQueues.set(chatId, []);
    }

    // Add message to queue
    const queue = this.chatQueues.get(chatId)!;
    queue.push({ text, messageId, timestamp: Date.now(), senderOpenId });

    this.logger.debug({
      chatId,
      messageId,
      queueLength: queue.length,
    }, 'Message enqueued');

    // Wake up the waiting generator
    const callback = this.queueReadyCallbacks.get(chatId);
    if (callback) {
      callback();
    }

    // Start streaming processing (if not already running)
    // Coroutine runs forever, does not auto-exit
    if (!this.activeStreams.has(chatId)) {
      this.logger.info({ chatId }, 'Starting new stream for chat');

      const streamPromise = this.runStreamingChat(chatId);
      this.activeStreams.set(chatId, streamPromise);

      // Clean up and allow restart on error
      streamPromise.catch((err) => {
        this.logger.error({ err, chatId }, 'Stream error, stream terminated');

        // Remove from active streams to allow restart on next message
        this.activeStreams.delete(chatId);

        // Also clean up queue callback to prevent memory leak
        this.queueReadyCallbacks.delete(chatId);
      });
    }
  }

  /**
   * Run streaming chat for a specific chatId.
   *
   * This method creates a persistent coroutine that:
   * 1. Waits for messages in the queue
   * 2. Sends them to the SDK
   * 3. Streams responses back to the user via callbacks
   *
   * The coroutine runs forever until an error occurs.
   *
   * @param chatId - Platform-specific chat identifier
   */
  private async runStreamingChat(chatId: string): Promise<void> {
    // Create async generator for SDK use
    // Note: This generator never ends, always waits for new messages
    async function* messageGenerator(
      getQueue: () => PendingMessage[],
      waitForMessage: () => Promise<void>
    ) {
      while (true) {  // Infinite loop, coroutine never exits
        const queue = getQueue();
        if (queue.length > 0) {
          const msg = queue.shift()!;
          yield {
            type: 'user',
            parent_tool_use_id: null,
            session_id: null,
            message: {
              role: 'user',
              content: msg.text,
            },
          } as const;
        } else {
          // Wait for new message when queue is empty, do not exit
          await waitForMessage();
        }
      }
    }

    // Promise that resolves when a new message arrives
    const waitForMessage = () =>
      new Promise<void>(resolve => {
        this.queueReadyCallbacks.set(chatId, resolve);
      });

    const generator = messageGenerator(
      () => this.chatQueues.get(chatId) || [],
      waitForMessage
    );

    // Configure SDK
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { createAgentSdkOptions, parseSDKMessage } = await import('../utils/sdk.js');
    const agentConfig = Config.getAgentConfig();

    const sdkOptions = createAgentSdkOptions({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    });

    // Add Feishu MCP server for send_file_to_feishu tool
    // This provides the file sending capability without overriding allowedTools
    (sdkOptions as any).mcpServers = {
      'feishu-context': feishuSdkMcpServer,
    };

    this.logger.info({ chatId }, 'Starting streaming chat');

    // Start streaming query - runs forever, never ends
    // Type assertion: generator matches SDK input format
    try {
      for await (const message of query({ prompt: generator as any, options: sdkOptions })) {
      const parsed = parseSDKMessage(message);

      // Track Write tool use events - don't send file yet, wait for tool completion
      const isWriteTool = parsed.type === 'tool_use' &&
                         parsed.metadata?.toolName === 'Write';

      if (isWriteTool && parsed.metadata?.toolInputRaw) {
        // Extract file path from tool input (handles both file_path and filePath)
        const toolInput = parsed.metadata.toolInputRaw;
        const filePath = (toolInput as any).file_path || (toolInput as any).filePath;

        if (filePath) {
          // Initialize pending files set for this chatId if not exists
          if (!this.pendingWriteFiles.has(chatId)) {
            this.pendingWriteFiles.set(chatId, new Set());
          }

          // Track this file as pending - will be sent after tool completes
          this.pendingWriteFiles.get(chatId)!.add(filePath);
          this.logger.debug({ filePath, chatId }, 'Write tool detected, file marked as pending');
        }
      }

      // Send file when Write tool completes (tool_result indicates tool completion)
      const isToolComplete = parsed.type === 'tool_result';

      if (isToolComplete) {
        // Get pending files for this chatId
        const pendingFiles = this.pendingWriteFiles.get(chatId);
        if (pendingFiles && pendingFiles.size > 0) {
          this.logger.debug({ pendingFileCount: pendingFiles.size, chatId }, 'Tool completed, sending pending files');

          // Send each pending file
          for (const filePath of pendingFiles) {
            try {
              await this.callbacks.sendFile(chatId, filePath);
              this.logger.info({ filePath, chatId }, 'File sent via Pilot after tool completion');
            } catch (error) {
              this.logger.error({ err: error, filePath, chatId }, 'Failed to send file via Pilot');
            }
          }

          // Clear pending files after sending
          pendingFiles.clear();
        }
      }

      // Send text content (for progress updates, tool notifications, etc.)
      // Note: @ mention is handled by the Agent in its final response via prompt instructions
      if (parsed.content) {
        await this.callbacks.sendMessage(chatId, parsed.content);
      }
    }
    } catch (error) {
      // Handle streaming errors (including 429 quota errors)
      const err = error as Error;
      this.logger.error({
        err,
        chatId,
        message: err.message,
      }, 'Stream query error, terminating coroutine');

      // Re-throw to trigger the catch block in enqueueMessage
      throw error;
    }

    // Theoretically never reaches here, unless a serious error occurs
    this.logger.warn({ chatId }, 'Streaming chat ended unexpectedly');
  }

  /**
   * Check if a streaming session is active for a chatId.
   *
   * @param chatId - Platform-specific chat identifier
   * @returns true if a streaming session is active
   */
  hasActiveStream(chatId: string): boolean {
    return this.activeStreams.has(chatId);
  }

  /**
   * Get the number of pending messages in the queue.
   *
   * @param chatId - Platform-specific chat identifier
   * @returns Number of pending messages
   */
  getQueueLength(chatId: string): number {
    const queue = this.chatQueues.get(chatId);
    return queue ? queue.length : 0;
  }

  /**
   * Clear all pending messages for a chatId.
   *
   * @param chatId - Platform-specific chat identifier
   */
  clearQueue(chatId: string): void {
    this.chatQueues.delete(chatId);
    this.logger.debug({ chatId }, 'Queue cleared');
  }

  /**
   * Clear all pending files for a chatId.
   *
   * @param chatId - Platform-specific chat identifier
   */
  clearPendingFiles(chatId: string): void {
    this.pendingWriteFiles.delete(chatId);
    this.logger.debug({ chatId }, 'Pending files cleared');
  }
}
