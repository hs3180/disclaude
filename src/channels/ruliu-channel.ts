/**
 * Ruliu Channel Implementation.
 *
 * Handles Ruliu (如流) messaging platform integration via HTTP Webhook.
 * Implements the IChannel interface for unified message handling.
 *
 * Issue #725: Ruliu platform adapter integration
 */

import http from 'node:http';
import { createLogger } from '../utils/logger.js';
import { BaseChannel } from './base-channel.js';
import type {
  ChannelConfig,
  OutgoingMessage,
  ChannelCapabilities,
  IncomingMessage,
} from './types.js';
import {
  RuliuMessageSender,
  type RuliuMessageSenderConfig,
} from '../platforms/ruliu/ruliu-message-sender.js';
import {
  RuliuWebhookHandler,
  type WebhookCallbacks,
} from '../platforms/ruliu/ruliu-webhook-handler.js';
import type { RuliuConfig, RuliuMessageEvent } from '../platforms/ruliu/types.js';

const logger = createLogger('RuliuChannel');

/**
 * Ruliu channel configuration.
 */
export interface RuliuChannelConfig extends ChannelConfig, RuliuConfig {
  /** Server port for webhook (default: 8080) */
  webhookPort?: number;
  /** Server host (default: 0.0.0.0) */
  webhookHost?: string;
  /** Webhook path (default: /webhook/ruliu) */
  webhookPath?: string;
}

/**
 * Ruliu Channel - Handles Ruliu messaging via HTTP Webhook.
 *
 * Features:
 * - HTTP Webhook-based event receiving
 * - Message deduplication
 * - Text and Markdown support
 * - @mention detection
 * - Follow-up mode for conversation context
 */
export class RuliuChannel extends BaseChannel<RuliuChannelConfig> {
  private webhookPort: number;
  private webhookHost: string;
  private webhookPath: string;

  private server?: http.Server;
  private messageSender: RuliuMessageSender;
  private webhookHandler: RuliuWebhookHandler;

  // Message deduplication
  private processedMessages = new Set<string>();
  private readonly maxProcessedMessages = 10000;

  // Follow-up mode tracking
  private followUpChats = new Map<string, number>();
  private readonly followUpWindow: number;

  constructor(config: RuliuChannelConfig) {
    super(config, 'ruliu', 'Ruliu (如流)');

    this.webhookPort = config.webhookPort || 8080;
    this.webhookHost = config.webhookHost || '0.0.0.0';
    this.webhookPath = config.webhookPath || '/webhook/ruliu';
    this.followUpWindow = (config.followUpWindow || 300) * 1000; // Convert to ms

    // Create message sender
    this.messageSender = new RuliuMessageSender({
      config: {
        apiHost: config.apiHost,
        checkToken: config.checkToken,
        encodingAESKey: config.encodingAESKey,
        appKey: config.appKey,
        appSecret: config.appSecret,
        robotName: config.robotName,
        replyMode: config.replyMode,
        followUp: config.followUp,
        followUpWindow: config.followUpWindow,
        watchMentions: config.watchMentions,
      },
      logger,
    } as RuliuMessageSenderConfig);

    // Create webhook handler
    const callbacks: WebhookCallbacks = {
      onMessage: async (event: RuliuMessageEvent) => {
        await this.handleMessageEvent(event);
      },
    };

    this.webhookHandler = new RuliuWebhookHandler({
      config: {
        apiHost: config.apiHost,
        checkToken: config.checkToken,
        encodingAESKey: config.encodingAESKey,
        appKey: config.appKey,
        appSecret: config.appSecret,
        robotName: config.robotName,
        replyMode: config.replyMode,
      },
      logger,
      callbacks,
    });

    logger.info({ id: this.id, port: this.webhookPort }, 'RuliuChannel created');
  }

  protected doStart(): Promise<void> {
    // Create HTTP server for webhook
    this.server = http.createServer((req, res) => {
      this.handleWebhookRequest(req, res).catch((error) => {
        logger.error({ err: error }, 'Failed to handle webhook request');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
      });
    });

    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Server not created'));
        return;
      }
      this.server.listen(this.webhookPort, this.webhookHost, () => {
        logger.info(
          { port: this.webhookPort, host: this.webhookHost, path: this.webhookPath },
          'RuliuChannel webhook server started'
        );
        resolve();
      });

