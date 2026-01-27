/**
 * Feishu/Lark bot using WebSocket API.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import { AgentClient } from '../agent/client.js';
import { Config } from '../config/index.js';
import { FeishuOutputAdapter } from '../utils/output-adapter.js';
import type { SessionManager } from './session.js';

/**
 * Escape text for Lark JSON content format.
 * We use JSON.stringify which handles all escaping correctly.
 */

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
   * JSON.stringify handles all necessary escaping.
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const client = this.getClient();

    try {
      await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      console.log(`[Sent] chat_id: ${chatId}`);
    } catch (error) {
      console.error(`Failed to send message to ${chatId}:`, error);
    }
  }

  /**
   * Process agent message with streaming response.
   * Each message is sent immediately without accumulation.
   */
  async processAgentMessage(chatId: string, prompt: string): Promise<void> {
    // Get previous session
    const sessionId = await this.sessionManager.getSessionId(chatId);

    // Create output adapter for this chat
    const adapter = new FeishuOutputAdapter({
      sendMessage: this.sendMessage.bind(this),
      chatId,
    });

    // Clear throttle state for this chat
    adapter.clearThrottleState();

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

        // Use adapter to write message
        await adapter.write(content, message.messageType ?? 'text');
      }
    } catch (error) {
      console.error(`Agent error for chat ${chatId}:`, error);
      await this.sendMessage(
        chatId,
        `❌ Error: ${error instanceof Error ? error.message : String(error)}`
      );
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

    // Debug: log full message structure
    console.log(`[Debug] message keys:`, Object.keys(message));
    console.log(`[Debug] message_id: ${message_id}, create_time: ${create_time}`);

    // Deduplication: skip already processed messages
    if (message_id) {
      if (this.processedMessageIds.has(message_id)) {
        console.log(`[Skipped duplicate] message_id: ${message_id}`);
        return;
      }
      this.processedMessageIds.add(message_id);

      // Prevent memory leak - remove old entries when limit is reached
      if (this.processedMessageIds.size > this.MAX_PROCESSED_IDS) {
        const first = this.processedMessageIds.values().next().value;
        if (first) {
          this.processedMessageIds.delete(first);
        }
      }
    }

    // CRITICAL: Ignore messages sent by the bot itself
    // When bot sends a message, Feishu may trigger an event for it
    // We must skip these to prevent infinite loops
    if (sender?.sender_type === 'app') {
      console.log(`[Skipped bot message] sender_type: ${sender.sender_type}`);
      return;
    }

    console.log(`[Received] message_id: ${message_id}, chat_id: ${chat_id}, type: ${message_type}`);

    // Only handle text messages
    if (message_type !== 'text') return;

    // Parse content
    let text = '';
    try {
      const parsed = JSON.parse(content);
      text = parsed.text?.trim() || '';
    } catch (error) {
      console.error('[Error] Failed to parse content:', error);
      return;
    }

    if (!text) return;

    // All messages are processed by the agent (including slash commands for SDK skills)
    await this.processAgentMessage(chat_id, text);
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
        await this.handleMessageReceive(data);
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
