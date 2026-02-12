/**
 * Feishu/Lark bot using WebSocket API.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import { Config } from '../config/index.js';
import { DEDUPLICATION } from '../config/constants.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { createLogger } from '../utils/logger.js';
import { attachmentManager } from './attachment-manager.js';
import { downloadFile } from './file-downloader.js';
import { messageHistoryManager } from './message-history.js';
import { messageLogger } from './message-logger.js';
import { Pilot } from '../pilot/index.js';
import { FileHandler } from './file-handler.js';
import { MessageSender } from './message-sender.js';
import { TaskFlowOrchestrator } from './task-flow-orchestrator.js';
import { handleGreeting } from '../agents/greeting-executor.js';

/**
 * Feishu/Lark bot using WebSocket.
 */
export class FeishuBot extends EventEmitter {
  readonly appId: string;
  readonly appSecret: string;

  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private running = false;
  private logger = createLogger('FeishuBot');

  // Track processed message IDs to prevent duplicate processing
  // Note: processedMessageIds moved to MessageLogger for deduplication via MD files
  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  // Task tracker for persistent deduplication
  private taskTracker: TaskTracker;

  // File handler for file/image message processing
  private fileHandler: FileHandler;

  // Message sender for sending messages
  private messageSender?: MessageSender;

  // Task flow orchestrator for Scout → Dialogue flow
  private taskFlowOrchestrator: TaskFlowOrchestrator;

  // Pilot instance for direct chat mode
  private pilot: Pilot;

