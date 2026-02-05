/**
 * Feishu/Lark bot using WebSocket API.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extractText, Planner, Manager, Worker, AgentDialogueBridge } from '../agent/index.js';
import type { TaskPlanData } from '../agent/dialogue-bridge.js';
import { Config } from '../config/index.js';
import { DEDUPLICATION } from '../config/constants.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import { TaskTracker, type DialogueTaskPlan } from '../utils/task-tracker.js';
import { LongTaskManager } from '../long-task/index.js';
import type { SessionManager } from './session.js';
import { buildTextContent } from './content-builder.js';
import { createLogger } from '../utils/logger.js';
import { handleError, ErrorCategory } from '../utils/error-handler.js';
import * as CommandHandlers from './command-handlers.js';
import type { CommandHandlerContext } from './command-handlers.js';
import { attachmentManager, type FileAttachment } from './attachment-manager.js';
import { downloadFile } from './file-downloader.js';
import { messageHistoryManager } from './message-history.js';

// Temporarily disabled: Markdown detection for rich text messages
// TODO: Re-enable when rich text format is needed again
// function containsMarkdown(text: string): boolean {
//   // Common Markdown patterns in Lark:
//   // Headers: # ## ###
//   // Bold: **text**
//   // Italic: *text* or _text_
//   // Strikethrough: ~~text~~
//   // Inline code: `code`
//   // Code blocks: ```
//   // Links: [text](url)
//   // Images: ![alt](url)
//   // Lists: - item, * item, 1. item
//   // Quotes: > quote
//   // Horizontal rules: --- or ***
//   // Mentions: <at id=...>
//   const markdownPatterns = [
//     /^#{1,6}\s/m,           // Headers
//     /\*\*[^*]+\*\*/,        // Bold
//     /\*[^*]+\*/,            // Italic (single asterisk)
//     /_[^_]+_/m,             // Italic (underscore) - word boundaries to avoid false positives
//     /~~[^~]+~~/,            // Strikethrough
//     /`[^`]+`/,              // Inline code
//     /```/,                  // Code blocks
//     /\[[^\]]+\]\([^)]+\)/,  // Links
//     /!\[[^\]]+\]\([^)]+\)/, // Images
//     /^\s*[-*]\s/m,          // Unordered lists
//     /^\s*\d+\.\s/m,         // Ordered lists
//     /^>\s/m,                // Quotes
//     /^---|^\*{3}/m,         // Horizontal rules
//     /<at[^>]*>/,            // Mentions
//   ];
//
//   return markdownPatterns.some(pattern => pattern.test(text));
// }

/**
 * Feishu/Lark bot using WebSocket.
 */
export class FeishuBot extends EventEmitter {
  readonly appId: string;
  readonly appSecret: string;
  readonly sessionManager: SessionManager;

  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private running = false;
  private logger = createLogger('FeishuBot');

  // Track processed message IDs to prevent duplicate processing
  private processedMessageIds = new Set<string>();
  private readonly MAX_PROCESSED_IDS = DEDUPLICATION.MAX_PROCESSED_IDS;
  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  // Task tracker for persistent deduplication
  private taskTracker: TaskTracker;

  // Active long task managers per chat (one per chat to avoid conflicts)
  private longTaskManagers = new Map<string, LongTaskManager>();

  // Active dialogue bridges per chat
  private activeDialogues = new Map<string, AgentDialogueBridge>();

  constructor(
    appId: string,
    appSecret: string,
    sessionManager: SessionManager
  ) {
    super();
    this.appId = appId;
    this.appSecret = appSecret;
    this.sessionManager = sessionManager;
    this.taskTracker = new TaskTracker();
  }

