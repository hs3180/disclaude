/**
 * UnifiedMessageRouter - Unified message routing architecture.
 *
 * Merges FeedbackRouter and MessageRouter functionality:
 * - Routes messages based on type and level
 * - Supports admin chat for debug/progress messages
 * - Handles feedback messages (text, card, file, done, error)
 *
 * Routing Rules (Issue #659, Issue #675):
 * ```
 * Message Type          →    Target Channel
 * ────────────────────────────────────────────
 * text/result/complete  →    admin + user chat
 * card/file             →    admin + user chat
 * error/critical        →    admin + user chat
 * debug/progress        →    admin chat only
 * done                  →    admin + user chat (triggers onTaskDone)
 * ```
 *
 * Note: Admin chat receives ALL messages for system monitoring (Issue #675).
 *
 * Architecture:
 * ```
 * ExecutionNode → UnifiedMessageRouter → Channels
 *                      ↓
 *             (level-based routing)
 *                      ↓
 *         ┌───────────┴───────────┐
 *         ↓                       ↓
 *    Admin Chat              User Chat
 * ```
 *
 * @see Issue #659
 * @module nodes/unified-message-router
 */

import { createLogger } from '../utils/logger.js';
import type { IChannel, OutgoingMessage } from '../channels/index.js';
import type { FeedbackMessage } from '../types/websocket-messages.js';
import type { FileStorageService } from '../file-transfer/node-transfer/file-storage.js';
import { MessageLevel, DEFAULT_USER_LEVELS, type MessageRouteConfig } from '../messaging/types.js';

const logger = createLogger('UnifiedMessageRouter');

/**
 * Message type for routing decisions.
 * Extends FeedbackMessage types with level-based routing.
 */
export type UnifiedMessageType = 'text' | 'card' | 'file' | 'done' | 'error' | 'debug' | 'progress';

/**
 * Configuration for UnifiedMessageRouter.
 */
export interface UnifiedMessageRouterConfig {
  /** File storage service for file handling */
  fileStorageService?: FileStorageService;
  /** Function to send file to user */
  sendFileToUser: (chatId: string, filePath: string, threadId?: string) => Promise<void>;
  /**
   * Callback when task completes (done event).
   * Used to trigger follow-up actions like next-step recommendations.
   */
  onTaskDone?: (chatId: string, threadId?: string) => Promise<void>;
  /**
   * Admin chat ID for debug/progress messages.
   * If not set, debug/progress messages are not sent.
   */
  adminChatId?: string;
  /**
   * Message levels visible to user chat.
   * Default: notice, important, error, result
   */
  userMessageLevels?: MessageLevel[];
}

/**
 * Routing decision for a message.
 */
interface RoutingDecision {
  /** Send to admin chat */
  toAdmin: boolean;
  /** Send to user chat */
  toUser: boolean;
  /** Message level (for logging) */
  level: MessageLevel;
}

/**
 * UnifiedMessageRouter - Unified message routing with level-based targeting.
 *
 * This class merges the functionality of FeedbackRouter and MessageRouter:
 * - Handles all feedback message types (text, card, file, done, error)
 * - Routes messages based on type/level to appropriate targets
 * - Supports admin chat for debug/progress messages
 * - Broadcasts to registered channels based on routing rules
 *
 * @example
 * ```typescript
 * const router = new UnifiedMessageRouter({
 *   sendFileToUser: async (chatId, filePath, threadId) => { ... },
 *   adminChatId: 'oc_admin_chat',
 *   onTaskDone: async (chatId, threadId) => { ... },
 * });
 *
 * router.registerChannel(feishuChannel);
 *
 * // Route a text message (goes to user chat)
 * await router.handleFeedback({
 *   type: 'text',
 *   chatId: 'oc_user_chat',
 *   text: 'Hello!',
 * });
 *
 * // Route a progress message (goes to admin chat only)
 * await router.routeByLevel({
 *   chatId: 'oc_user_chat',
 *   level: MessageLevel.PROGRESS,
 *   content: 'Processing...',
 * });
 * ```
 */
export class UnifiedMessageRouter {
  private readonly fileStorageService?: FileStorageService;
  private readonly sendFileToUser: (chatId: string, filePath: string, threadId?: string) => Promise<void>;
  private readonly onTaskDone?: (chatId: string, threadId?: string) => Promise<void>;
  private readonly adminChatId?: string;
  private readonly userLevels: Set<MessageLevel>;
  private readonly channels: Map<string, IChannel> = new Map();

  constructor(config: UnifiedMessageRouterConfig) {
    this.fileStorageService = config.fileStorageService;
    this.sendFileToUser = config.sendFileToUser;
    this.onTaskDone = config.onTaskDone;
    this.adminChatId = config.adminChatId;

    // Initialize user-visible levels
    const levels = config.userMessageLevels ?? DEFAULT_USER_LEVELS;
    this.userLevels = new Set(levels);

    logger.info(
      { adminChatId: this.adminChatId, userLevels: [...this.userLevels] },
      'UnifiedMessageRouter created'
    );
  }

