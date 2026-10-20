/**
 * WeChat Channel Implementation.
 *
 * WeChat (Tencent ilink) bot integration with:
 * - QR code authentication (ilink/bot/get_bot_qrcode + get_qrcode_status)
 * - Text message sending (ilink/bot/sendmessage)
 * - Message listening via getUpdates long-poll (Issue #1556 Phase 3.1)
 * - Typing indicator (ilink/bot/typing) (Issue #1556 Phase 3.2)
 * - Media handling: image/file sending via CDN upload (Issue #1556 Phase 3.2)
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * Not yet implemented (future phases):
 * - Native threads; iLink replies use private per-peer context instead.
 *
 * @module channels/wechat/wechat-channel
 * @see Issue #1473 - WeChat Channel MVP
 * @see Issue #1556 - WeChat Channel Feature Enhancement
 */

import { createLogger, BaseChannel, type OutgoingMessage, type ChannelCapabilities, type IncomingMessage } from '@disclaude/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import { WeChatMessageListener, type MessageProcessor } from './message-listener.js';
import type { WeChatChannelConfig } from './types.js';
import { WeChatStateStore, type WeChatSessionState } from './state-store.js';
import { wechatChannelId, wechatPeer, lockWeChatIdentity } from './identity.js';
import { downloadWeChatMedia, WECHAT_MEDIA_MAX_BYTES } from './media.js';
import { tmpdir } from 'node:os';

const logger = createLogger('WeChatChannel');

/** Default API base URL for WeChat ilink Bot API. */
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/**
 * WeChat Channel.
 *
 * Provides WeChat (Tencent ilink) bot integration with:
 * - QR code authentication on start
 * - Text message sending
 * - Long-poll message listening
 *
 * Extends BaseChannel for lifecycle management and handler registration.
 */
export class WeChatChannel extends BaseChannel<WeChatChannelConfig> {
  private readonly baseUrl: string;
  private readonly routeTag?: string;
  private client?: WeChatApiClient;
  private auth?: WeChatAuth;
  private messageListener?: WeChatMessageListener;
  private readonly contexts = new Map<string, string>();
  private releaseAccount?: () => Promise<void>;
  private releaseIdentity?: () => Promise<void>;

  constructor(config: WeChatChannelConfig = {}) {
    const id = config.registrationId ? wechatChannelId(config.registrationId) : 'wechat';
    super({ ...config, id }, 'wechat', 'WeChat');
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.routeTag = config.routeTag;
  }