      this.server.on('error', (error) => {
        logger.error({ err: error }, 'Failed to start webhook server');
        reject(error);
      });
    });
  }

  protected doStop(): Promise<void> {
    if (this.server) {
      const serverRef = this.server;
      return new Promise((resolve) => {
        serverRef.close(() => {
          logger.info('RuliuChannel webhook server stopped');
          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    switch (message.type) {
      case 'text':
        await this.messageSender.sendText(
          message.chatId,
          message.text || '',
          message.threadId
        );
        break;
      case 'card':
        await this.messageSender.sendCard(
          message.chatId,
          message.card || {},
          message.description,
          message.threadId
        );
        break;
      case 'file':
        await this.messageSender.sendFile(
          message.chatId,
          message.filePath || '',
          message.threadId
        );
        break;
      case 'done':
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        break;
      default:
        throw new Error(`Unsupported message type: ${(message as { type: string }).type}`);
    }
  }

  protected checkHealth(): boolean {
    return this.server !== undefined && this.server.listening;
  }

  /**
   * Get the capabilities of Ruliu channel.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      supportsCard: false, // Ruliu uses Markdown instead of cards
      supportsThread: true,
      supportsFile: false, // Not fully implemented
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: false,
      supportedMcpTools: ['send_user_feedback'],
    };
  }

  /**
   * Handle incoming webhook request.
   */
  private async handleWebhookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Check path
    if (!req.url?.startsWith(this.webhookPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // Parse query parameters
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const query = {
      signature: url.searchParams.get('signature') || undefined,
      timestamp: url.searchParams.get('timestamp') || undefined,
      nonce: url.searchParams.get('nonce') || undefined,
      msgSignature: url.searchParams.get('msg_signature') || undefined,
    };

    // Read request body
    const body = await this.readRequestBody(req);

    // Handle URL verification (GET request)
    if (req.method === 'GET') {
      const result = await this.webhookHandler.handleUrlVerification(body, query);
      res.writeHead(result.status, { 'Content-Type': 'text/plain' });
      res.end(result.body);
      return;
    }

    // Handle message webhook (POST request)
    if (req.method === 'POST') {
      const result = await this.webhookHandler.handleWebhook(body, query);
      res.writeHead(result.status, { 'Content-Type': 'text/plain' });
      res.end(result.body);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  }

  /**
   * Read request body from incoming message.
   */
  private readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * Handle parsed message event from webhook.
   */
  private async handleMessageEvent(event: RuliuMessageEvent): Promise<void> {
    // Message deduplication
    if (event.messageId && this.processedMessages.has(event.messageId)) {
      logger.debug({ messageId: event.messageId }, 'Skipping duplicate message');
      return;
    }

    // Add to processed set
    if (event.messageId) {
      this.processedMessages.add(event.messageId);
      // Cleanup old messages
      if (this.processedMessages.size > this.maxProcessedMessages) {
        const iterator = this.processedMessages.values();
        for (let i = 0; i < this.maxProcessedMessages / 2; i++) {
          const val = iterator.next().value;
          if (val !== undefined) {
            this.processedMessages.delete(val);
          }
        }
      }
    }

    // Determine chat ID
    const chatId = event.chatType === 'group'
      ? `group_${event.groupId}`
      : `direct_${event.fromuser}`;

    // Check if should respond based on reply mode
    if (!this.shouldRespond(event)) {
      logger.debug(
        { chatId, replyMode: this.config.replyMode },
        'Skipping message based on reply mode'
      );
      return;
    }

    // Update follow-up tracking
    if (this.config.followUp) {
      this.followUpChats.set(chatId, Date.now());
    }

    // Build incoming message
    const incomingMessage: IncomingMessage = {
      chatId,
      userId: event.fromuser,
      content: event.mes,
      messageType: 'text',
      messageId: event.messageId || `ruliu_${Date.now()}`,
      timestamp: event.timestamp ? event.timestamp * 1000 : Date.now(),
      threadId: undefined, // Ruliu thread support would need additional parsing
      attachments: [],
      metadata: {
        platform: 'ruliu',
        chatType: event.chatType,
        wasMentioned: event.wasMentioned,
        senderName: event.senderName,
      },
    };

    // Emit message to handler
    await this.emitMessage(incomingMessage);
  }

  /**
   * Determine if bot should respond based on reply mode.
   */
  private shouldRespond(event: RuliuMessageEvent): boolean {
    const mode = this.config.replyMode || 'mention-and-watch';

    switch (mode) {
      case 'ignore':
        return false;

      case 'record':
        return false; // Only record, don't respond

      case 'mention-only':
        return event.wasMentioned === true;

      case 'mention-and-watch':
        // Respond if mentioned, in watch list, or in follow-up window
        if (event.wasMentioned) {
          return true;
        }

        // Check watch list
        if (this.config.watchMentions?.includes(event.fromuser)) {
          return true;
        }

        // Check follow-up window
        const chatId = event.chatType === 'group'
          ? `group_${event.groupId}`
          : `direct_${event.fromuser}`;
        const lastMessageTime = this.followUpChats.get(chatId);
        if (lastMessageTime && Date.now() - lastMessageTime < this.followUpWindow) {
          return true;
        }

        return false;

      case 'proactive':
        return true;

      default:
        return event.wasMentioned === true;
    }
  }
}
