/**
 * Feishu/Lark bot using WebSocket API.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import { AgentClient } from '../agent/client.js';
import { Config } from '../config/index.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { LongTaskManager } from '../long-task/index.js';
import type { SessionManager } from './session.js';
import { buildTextContent } from './content-builder.js';

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
  readonly agentClient: AgentClient;
  readonly appId: string;
  readonly appSecret: string;
  readonly sessionManager: SessionManager;

  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private running = false;

  // Track processed message IDs to prevent duplicate processing
  private processedMessageIds = new Set<string>();
  private readonly MAX_PROCESSED_IDS = 1000;

  // Ignore messages older than this (milliseconds)
  private readonly MAX_MESSAGE_AGE = 60 * 1000; // 1 minute

  // Task tracker for persistent deduplication
  private taskTracker: TaskTracker;

  // Active long task managers per chat (one per chat to avoid conflicts)
  private longTaskManagers = new Map<string, LongTaskManager>();

  constructor(
    agentClient: AgentClient,
    appId: string,
    appSecret: string,
    sessionManager: SessionManager
  ) {
    super();
    this.agentClient = agentClient;
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
      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: buildTextContent(text),
        },
      });

      // Defensive: Ensure text is valid before substring
      const safeText = text || '';
      const preview = safeText.length > 100 ? safeText.substring(0, 100) + '...' : safeText;
      console.log(`[Sent] chat_id: ${chatId}, type: text, text: ${preview}`);
    } catch (error) {
      console.error(`Failed to send message to ${chatId}:`, error);
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
      console.log(`[Sent] chat_id: ${chatId}, type: interactive${desc}`);
    } catch (error) {
      console.error(`Failed to send card to ${chatId}:`, error);
    }
  }

  /**
   * Process agent message with streaming response.
   * Each message is sent immediately without accumulation.
   * Returns accumulated response content for task persistence.
   * @param messageId - Reserved for future use in task tracking
   */
  async processAgentMessage(
    chatId: string,
    prompt: string,
    _messageId?: string
  ): Promise<string> {
    // Get previous session
    const sessionId = await this.sessionManager.getSessionId(chatId);

    // Create output adapter for this chat with both sendMessage and sendCard
    const adapter = new FeishuOutputAdapter({
      sendMessage: this.sendMessage.bind(this),
      sendCard: this.sendCard.bind(this),
      chatId,
    });

    // Clear throttle state for this chat
    adapter.clearThrottleState();

    // Accumulate response content for task persistence
    const responseChunks: string[] = [];

    try {
      // Stream agent response - send each message immediately
      for await (const message of this.agentClient.queryStream(
        prompt,
        sessionId ?? undefined
      )) {
        const content = typeof message.content === 'string'
          ? message.content
          : this.agentClient.extractText(message);

        if (!content) {
          continue;
        }

        // Accumulate content for task record
        responseChunks.push(content);

        // Use adapter to write message with metadata
        await adapter.write(content, message.messageType ?? 'text', {
          toolName: message.metadata?.toolName as string | undefined,
          toolInputRaw: message.metadata?.toolInputRaw as Record<string, unknown> | undefined,
        });
      }

      // Return accumulated response
      return responseChunks.join('\n');
    } catch (error) {
      const errorMsg = `❌ Error: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`Agent error for chat ${chatId}:`, error);
      await this.sendMessage(chatId, errorMsg);
      return errorMsg;
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
          workspaceBaseDir: process.cwd(), // Use project root as base
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
          console.log(`[LongTask] Completed for chat ${chatId}`);
        })
        .catch((error) => {
          console.error(`[LongTask] Failed for chat ${chatId}:`, error);
        })
        .finally(() => {
          // Clean up manager after completion (only if it's still the same manager)
          const currentManager = this.longTaskManagers.get(chatId);
          if (currentManager === taskManager) {
            this.longTaskManagers.delete(chatId);
          }
        });

    } catch (error) {
      const errorMsg = `❌ Failed to start long task: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[LongTask] Error for chat ${chatId}:`, error);
      await this.sendMessage(chatId, errorMsg);

      // Clean up manager on error
      this.longTaskManagers.delete(chatId);
    }
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: any): Promise<void> {
    if (!this.running) return;

    const { message } = data;
    if (!message) return;

    const { message_id, chat_id, content, message_type, sender, create_time } = message;

    // Defensive: Validate required fields
    if (!message_id) {
      console.error('[Error] Missing message_id in message');
      return;
    }

    if (!chat_id) {
      console.error('[Error] Missing chat_id in message');
      return;
    }

    if (!content) {
      console.error('[Error] Missing content in message');
      return;
    }

    if (!message_type) {
      console.error('[Error] Missing message_type in message');
      return;
    }

    // Debug: log full message structure
    console.log(`[Debug] message keys:`, Object.keys(message));
    console.log(`[Debug] message_id: ${message_id}, create_time: ${create_time}`);

    // Deduplication: skip already processed messages
    if (message_id) {
      console.log(`[Debug] Checking deduplication for message_id: ${message_id}`);
      // First check: in-memory cache
      if (this.processedMessageIds.has(message_id)) {
        console.log(`[Skipped duplicate] message_id: ${message_id} (in-memory)`);
        return;
      }

      // Second check: file-based deduplication
      console.log(`[Debug] Checking file-based deduplication...`);
      const hasRecord = await this.taskTracker.hasTaskRecord(message_id);
      console.log(`[Debug] File-based deduplication result: ${hasRecord}`);
      if (hasRecord) {
        console.log(`[Skipped duplicate] message_id: ${message_id} (file-based)`);
        // Add to memory cache to avoid repeated file checks
        this.processedMessageIds.add(message_id);
        return;
      }

      // Add to memory cache
      console.log(`[Debug] Adding to memory cache...`);
      this.processedMessageIds.add(message_id);

      // Prevent memory leak - remove old entries when limit is reached
      if (this.processedMessageIds.size > this.MAX_PROCESSED_IDS) {
        const first = this.processedMessageIds.values().next().value;
        if (first) {
          this.processedMessageIds.delete(first);
        }
      }
    }

    console.log(`[Debug] Checking sender type...`);
    // CRITICAL: Ignore messages sent by the bot itself
    // When bot sends a message, Feishu may trigger an event for it
    // We must skip these to prevent infinite loops
    if (sender?.sender_type === 'app') {
      console.log(`[Skipped bot message] sender_type: ${sender.sender_type}`);
      return;
    }

    // Check message age - ignore old messages to prevent delayed processing
    console.log(`[Debug] Checking message age...`);
    if (create_time) {
      const currentTime = Date.now();
      const messageAge = currentTime - create_time;
      console.log(`[Debug] Message age: ${messageAge}ms (max: ${this.MAX_MESSAGE_AGE}ms)`);

      if (messageAge > this.MAX_MESSAGE_AGE) {
        const ageSeconds = Math.floor(messageAge / 1000);
        console.log(`[Skipped old message] message_id: ${message_id}, age: ${ageSeconds}s`);
        return;
      }
    }

    console.log(`[Debug] Checking message type: ${message_type}`);
    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      console.log(`[Skipped] unsupported message_type: ${message_type}`);
      return;
    }

    console.log(`[Debug] Parsing content...`);
    // Parse content
    let text = '';
    try {
      // Defensive: Ensure content is valid before parsing
      if (typeof content !== 'string') {
        console.error('[Error] Invalid content type:', typeof content);
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
      console.error('[Error] Failed to parse content:', error);
      return;
    }

    console.log(`[Debug] Parsed text length: ${text.length}`);
    if (!text) {
      console.log(`[Skipped] empty text`);
      return;
    }

    console.log(`[Received] message_id: ${message_id}, chat_id: ${chat_id}, type: ${message_type}, text: ${text}`);

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
        console.log(`[Debug] Restart command detected, using sync write for task record`);
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

    // Check for /long command to trigger long task workflow
    if (text.trim().startsWith('/long ')) {
      const longTaskText = text.trim().substring(6).trim(); // Remove '/long ' prefix
      if (longTaskText) {
        console.log(`[LongTask] Triggered for chat ${chat_id}: ${longTaskText}`);
        await this.handleLongTask(chat_id, longTaskText, message_id);
      } else {
        await this.sendMessage(chat_id, '⚠️ Usage: `/long <your task description>`\n\nExample: `/long Analyze the codebase and create documentation`');
      }
      return; // Return early to avoid normal processing
    }

    // Check for /cancel command to cancel running long task
    if (text.trim() === '/cancel') {
      const taskManager = this.longTaskManagers.get(chat_id);
      if (taskManager) {
        const cancelled = await taskManager.cancelTask(chat_id);
        if (cancelled) {
          // Clean up manager after cancellation
          this.longTaskManagers.delete(chat_id);
        }
      } else {
        await this.sendMessage(chat_id, '⚠️ No long task is currently running in this chat.');
      }
      return; // Return early to avoid normal processing
    }

    // Check for /status command to show running long task status
    if (text.trim() === '/status') {
      const taskManager = this.longTaskManagers.get(chat_id);
      if (taskManager) {
        const activeTasks = taskManager.getActiveTasks();
        if (activeTasks.size > 0) {
          const statusMsg = `📊 **Long Task Status**\n\nActive tasks: ${activeTasks.size}\n\n${Array.from(activeTasks.values()).map(state =>
            `- **${state.plan.title}**\n  Status: ${state.status}\n  Step: ${state.currentStep}/${state.plan.totalSteps}`
          ).join('\n\n')}`;
          await this.sendMessage(chat_id, statusMsg);
        } else {
          await this.sendMessage(chat_id, '⚠️ No long task is currently running.');
        }
      } else {
        await this.sendMessage(chat_id, '⚠️ No long task is currently running in this chat.');
      }
      return; // Return early to avoid normal processing
    }

    {
      // All messages are processed by the agent (including slash commands for SDK skills)
      const response = await this.processAgentMessage(chat_id, text, message_id);

      // Update task record with actual response
      if (message_id) {
        await this.taskTracker.saveTaskRecord(
          message_id,
          {
            chatId: chat_id,
            senderType: sender?.sender_type,
            senderId: sender?.sender_id,
            text,
            timestamp: create_time || new Date().toISOString(),
          },
          response
        );
      }
    }
  }

  /**
   * Start Feishu WebSocket bot.
   */
  async start(): Promise<void> {
    this.running = true;
    const agentConfig = Config.getAgentConfig();
    console.log(`Feishu bot starting (model: ${agentConfig.model})...`);

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this.handleMessageReceive(data);
        } catch (error) {
          console.error('[Error] Failed to handle message receive:', error);
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

    console.log('Feishu WebSocket bot started!');

    // Handle shutdown
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Stop bot.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.wsClient = undefined;
    console.log('Feishu bot stopped.');
  }
}