  /**
   * Start the WeChat channel.
   *
   * Flow:
   * 1. Create API client
   * 2. If no pre-configured token, run QR code auth
   * 3. Set token on client
   * 4. Start message listener (Issue #1556 Phase 3.1)
   */
  protected async doStart(): Promise<void> {
    let session: WeChatSessionState | undefined;
    let store: WeChatStateStore | undefined;
    let credentials: Awaited<ReturnType<WeChatStateStore['loadCredentials']>>;
    if (this.config.stateDir) {
      if (this.config.token) { throw new Error('Use saved WeChat login or a programmatic token, not both'); }
      store = new WeChatStateStore(this.config.stateDir);
      this.releaseAccount = await store.lock();
      try {
        credentials = await store.loadCredentials();
        if (!credentials) { throw new Error('No saved WeChat login; run disclaude wechat login with the configured --state-dir'); }
        this.releaseIdentity = await lockWeChatIdentity(credentials.botId);
        session = await store.loadSession(credentials.botId);
        this.contexts.clear();
        for (const [peer, token] of Object.entries(session.contexts)) { this.contexts.set(peer, token); }
      } catch (error) { await this.releaseIdentity?.(); this.releaseIdentity = undefined; await this.releaseAccount(); this.releaseAccount = undefined; throw error; }
    }
    try {
      // Create API client
      this.client = new WeChatApiClient({
        baseUrl: credentials?.baseUrl ?? this.baseUrl,
        token: credentials?.token ?? this.config.token,
        routeTag: this.routeTag,
      });

      // If token is already configured, skip auth
      if (credentials || this.config.token) {
        logger.info('Using pre-configured bot token');
      } else {
        // Run QR code authentication
        this.auth = new WeChatAuth(this.client);

        logger.info('Starting WeChat QR code authentication...');
        const result = await this.auth.authenticate();

        if (!result.success || !result.token) {
          throw new Error(`WeChat authentication failed: ${result.error || 'unknown error'}`);
        }

        this.client.setToken(result.token);
        if (result.baseUrl) { this.client = new WeChatApiClient({ baseUrl: result.baseUrl, token: result.token, routeTag: this.routeTag }); }
        logger.info(
          { botId: result.botId, userId: result.userId },
          'WeChat channel authenticated successfully',
        );
      }

      // Start message listener (Issue #1556 Phase 3.1)
      const processor: MessageProcessor = async (message: IncomingMessage) => {
        // Send typing indicator before processing (Issue #1556 Phase 3.2)
        void this.client?.sendTyping({ to: message.chatId, contextToken: this.contexts.get(message.chatId) });

        await this.emitMessage(this.config.registrationId ? {
          ...message, chatId: `${this.id}:${message.chatId}`, messageId: `${this.id}:${message.messageId}`,
          metadata: { ...message.metadata, channelId: this.id, registrationId: this.config.registrationId },
        } : message);
      };

      this.messageListener = new WeChatMessageListener(this.client, processor, {
        state: session,
        onContext: (peer, token) => this.contexts.set(peer, token),
        resolveAttachment: (item, signal) => downloadWeChatMedia(item, path.join(this.config.stateDir ?? path.join(tmpdir(), 'disclaude-wechat', this.id), 'media'), signal),
        checkpoint: store && session ? async (state) => {
          await store.saveSession({ ...state, botId: session.botId, contexts: Object.fromEntries(this.contexts) });
        } : undefined,
      });
      this.messageListener.start();

      logger.info('WeChat channel started with message listening');
    } catch (error) { await this.releaseIdentity?.(); this.releaseIdentity = undefined; await this.releaseAccount?.(); this.releaseAccount = undefined; throw error; }
  }

  /**
   * Stop the WeChat channel.
   *
   * Stops message listener and aborts any in-progress authentication.
   */
  protected async doStop(): Promise<void> {
    try {
      // Stop message listener first
      if (this.messageListener) {
        await this.messageListener.stop();
        this.messageListener = undefined;
      }

      if (this.auth?.isAuthenticating()) {
        this.auth.abort();
      }
      this.auth = undefined;
      this.client = undefined;
      logger.info('WeChat channel stopped');
    } finally {
      try { await this.releaseIdentity?.(); this.releaseIdentity = undefined; }
      finally { await this.releaseAccount?.(); this.releaseAccount = undefined; }
    }
  }