  constructor(
    appId: string,
    appSecret: string
  ) {
    super();
    this.appId = appId;
    this.appSecret = appSecret;
    this.taskTracker = new TaskTracker();

    // Initialize FileHandler with a wrapped downloadFile that will be bound later
    // The client is not available yet, so we pass a placeholder that will be replaced
    this.fileHandler = new FileHandler(
      attachmentManager,
      async (
        fileKey: string,
        messageType: string,
        fileName?: string,
        messageId?: string
      ): Promise<{ success: boolean; filePath?: string }> => {
        if (!this.client) {
          this.logger.error({ fileKey }, 'Client not initialized for file download');
          return { success: false };
        }
        try {
          const filePath = await downloadFile(this.client, fileKey, messageType, fileName, messageId);
          return {
            success: true,
            filePath
          };
        } catch (error) {
          this.logger.error({ err: error, fileKey, messageType }, 'File download failed');
          return { success: false };
        }
      }
    );

    // Initialize TaskFlowOrchestrator
    this.taskFlowOrchestrator = new TaskFlowOrchestrator(
      this.taskTracker,
      {
        sendMessage: this.sendMessage.bind(this),
        sendCard: this.sendCard.bind(this),
        sendFile: this.sendFileToUser.bind(this),
      },
      this.logger
    );

    // Initialize Pilot with Feishu-specific callbacks
    this.pilot = new Pilot({
      callbacks: {
        sendMessage: this.sendMessage.bind(this),
        sendCard: this.sendCard.bind(this),
        sendFile: this.sendFileToUser.bind(this),
      },
    });
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
      // Initialize MessageSender when client is created
      this.messageSender = new MessageSender({
        client: this.client,
        logger: this.logger,
      });
    }
    return this.client;
  }

  /**
   * Send a message to Feishu.
   * Currently using plain text format only (rich text temporarily disabled).
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.messageSender) {
      this.getClient(); // Initialize messageSender
    }
    await this.messageSender!.sendText(chatId, text);
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
    if (!this.messageSender) {
      this.getClient(); // Initialize messageSender
    }
    await this.messageSender!.sendCard(chatId, card, description);
  }

  /**
   * Send a file to Feishu user as an attachment.
   * Uploads the file and sends it as a file message.
   *
   * @param chatId - Target chat ID
   * @param filePath - Local file path to send
   */
  async sendFileToUser(chatId: string, filePath: string): Promise<void> {
    if (!this.messageSender) {
      this.getClient(); // Initialize messageSender
    }
    await this.messageSender!.sendFile(chatId, filePath);
  }


  /**
   * Extract open_id from sender object.
   * Feishu event structure: sender.sender_id.open_id
   *
   * @param sender - Sender object from Feishu event
   * @returns open_id string or undefined
   */
  private extractOpenId(sender?: { sender_type?: string; sender_id?: unknown }): string | undefined {
    if (!sender?.sender_id) {
      return undefined;
    }
    // Feishu event: sender_id is an object containing open_id
    if (typeof sender.sender_id === 'object' && sender.sender_id !== null) {
      const senderId = sender.sender_id as { open_id?: string; union_id?: string; user_id?: string };
      return senderId.open_id;
    }
    // Fallback: if sender_id is a string (legacy format)
    if (typeof sender.sender_id === 'string') {
      return sender.sender_id;
    }
    return undefined;
  }

  /**
   * Handle the complete task flow: Flow 1 (create Task.md) → Flow 2 (execute dialogue)
   *
   * Delegates to TaskFlowOrchestrator for Scout → Dialogue execution.
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
    sender?: { sender_type?: string; sender_id?: { open_id?: string; union_id?: string; user_id?: string } }
  ): Promise<string> {
    const conversationHistory = messageHistoryManager.getFormattedHistory(chatId, 20);

    return this.taskFlowOrchestrator.execute({
      chatId,
      messageId,
      text,
      sender,
      conversationHistory,
    });
  }

  /**
   * Handle direct chat mode - Simple SDK query without Task.md.
   * This is the DEFAULT behavior when no command is given.
   *
   * Key differences from handleTaskFlow:
   * - No Scout agent
   * - No Task.md creation
   * - No Executor/Evaluator dialogue loop
   * - Direct SDK query with session resume
   *
   * This method delegates to the Pilot abstraction for platform-agnostic
   * direct chat functionality.
   *
   * @param chatId - Feishu chat ID
   * @param text - User's message text
   * @param messageId - Unique message identifier for session resume
   * @param sender - Message sender info (contains open_id for @ mentions)
   * @returns Accumulated response content
   */
  private async handleDirectChat(
    chatId: string,
    text: string,
    messageId: string,
    sender?: { sender_type?: string; sender_id?: unknown }
  ): Promise<string> {
    // Clear attachments after processing (they were already notified via buildFileUploadPrompt)
    if (attachmentManager.hasAttachments(chatId)) {
      attachmentManager.clearAttachments(chatId);
      this.logger.debug({ chatId }, 'Attachments cleared after system notification');
    }

    // Extract sender's open_id for @ mention capability
    const senderOpenId = this.extractOpenId(sender);

    // Build enhanced prompt with context
    let enhancedText: string;

    if (senderOpenId) {
      // Include @ mention instructions when we have the user's open_id
      enhancedText = `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Sender Open ID:** ${senderOpenId}

---

## @ Mention the User

To notify the user in your FINAL response, use:
\`\`\`
<at user_id="${senderOpenId}">@用户</at>
\`\`\`

**Rules:**
- Use @ ONLY in your **final/complete response**, NOT in intermediate messages
- This triggers a Feishu notification to the user

---

## Tools

When using send_file_to_feishu or send_user_feedback, use Chat ID: \`${chatId}\`

--- User Message ---
${text}`;
    } else {
      // Fallback: no open_id available
      enhancedText = `You are responding in a Feishu chat.

**Chat ID:** ${chatId}

When using send_file_to_feishu or send_user_feedback, use this Chat ID.

--- User Message ---
${text}`;
    }

    // Delegate to Pilot for streaming chat
    await this.pilot.enqueueMessage(chatId, enhancedText, messageId, senderOpenId);

    return '';
  }

  /**
   * Reset Pilot instance to clear all conversation context.
   *
   * This creates a new Pilot instance, effectively clearing all:
   * - Message queues
   * - Active streams
   * - Session history (via SDK resume)
   *
   * Called when user sends /reset command.
   */
  private resetPilot(): void {
    this.logger.info('Resetting Pilot instance to clear conversation context');

    // Create new Pilot instance with same callbacks
    this.pilot = new Pilot({
      callbacks: {
        sendMessage: this.sendMessage.bind(this),
        sendCard: this.sendCard.bind(this),
        sendFile: this.sendFileToUser.bind(this),
      },
    });

    this.logger.info('Pilot reset complete');
  }

  /**
   * Handle /long command - start long task workflow.
   */

  /**
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: any): Promise<void> {
    if (!this.running) {return;}

    // Ensure client is initialized before processing any message
    // This is critical for file/image downloads which need the client
    this.getClient();

    // Feishu event structure: data.event contains both sender and message
    // See: https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
    const event = data.event || data;
    const { message, sender } = event;

    if (!message) {return;}

    const { message_id, chat_id, content, message_type, create_time } = message;

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

      // Use MessageLogger (all message IDs loaded at startup)
      if (messageLogger.isMessageProcessed(message_id)) {
        this.logger.debug({ messageId: message_id }, 'Skipped duplicate message');
        return;
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
      const result = await this.fileHandler.handleFileMessage(chat_id, message_type, content, message_id);
      if (!result.success) {
        // Send error feedback to user
        await this.sendMessage(
          chat_id,
          `❌ 处理${message_type === 'image' ? '图片' : '文件'}失败：无法从飞书下载文件。这可能是因为文件已过期或权限不足。`
        );
        return;
      }

      // File downloaded successfully - notify Pilot with preset prompt
      const attachments = attachmentManager.getAttachments(chat_id);
      if (attachments.length > 0) {
        const latestAttachment = attachments[attachments.length - 1];
        const uploadPrompt = this.fileHandler.buildUploadPrompt(latestAttachment);

        // Add Feishu chat context to the prompt
        const enhancedPrompt = `You are responding in a Feishu chat.

**Chat ID for sending files/messages:** ${chat_id}

When using tools like send_file_to_feishu or send_user_feedback, use this exact Chat ID value.

---- User Message ---
${uploadPrompt}`;

        // Log the file upload to message history (this also marks message as processed)
        await messageLogger.logIncomingMessage(
          message_id,
          sender?.sender_id || 'unknown',
          chat_id,
          `[File uploaded: ${latestAttachment.fileName}]`,
          message_type,
          create_time
        );

        // Enqueue the file upload notification to Pilot
        this.pilot.enqueueMessage(chat_id, enhancedPrompt, message_id);

        this.logger.info({
          chatId: chat_id,
          fileKey: latestAttachment.fileKey,
          fileName: latestAttachment.fileName
        }, 'File upload notification sent to Pilot');
      }

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

    // Log to persistent MD file (replaces in-memory history)
    await messageLogger.logIncomingMessage(
      message_id,
      sender?.sender_id || 'unknown',
      chat_id,
      text,
      message_type,
      create_time
    );

    // Check for greeting messages - provide friendly introduction
    const greetingResponse = handleGreeting(text);
    if (greetingResponse) {
      this.logger.info({ chatId: chat_id }, 'Greeting detected, sending welcome message');
      await this.sendMessage(chat_id, greetingResponse);
      return;
    }

    // Check for /task command (all other commands go to Pilot)
    if (text.trim().startsWith('/task ')) {
      const taskText = text.trim().substring(6).trim();

      // Show usage if no task text provided
      if (!taskText) {
        await this.sendMessage(
          chat_id,
          '⚠️ Usage: `/task <your task description>`\n\nExample: `/task Analyze the authentication system`'
        );
        return;
      }

      // Use task flow (Scout → Task.md → DialogueOrchestrator)
      await this.handleTaskFlow(chat_id, taskText, message_id, sender);
      return;
    }

    // Check for /reset command - clear conversation context
    if (text.trim() === '/reset') {
      this.logger.info({ chatId: chat_id }, 'Reset command triggered');
      await this.resetPilot();
      await this.sendMessage(
        chat_id,
        '✅ **Conversation reset**\n\nA new conversation session has been started. All previous context has been cleared.'
      );
      return;
    }

    // DEFAULT: Direct chat mode (no Task.md, no Scout, just SDK query)
    // All other messages (including any other "commands") go to Pilot
    await this.handleDirectChat(chat_id, text, message_id, sender);
  }

  /**
   * Start Feishu WebSocket bot.
   */
  async start(): Promise<void> {
    this.running = true;
    const agentConfig = Config.getAgentConfig();
    this.logger.info({ model: agentConfig.model }, 'Feishu bot starting');

    // Initialize message logger BEFORE processing any messages
    this.logger.debug('Initializing message logger...');
    await messageLogger.init();
    this.logger.debug('Message logger initialized');

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