  /**
   * Get or create Lark HTTP client (for sending messages).
   */
  private getClient(): lark.Client {
    if (!this.client) {
      this.client = new lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
      });
    }
    return this.client;
  }

  /**
   * Send a message to Feishu.
   * Currently using plain text format only (rich text temporarily disabled).
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const client = this.getClient();

    try {
      // Always use plain text format
      // Use content builder utility for consistent message formatting
      const response = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: buildTextContent(text),
        },
      });

      // Track outgoing bot message in history
      // Feishu API returns message_id in response.data.message_id
      const botMessageId = response?.data?.message_id;
      if (botMessageId) {
        messageHistoryManager.addBotMessage(chatId, botMessageId, text);
      }

      // Defensive: Ensure text is valid before substring
      const safeText = text || '';
      const preview = safeText.length > 100 ? `${safeText.substring(0, 100)  }...` : safeText;
      this.logger.debug({ chatId, messageType: 'text', preview, botMessageId }, 'Message sent');
    } catch (error) {
      handleError(error, {
        category: ErrorCategory.API,
        chatId,
        messageType: 'text'
      }, {
        log: true,
        customLogger: this.logger
      });
    }
  }

  /**
   * Send an interactive card message to Feishu.
   * Used for rich content like code diffs, formatted output, etc.
   *
   * @param chatId - Target chat ID
   * @param card - Card JSON structure
   * @param description - Optional description for logging
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    description?: string
  ): Promise<void> {
    const client = this.getClient();

    try {
      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      const desc = description ? ` (${description})` : '';
      this.logger.debug({ chatId, description: desc }, 'Card sent');
    } catch (error) {
      handleError(error, {
        category: ErrorCategory.API,
        chatId,
        description,
        messageType: 'card'
      }, {
        log: true,
        customLogger: this.logger
      });
    }
  }

  /**
   * Send a file to Feishu user as an attachment.
   * Uploads the file and sends it as a file message.
   *
   * @param chatId - Target chat ID
   * @param filePath - Local file path to send
   */
  async sendFileToUser(chatId: string, filePath: string): Promise<void> {
    try {
      const { uploadAndSendFile } = await import('./file-uploader.js');
      const fileSize = await uploadAndSendFile(this.getClient(), filePath, chatId);
      this.logger.info({ chatId, filePath, fileSize }, 'File sent to user');
    } catch (error) {
      this.logger.error({ err: error, filePath, chatId }, 'Failed to send file to user');
      // Don't throw - file sending failure shouldn't break the main flow
    }
  }


  /**
   * Handle the complete task flow: Flow 1 (create Task.md) → Flow 2 (execute dialogue)
   *
   * DESIGN NOTE: Why create new Agent instances for each message?
   *
   * Each user message creates fresh agent instances because:
   * 1. **Isolation**: No cross-contamination between different user requests
   * 2. **Simplicity**: No complex state synchronization needed
   * 3. **Resource Management**: Agents are short-lived, easier to cleanup
   * 4. **Session Management**: SDK handles session persistence via resume parameter
   *
   * The agents themselves are stateless - conversation context is maintained by:
   * - Agent SDK's native session management (via resume parameter)
   * - Task.md file on disk (for task records)
   *
   * This is INTENTIONAL - do not "optimize" by reusing agent instances.
   *
   * NEW FLOW:
   * Flow 1: Planner creates Task.md file
   * Flow 2: Execute dialogue loop with Worker ↔ Manager
   *
   * @param chatId - Feishu chat ID
   * @param text - User's message text
   * @param messageId - Unique message identifier
   * @param sender - Message sender info
   * @returns Accumulated response content
   */
  private async handleTaskFlow(
    chatId: string,
    text: string,
    messageId: string,
    sender?: { sender_type?: string; sender_id?: string }
  ): Promise<string> {
    const agentConfig = Config.getAgentConfig();

    // === FLOW 1: Planner creates Task.md ===
    const taskPath = this.taskTracker.getDialogueTaskPath(messageId);

    const planner = new Planner({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
    });
    await planner.initialize();

    // Set context for Task.md creation
    // Include conversation history from message history manager
    const conversationHistory = messageHistoryManager.getFormattedHistory(chatId, 20); // Last 20 messages

    planner.setTaskContext({
      chatId,
      userId: sender?.sender_id,
      messageId,
      taskPath,
      conversationHistory,
    });

    // Run Planner to create Task.md
    this.logger.info({ messageId, taskPath }, 'Flow 1: Planner creating Task.md');
    for await (const msg of planner.queryStream(text)) {
      this.logger.debug({ content: msg.content }, 'Planner output');
    }
    this.logger.info({ taskPath }, 'Task.md created by Planner');

    // === Send task.md content to user ===
    try {
      const taskContent = await fs.readFile(taskPath, 'utf-8');
      await this.sendMessage(chatId, taskContent);
    } catch (error) {
      this.logger.error({ err: error, taskPath }, 'Failed to read/send task.md');
    }

    // === FLOW 2: Execute dialogue ===
    // Create agents
    const manager = new Manager({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
      permissionMode: 'bypassPermissions',
    });
    await manager.initialize();

    const worker = new Worker({
      apiKey: agentConfig.apiKey,
      model: agentConfig.model,
      apiBaseUrl: agentConfig.apiBaseUrl,
    });
    await worker.initialize();

    // Import MCP tools to set message tracking callback
    const { setMessageSentCallback } = await import('../mcp/feishu-context-mcp.js');

    // Create bridge with task plan callback
    const bridge = new AgentDialogueBridge({
      manager,
      worker,
      onTaskPlanGenerated: async (plan: TaskPlanData) => {
        await this.taskTracker.saveDialogueTaskPlan(plan as DialogueTaskPlan);
      },
    });

    // Set the message sent callback to track when MCP tools send messages
    // This ensures hasUserMessageBeenSent() returns true when agents use send_user_feedback/send_user_card
    setMessageSentCallback((_chatId: string) => {
      bridge.recordUserMessageSent();
    });

    // Store for potential cancellation
    this.activeDialogues.set(chatId, bridge);

    // Create output adapter for this chat
    // Wrap sendMessage to track when user messages are sent
    const adapter = new FeishuOutputAdapter({
      sendMessage: async (id: string, msg: string) => {
        bridge.recordUserMessageSent();  // Track message sending
        return this.sendMessage(id, msg);
      },
      sendCard: async (id: string, card: Record<string, unknown>) => {
        bridge.recordUserMessageSent();  // Track card sending
        return this.sendCard(id, card);
      },
      chatId,
      sendFile: this.sendFileToUser.bind(this, chatId),
    });
    adapter.clearThrottleState();
    adapter.resetMessageTracking();  // Reset tracking for new task

    // Accumulate response content
    const responseChunks: string[] = [];

    // Track completion reason for warning message
    let completionReason = 'unknown';

    try {
      this.logger.debug({ chatId, taskId: path.basename(taskPath, '.md') }, 'Flow 2: Starting dialogue');

      // Run dialogue loop (Flow 2)
      for await (const message of bridge.runDialogue(
        taskPath,
        text,
        chatId,
        messageId  // Each messageId has its own session
      )) {
        const content = typeof message.content === 'string'
          ? message.content
          : extractText(message);

        if (!content) {
          continue;
        }

        responseChunks.push(content);

        // Send to user
        await adapter.write(content, message.messageType ?? 'text', {
          toolName: message.metadata?.toolName as string | undefined,
          toolInputRaw: message.metadata?.toolInputRaw as Record<string, unknown> | undefined,
        });

        // Update completion reason based on message type
        if (message.messageType === 'result') {
          completionReason = 'task_done';
        } else if (message.messageType === 'error') {
          completionReason = 'error';
        }
      }

      const finalResponse = responseChunks.join('\n');

      return finalResponse;
    } catch (error) {
      this.logger.error({ err: error, chatId }, 'Task flow failed');
      completionReason = 'error';

      const enriched = handleError(error, {
        category: ErrorCategory.SDK,
        chatId,
        userMessage: 'Task processing failed. Please try again.'
      }, {
        log: true,
        customLogger: this.logger
      });

      const errorMsg = `❌ ${enriched.userMessage || enriched.message}`;
      await this.sendMessage(chatId, errorMsg);

      return errorMsg;
    } finally {
      // Clean up message tracking callback to prevent memory leaks
      const { setMessageSentCallback } = await import('../mcp/feishu-context-mcp.js');
      setMessageSentCallback(null);

      // Check if no user message was sent and send warning
      if (!bridge.hasUserMessageBeenSent()) {
        const taskId = path.basename(taskPath, '.md');
        const warning = bridge.buildNoMessageWarning(completionReason, taskId);
        this.logger.info({ chatId, completionReason }, 'Sending no-message warning to user');
        await this.sendMessage(chatId, warning);
      }

      // Clean up bridge reference
      this.activeDialogues.delete(chatId);
    }
  }

  /**
   * Handle /long command - start long task workflow.
   */
  private async handleLongTask(
    chatId: string,
    userRequest: string,
    _messageId?: string
  ): Promise<void> {
    try {
      // Get agent configuration
      const agentConfig = Config.getAgentConfig();

      // Create or get long task manager for this chat
      let taskManager = this.longTaskManagers.get(chatId);

      if (taskManager) {
        await this.sendMessage(
          chatId,
          '⚠️ A long task is already running in this chat. Please wait for it to complete or use /cancel to stop it.'
        );
        return;
      }

      // Create new long task manager
      taskManager = new LongTaskManager(
        agentConfig.apiKey,
        agentConfig.model,
        agentConfig.apiBaseUrl,
        {
          workspaceBaseDir: Config.getWorkspaceDir(),
          sendMessage: this.sendMessage.bind(this),
          sendCard: this.sendCard.bind(this),
          chatId,
          apiBaseUrl: agentConfig.apiBaseUrl,
          // Add 24-hour timeout for long tasks
          taskTimeoutMs: 24 * 60 * 60 * 1000,
        }
      );

      // Set manager in map BEFORE starting to prevent race condition
      this.longTaskManagers.set(chatId, taskManager);

      // Start long task workflow (non-blocking)
      taskManager.startLongTask(userRequest)
        .then(() => {
          this.logger.info({ chatId }, 'Long task completed');
        })
        .catch((error) => {
          handleError(error, {
            category: ErrorCategory.SDK,
            chatId,
            userMessage: 'Long task failed'
          }, {
            log: true,
            customLogger: this.logger
          });
        })
        .finally(() => {
          // Clean up manager after completion (only if it's still the same manager)
          const currentManager = this.longTaskManagers.get(chatId);
          if (currentManager === taskManager) {
            this.longTaskManagers.delete(chatId);
          }
        });

    } catch (error) {
      const enriched = handleError(error, {
        category: ErrorCategory.UNKNOWN,
        chatId,
        userMessage: 'Failed to start long task. Please try again.'
      }, {
        log: true,
        customLogger: this.logger
      });

      const errorMsg = `❌ ${enriched.userMessage || enriched.message}`;
      await this.sendMessage(chatId, errorMsg);

      // Clean up manager on error
      this.longTaskManagers.delete(chatId);
    }
  }

  /**
   * Handle image/file message - download and store for later processing.
   */
  private async handleFileMessage(
    chatId: string,
    messageType: string,
    content: any,
    messageId: string,
    _sender?: any
  ): Promise<void> {
    try {
      this.logger.info({ chatId, messageType, messageId }, 'File/image message received');

      // Extract file_key from content based on message type
      let fileKey: string | undefined;
      let fileName: string | undefined;

      if (messageType === 'image') {
        // Image message content: {"image_key":"..."}
        const parsed = JSON.parse(content);
        fileKey = parsed.image_key;
        // Provide default filename with extension for better file handling
        fileName = `image_${fileKey?.substring(0, 8)}.jpg`;
      } else if (messageType === 'file') {
        // File message content: {"file_key":"...","file_name":"..."}
        const parsed = JSON.parse(content);
        fileKey = parsed.file_key;
        fileName = parsed.file_name;
      } else if (messageType === 'media') {
        // Audio/video message
        const parsed = JSON.parse(content);
        fileKey = parsed.file_key || parsed.media_key;
        fileName = parsed.file_name || `media_${fileKey?.substring(0, 8)}.mp4`;
      }

      if (!fileKey) {
        this.logger.warn({ messageType, content }, 'No file_key found in message');
        await this.sendMessage(chatId, '⚠️ Unable to process this file (missing file_key)');
        return;
      }

      // Create attachment metadata
      const attachment: FileAttachment = {
        fileKey,
        fileType: messageType,
        fileName,
        timestamp: Date.now(),
        messageId, // Store messageId for downloading user uploads
      };

      // Download file immediately
      const client = this.getClient();
      try {
        const localPath = await downloadFile(client, fileKey, messageType, fileName, messageId);
        attachment.localPath = localPath;

        // Get file stats
        const stats = await import('./file-downloader.js').then(m => m.getFileStats(localPath));
        if (stats) {
          attachment.fileSize = stats.size;
        }

        // Store attachment
        attachmentManager.addAttachment(chatId, attachment);

        // Send confirmation to user
        const count = attachmentManager.getAttachmentCount(chatId);
        const sizeText = attachment.fileSize
          ? `(${(attachment.fileSize / 1024 / 1024).toFixed(2)} MB)`
          : '';

        // Add local path information if available
        const pathInfo = attachment.localPath
          ? `\n📁 Local path: \`${attachment.localPath}\``
          : '';

        await this.sendMessage(
          chatId,
          `✅ File received: ${attachment.fileName || messageType} ${sizeText}${pathInfo}\n\nPlease send a text command to process this file.\n\nPending files: ${count}`
        );

        this.logger.info({ chatId, fileKey, localPath }, 'File downloaded and stored');

      } catch (downloadError) {
        this.logger.error({ err: downloadError, fileKey }, 'Failed to download file');
        await this.sendMessage(
          chatId,
          '⚠️ Failed to download file. Please try again or contact support.'
        );
        return;
      }

    } catch (error) {
      this.logger.error({ err: error, chatId, messageType }, 'Failed to handle file message');
    }
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: any): Promise<void> {
    if (!this.running) {return;}

    const { message } = data;
    if (!message) {return;}

    const { message_id, chat_id, content, message_type, sender, create_time } = message;

    // Defensive: Validate required fields
    if (!message_id) {
      this.logger.warn('Missing message_id in message');
      return;
    }

    if (!chat_id) {
      this.logger.warn('Missing chat_id in message');
      return;
    }

    if (!content) {
      this.logger.warn('Missing content in message');
      return;
    }

    if (!message_type) {
      this.logger.warn('Missing message_type in message');
      return;
    }

    // Debug: log full message structure
    this.logger.debug({ keys: Object.keys(message), messageId: message_id, createTime: create_time }, 'Message keys');

    // Deduplication: skip already processed messages
    if (message_id) {
      this.logger.debug({ messageId: message_id }, 'Checking deduplication');
      // First check: in-memory cache
      if (this.processedMessageIds.has(message_id)) {
        this.logger.debug({ messageId: message_id }, 'Skipped duplicate message (in-memory)');
        return;
      }

      // Second check: file-based deduplication
      this.logger.debug('Checking file-based deduplication');
      const hasRecord = await this.taskTracker.hasTaskRecord(message_id);
      this.logger.debug({ hasRecord }, 'File-based deduplication result');
      if (hasRecord) {
        this.logger.debug({ messageId: message_id }, 'Skipped duplicate message (file-based)');
        // Add to memory cache to avoid repeated file checks
        this.processedMessageIds.add(message_id);
        return;
      }

      // Add to memory cache
      this.logger.debug('Adding to memory cache');
      this.processedMessageIds.add(message_id);

      // Prevent memory leak - remove old entries when limit is reached
      if (this.processedMessageIds.size > this.MAX_PROCESSED_IDS) {
        const first = this.processedMessageIds.values().next().value;
        if (first) {
          this.processedMessageIds.delete(first);
        }
      }
    }

    this.logger.debug('Checking sender type');
    // CRITICAL: Ignore messages sent by the bot itself
    // When bot sends a message, Feishu may trigger an event for it
    // We must skip these to prevent infinite loops
    if (sender?.sender_type === 'app') {
      this.logger.debug({ senderType: sender.sender_type }, 'Skipped bot message');
      return;
    }

    // Check message age - ignore old messages to prevent delayed processing
    this.logger.debug('Checking message age');
    if (create_time) {
      const currentTime = Date.now();
      const messageAge = currentTime - create_time;
      this.logger.debug({ ageMs: messageAge, maxAgeMs: this.MAX_MESSAGE_AGE }, 'Message age');

      if (messageAge > this.MAX_MESSAGE_AGE) {
        const ageSeconds = Math.floor(messageAge / 1000);
        this.logger.debug({ messageId: message_id, ageSeconds }, 'Skipped old message');
        return;
      }
    }

    this.logger.debug({ messageType: message_type }, 'Checking message type');
    // Handle file/image messages - download and store for later processing
    if (message_type === 'image' || message_type === 'file' || message_type === 'media') {
      await this.handleFileMessage(chat_id, message_type, content, message_id, sender);
      return;
    }

    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      this.logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
      return;
    }

    this.logger.debug('Parsing content');
    // Parse content
    let text = '';
    try {
      // Defensive: Ensure content is valid before parsing
      if (typeof content !== 'string') {
        this.logger.warn({ contentType: typeof content }, 'Invalid content type');
        return;
      }

      const parsed = JSON.parse(content);

      if (message_type === 'text') {
        text = parsed.text?.trim() || '';
      } else if (message_type === 'post') {
        // Extract text from post type (rich text)
        // Post structure: {"title":"","content":[[{"tag":"text","text":"...","style":[]}],...]}
        if (parsed.content && Array.isArray(parsed.content)) {
          // content is a 2D array of text segments
          for (const row of parsed.content) {
            if (Array.isArray(row)) {
              for (const segment of row) {
                if (segment?.tag === 'text' && segment.text) {
                  text += segment.text;
                }
              }
            }
          }
          text = text.trim();
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to parse content');
      return;
    }

    this.logger.debug({ length: text.length }, 'Parsed text');
    if (!text) {
      this.logger.debug('Skipped empty text');
      return;
    }

    this.logger.info({ messageId: message_id, chatId: chat_id, messageType: message_type, textLength: text.length }, 'Message received');

    // Track incoming user message in history
    messageHistoryManager.addUserMessage(chat_id, message_id, text, sender?.sender_id);

    // Save task record BEFORE processing to prevent loss on restart
    // For restart commands, use sync write to ensure record is persisted before process exits
    if (message_id) {
      const metadata = {
        chatId: chat_id,
        senderType: sender?.sender_type,
        senderId: sender?.sender_id,
        text,
        timestamp: create_time || new Date().toISOString(),
      };

      // Check if this is a restart command
      const isRestartCommand = text.toLowerCase().includes('restart') &&
                               text.toLowerCase().includes('pm2');

      if (isRestartCommand) {
        // Use synchronous write for restart commands to ensure record persists before process exits
        this.logger.debug('Restart command detected, using sync write for task record');
        this.taskTracker.saveTaskRecordSync(
          message_id,
          metadata,
          '[Processing...]'
        );
      } else {
        // For normal messages, async write is fine
        await this.taskTracker.saveTaskRecord(
          message_id,
          metadata,
          '[Processing...]'
        );
      }
    }

    // Check for commands
    if (CommandHandlers.isCommand(text)) {
      const commandContext: CommandHandlerContext = {
        chatId: chat_id,
        sendMessage: this.sendMessage.bind(this),
        sessionManager: this.sessionManager,
        longTaskManagers: this.longTaskManagers,
      };

      // Handle special case for /long command (needs additional logic)
      if (text.trim().startsWith('/long ')) {
        const longTaskText = text.trim().substring(6).trim();
        await CommandHandlers.handleLongTaskCommand(commandContext, longTaskText);

        if (longTaskText) {
          // Proceed with long task setup
          await this.handleLongTask(chat_id, longTaskText, message_id);
        }
        return;
      }

      // Handle all other commands
      const handled = await CommandHandlers.executeCommand(commandContext, text);
      if (handled) {
        return;
      }
    }

    {
      // NEW: All non-command messages use Flow 1 → Flow 2 (task flow)
      // Note: handleTaskFlow already creates Task.md via Planner,
      // so we don't use saveTaskRecord here to avoid overwriting it with old format
      await this.handleTaskFlow(
        chat_id,
        text,
        message_id,
        sender
      );

      // Task.md is already created by Planner in handleTaskFlow
      // No need to save separate task record - the Task.md file serves as the record
    }
  }

  /**
   * Start Feishu WebSocket bot.
   */
  async start(): Promise<void> {
    this.running = true;
    const agentConfig = Config.getAgentConfig();
    this.logger.info({ model: agentConfig.model }, 'Feishu bot starting');

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this.handleMessageReceive(data);
        } catch (error) {
          this.logger.error({ err: error }, 'Failed to handle message receive');
        }
      },
      // Suppress warnings for unhandled events
      'im.message.message_read_v1': async () => {
        // Silently ignore message read events
      },
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {
        // Silently ignore bot p2p chat entered events
      },
    });

    // Create WebSocket client
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    // Start WebSocket connection
    await this.wsClient.start({
      eventDispatcher: this.eventDispatcher,
    });

    this.logger.info('Feishu WebSocket bot started');

    // Handle shutdown
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Stop bot.
   */
  stop(): void {
    this.running = false;
    this.wsClient = undefined;
    this.logger.info('Feishu bot stopped');
  }
}