  /**
   * Send a message through the WeChat channel.
   *
   * Supports text, internal card descriptions, and encrypted image/file delivery.
   * File messages are uploaded to CDN first, then sent via sendImage/sendFile.
   */
  protected async doSendMessage(message: OutgoingMessage): Promise<string | void> {
    if (!this.client) {
      throw new Error('WeChat client not initialized');
    }
    if (message.type === 'done') { return; }
    message = { ...message, chatId: wechatPeer(message.chatId, this.config.registrationId) };
    const contextToken = this.contexts.get(message.chatId);
    if (!contextToken) { throw new Error('No WeChat reply context for this peer; send a message to the bot first'); }

    if (message.mentions?.length) { throw new Error('WeChat mentions are not supported'); }
    const text = message.type === 'text' ? message.text : message.type === 'card' ? message.description : undefined;
    if (text) {
      // Local 4000-byte policy. Iterate code points so emoji/Chinese stay intact.
      const chunks: string[] = []; let chunk = ''; let size = 0;
      for (const char of text) {
        const bytes = Buffer.byteLength(char);
        if (size + bytes > 4000) { chunks.push(chunk); chunk = ''; size = 0; }
        chunk += char; size += bytes;
      }
      if (chunk) { chunks.push(chunk); }
      let sent = 0; let messageId: string | undefined;
      try {
        for (const content of chunks) { messageId = await this.client.sendText({ to: message.chatId, content, contextToken }); sent++; }
      } catch (error) {
        if (sent) { throw new Error(`WeChat delivery failed after ${sent}/${chunks.length} text parts; delivery is partial, verify before retrying`, { cause: error }); }
        throw error;
      }
      return messageId;
    }

    // File sending via CDN upload (Issue #1556 Phase 3.2)
    if (message.type === 'file' && message.filePath) {
      return await this.sendViaCdn(message);
    }

    // Unsupported message types
    throw new Error(`Unsupported or empty WeChat message: ${message.type}`);
  }

  /**
   * Check if the WeChat channel is healthy.
   *
   * Returns true if the client has a valid token and message listener is active.
   */
  protected checkHealth(): boolean {
    return (this.client?.hasToken() ?? false) && this.messageListener?.isHealthy() === true;
  }

  /**
   * Get the capabilities of the WeChat channel.
   *
   * Supports text and file sending. Native cards are unavailable.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      supportsCard: false,
      supportsThread: false,
      supportsFile: true,
      supportsMarkdown: false,
      supportsMention: false,
      supportsUpdate: false,
      supportsStreaming: false,
      supportedChannelTools: ['send_text', 'send_file'],
      nativeVideoFormats: ['mp4'],
    };
  }

  /**
   * Check if this channel owns a given chatId.
   * Only received/persisted iLink peers are owned. Unknown chat IDs never
   * borrow another account or channel's reply context.
   *
   * Issue #3824: Channel ownership query for post-restart routing.
   */
  ownsChatId(chatId: string): boolean {
    try { return this.contexts.has(wechatPeer(chatId, this.config.registrationId)); }
    catch { return false; }
  }

  /**
   * Send a file via CDN upload + sendImage/sendFile.
   *
   * Flow: read file → upload to CDN → send CDN URL as image or file message.
   * Auto-detects image vs file based on file extension.
   */
  private async sendViaCdn(message: OutgoingMessage): Promise<string | void> {
    if (!this.client || !message.filePath) {
      return;
    }

    const { filePath } = message;
    const fileName = path.basename(filePath);

    // Read file from disk
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > WECHAT_MEDIA_MAX_BYTES) { throw new Error('WeChat file must be a regular file no larger than 20 MiB'); }
    const fileData = await fs.promises.readFile(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
    const kind = imageExtensions.has(ext) ? 'image' : ext === '.mp4' ? 'video' : 'file';

    // Upload to CDN
    const uploaded = await this.client.uploadMedia({
      fileData,
      fileName,
      to: message.chatId,
      kind,
    });

    // Auto-detect image vs file by extension
    if (kind === 'image') {
      return await this.client.sendImage({
        to: message.chatId,
        uploaded,
        contextToken: this.contexts.get(message.chatId),
      });
    } else if (kind === 'video') {
      return await this.client.sendVideo({ to: message.chatId, uploaded, contextToken: this.contexts.get(message.chatId) });
    } else {
      return await this.client.sendFile({
        to: message.chatId,
        uploaded,
        fileName,
        contextToken: this.contexts.get(message.chatId),
      });
    }
  }

  /**
   * Get the underlying API client (for testing/debugging).
   */
  getApiClient(): WeChatApiClient | undefined {
    return this.client;
  }

  /**
   * Get the message listener (for testing/debugging).
   */
  getMessageListener(): WeChatMessageListener | undefined {
    return this.messageListener;
  }
}