  // ============================================================================
  // Channel Management
  // ============================================================================

  /**
   * Register a channel for routing.
   */
  registerChannel(channel: IChannel): void {
    this.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id }, 'Channel registered with UnifiedMessageRouter');
  }

  /**
   * Unregister a channel.
   */
  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
    logger.info({ channelId }, 'Channel unregistered from UnifiedMessageRouter');
  }

  /**
   * Get all registered channels.
   */
  getChannels(): IChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Clear all registered channels.
   */
  clear(): void {
    this.channels.clear();
    logger.info('All channels cleared from UnifiedMessageRouter');
  }

  // ============================================================================
  // Admin Chat Management
  // ============================================================================

  /**
   * Check if admin chat is configured.
   */
  hasAdminChat(): boolean {
    return !!this.adminChatId;
  }

  /**
   * Get the admin chat ID.
   */
  getAdminChatId(): string | undefined {
    return this.adminChatId;
  }

  /**
   * Check if a level is visible to users.
   */
  isUserVisible(level: MessageLevel): boolean {
    return this.userLevels.has(level);
  }

  /**
   * Update the user-visible levels.
   */
  setUserLevels(levels: MessageLevel[]): void {
    this.userLevels.clear();
    levels.forEach((level) => this.userLevels.add(level));
    logger.info({ levels }, 'Updated user levels');
  }

  // ============================================================================
  // Routing Logic
  // ============================================================================

  /**
   * Determine routing for a message based on type and level.
   */
  private determineRouting(type: UnifiedMessageType, level?: MessageLevel): RoutingDecision {
    // Default: send to user chat only
    const decision: RoutingDecision = {
      toAdmin: false,
      toUser: true,
      level: level ?? MessageLevel.INFO,
    };

    switch (type) {
      case 'debug':
      case 'progress':
        // Debug/progress → admin chat only
        decision.toAdmin = !!this.adminChatId;
        decision.toUser = false;
        decision.level = type === 'debug' ? MessageLevel.DEBUG : MessageLevel.PROGRESS;
        break;

      case 'error':
        // Error → admin + user chat
        decision.toAdmin = !!this.adminChatId;
        decision.toUser = true;
        decision.level = MessageLevel.ERROR;
        break;

      case 'text':
      case 'card':
      case 'file':
      case 'done':
        // User-facing messages → admin + user chat (admin receives all for monitoring)
        decision.toAdmin = !!this.adminChatId;
        decision.toUser = true;
        if (level && !this.userLevels.has(level)) {
          decision.toUser = false;
        }
        break;
    }

    return decision;
  }

  /**
   * Get target chat IDs based on routing decision.
   */
  private getTargetChats(decision: RoutingDecision, userChatId: string): string[] {
    const targets: string[] = [];

    // Admin chat receives message first (if routing decision says so)
    if (decision.toAdmin && this.adminChatId && this.adminChatId !== userChatId) {
      targets.push(this.adminChatId);
    }

    // User chat receives message (if routing decision says so)
    if (decision.toUser) {
      targets.push(userChatId);
    }

    return targets;
  }

  // ============================================================================
  // Feedback Handling (from FeedbackRouter)
  // ============================================================================

  /**
   * Handle feedback from execution node.
   * Routes messages based on type to appropriate targets.
   */
  async handleFeedback(message: FeedbackMessage): Promise<void> {
    const { chatId, type, text, card, error, threadId, fileRef } = message;

    try {
      switch (type) {
        case 'text':
          if (text) {
            await this.routeToTargets({
              chatId,
              type: 'text',
              message: {
                chatId,
                type: 'text',
                text,
                threadId,
              },
            });
          }
          break;

        case 'card':
          await this.routeToTargets({
            chatId,
            type: 'card',
            message: {
              chatId,
              type: 'card',
              card,
              description: undefined,
              threadId,
            },
          });
          break;

        case 'file':
          if (fileRef) {
            await this.handleFileFeedback(chatId, fileRef, threadId);
          }
          break;

        case 'done':
          logger.info({ chatId }, 'Execution completed');
          await this.routeToTargets({
            chatId,
            type: 'done',
            message: { type: 'done', chatId, threadId },
          });
          // Trigger next-step recommendations
          if (this.onTaskDone) {
            void this.onTaskDone(chatId, threadId).catch((err) => {
              logger.warn({ err, chatId }, 'Failed to trigger onTaskDone callback');
            });
          }
          break;

        case 'error':
          logger.error({ chatId, error }, 'Execution error');
          await this.routeToTargets({
            chatId,
            type: 'error',
            message: {
              chatId,
              type: 'text',
              text: `❌ 执行错误: ${error || 'Unknown error'}`,
              threadId,
            },
            // Error goes to both admin and user
            sendToAdmin: true,
          });
          break;
      }
    } catch (err) {
      logger.error({ err, message }, 'Failed to handle feedback');
    }
  }

  /**
   * Handle file feedback.
   */
  private async handleFileFeedback(
    chatId: string,
    fileRef: NonNullable<FeedbackMessage['fileRef']>,
    threadId?: string
  ): Promise<void> {
    const localPath = this.fileStorageService?.getLocalPath(fileRef.id);
    if (localPath) {
      await this.sendFileToUser(chatId, localPath, threadId);
    } else {
      logger.error({ fileId: fileRef.id }, 'File not found in storage');
      await this.routeToTargets({
        chatId,
        type: 'text',
        message: {
          chatId,
          type: 'text',
          text: `❌ 文件未找到: ${fileRef.fileName}`,
          threadId,
        },
      });
    }
  }

  // ============================================================================
  // Level-based Routing (from MessageRouter)
  // ============================================================================

  /**
   * Route a message by level.
   * Used for progress/debug messages from execution.
   */
  async routeByLevel(params: {
    chatId: string;
    level: MessageLevel;
    content: string;
    threadId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { chatId, level, content, threadId } = params;

    const decision = this.determineRouting(
      level === MessageLevel.DEBUG ? 'debug' : 'progress',
      level
    );
    const targets = this.getTargetChats(decision, chatId);

    if (targets.length === 0) {
      logger.debug({ level, chatId }, 'No targets for level-based message');
      return;
    }

    logger.debug(
      { level, targets, contentLength: content.length },
      'Routing message by level'
    );

    // Send to all targets
    for (const targetChatId of targets) {
      await this.sendToChannel({
        chatId: targetChatId,
        type: 'text',
        text: content,
        threadId: targetChatId === chatId ? threadId : undefined,
      });
    }
  }

  // ============================================================================
  // Public Message API
  // ============================================================================

  /**
   * Send a text message to user chat.
   */
  async sendMessage(chatId: string, text: string, threadMessageId?: string): Promise<void> {
    await this.routeToTargets({
      chatId,
      type: 'text',
      message: {
        chatId,
        type: 'text',
        text,
        threadId: threadMessageId,
      },
    });
  }

  /**
   * Send a card to user chat.
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    _description?: string,
    threadMessageId?: string
  ): Promise<void> {
    await this.routeToTargets({
      chatId,
      type: 'card',
      message: {
        chatId,
        type: 'card',
        card,
        description: _description,
        threadId: threadMessageId,
      },
    });
  }

  // ============================================================================
  // Internal Routing
  // ============================================================================

  /**
   * Route message to appropriate targets.
   */
  private async routeToTargets(params: {
    chatId: string;
    type: UnifiedMessageType;
    message: OutgoingMessage;
    sendToAdmin?: boolean;
  }): Promise<void> {
    const { chatId, type, message, sendToAdmin } = params;

    const decision = this.determineRouting(type);
    if (sendToAdmin) {
      decision.toAdmin = !!this.adminChatId;
    }

    const targets = this.getTargetChats(decision, chatId);

    if (targets.length === 0) {
      // Fallback: broadcast to all channels if no specific targets
      await this.broadcastToChannels(message);
      return;
    }

    // Send to each target
    for (const targetChatId of targets) {
      const targetMessage = { ...message, chatId: targetChatId };
      await this.broadcastToChannels(targetMessage);
    }
  }

  /**
   * Broadcast a message to all registered channels.
   */
  private async broadcastToChannels(message: OutgoingMessage): Promise<void> {
    if (this.channels.size === 0) {
      logger.warn({ chatId: message.chatId }, 'No channels registered');
      return;
    }

    const results = await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        try {
          await channel.sendMessage(message);
        } catch (error) {
          logger.warn(
            { channelId: channel.id, chatId: message.chatId, error },
            'Channel failed to send message'
          );
          throw error;
        }
      })
    );

    // Log any failures
    const channelArray = Array.from(this.channels.values());
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn(
          { channelId: channelArray[index].id, chatId: message.chatId },
          'Message delivery failed'
        );
      }
    });
  }

  /**
   * Send a message to a specific channel.
   */
  private async sendToChannel(message: OutgoingMessage): Promise<void> {
    if (this.channels.size === 0) {
      logger.warn({ chatId: message.chatId }, 'No channels registered');
      return;
    }

    // Find the appropriate channel for the chatId
    // For now, broadcast to all channels (same as original behavior)
    await this.broadcastToChannels(message);
  }
}

/**
 * Create a default message router configuration.
 */
export function createDefaultUnifiedRouterConfig(
  userChatId: string,
  adminChatId?: string
): MessageRouteConfig {
  return {
    userChatId,
    adminChatId,
    userMessageLevels: [...DEFAULT_USER_LEVELS],
    showTaskLifecycle: {
      showStart: false,
      showProgress: false,
      showComplete: true,
    },
    errors: {
      showStack: false,
      showDetails: 'admin',
    },
  };
}
