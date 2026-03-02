/**
 * Message router implementation for level-based message routing.
 *
 * Message routing rules:
 * - Level >= user visibility threshold: Send to user (current chat)
 * - Level < user visibility threshold: Send to debug chat (shared by all)
 *
 * The debug chat is created and managed by PrimaryNode, shared by all users.
 *
 * @see Issue #266
 * @see Issue #454
 */

/**
 * Logger interface compatible with Pino.
 * Allows for optional logger with debug, info, warn, error methods.
 */
export interface ILogger {
  debug(msg: string, obj?: unknown): void;
  info(msg: string, obj?: unknown): void;
  warn(msg: string, obj?: unknown): void;
  error(msg: string, obj?: unknown): void;
}
import {
  type IMessageRouter,
  type IMessageSender,
  type MessageRouteConfig,
  type RoutedMessage,
  MessageLevel,
  DEFAULT_USER_LEVELS,
} from './types.js';

/**
 * Message router options.
 */
export interface MessageRouterOptions {
  /** Routing configuration */
  config: MessageRouteConfig;
  /** Message sender implementation */
  sender: IMessageSender;
  /** Logger instance */
  logger?: ILogger;
}

/**
 * Message router implementation.
 *
 * Routes messages to debug and/or user chats based on message level.
 */
export class MessageRouter implements IMessageRouter {
  private readonly config: MessageRouteConfig;
  private readonly sender: IMessageSender;
  private readonly logger?: ILogger;
  private readonly userLevels: Set<MessageLevel>;

  constructor(options: MessageRouterOptions) {
    this.config = options.config;
    this.sender = options.sender;
    this.logger = options.logger;

    // Initialize user-visible levels
    const levels = options.config.userMessageLevels ?? DEFAULT_USER_LEVELS;
    this.userLevels = new Set(levels);
  }

  /**
   * Route a message to appropriate chat(s).
   */
  async route(message: RoutedMessage): Promise<void> {
    const targets = this.getTargets(message.level);
    const targetCount = targets.length;

    if (targetCount === 0) {
      this.logger?.debug('MessageRouter: No targets for message', {
        level: message.level,
        content: message.content.substring(0, 50),
      });
      return;
    }

    this.logger?.debug('MessageRouter: Routing message', {
      level: message.level,
      targets,
      contentLength: message.content.length,
    });

    // Send to all targets in parallel
    const sendPromises = targets.map(async (chatId) => {
      try {
        await this.sender.sendText(chatId, message.content);
      } catch (error) {
        this.logger?.error('MessageRouter: Failed to send message', {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't throw - we want to continue sending to other targets
      }
    });

    await Promise.allSettled(sendPromises);
  }

  /**
   * Get the target chat IDs for a message level.
   */
  getTargets(level: MessageLevel): string[] {
    const targets: string[] = [];

    // Debug chat receives all messages (if configured)
    if (this.config.debugChatId) {
      targets.push(this.config.debugChatId);
    }

    // User chat receives messages based on level
    if (this.config.userChatId && this.userLevels.has(level)) {
      // Avoid duplicate if debug and user chat are the same
      if (this.config.debugChatId !== this.config.userChatId) {
        targets.push(this.config.userChatId);
      }
    }

    return targets;
  }

  /**
   * Check if a level is visible to users.
   */
  isUserVisible(level: MessageLevel): boolean {
    return this.userLevels.has(level);
  }

  /**
   * Check if debug chat is configured.
   */
  hasDebugChat(): boolean {
    return !!this.config.debugChatId;
  }

  /**
   * Get the debug chat ID.
   */
  getDebugChatId(): string | undefined {
    return this.config.debugChatId;
  }

  /**
   * Get the user chat ID.
   */
  getUserChatId(): string {
    return this.config.userChatId;
  }

  /**
   * Update the user-visible levels.
   */
  setUserLevels(levels: MessageLevel[]): void {
    this.userLevels.clear();
    levels.forEach((level) => this.userLevels.add(level));
    this.logger?.info('MessageRouter: Updated user levels', { levels });
  }

  /**
   * Update the debug chat ID.
   */
  setDebugChatId(chatId: string | undefined): void {
    (this.config as { debugChatId?: string }).debugChatId = chatId;
    this.logger?.info('MessageRouter: Updated debug chat ID', { chatId });
  }
}

/**
 * Create a default message router configuration.
 */
export function createDefaultRouteConfig(userChatId: string): MessageRouteConfig {
  return {
    userChatId,
    userMessageLevels: [...DEFAULT_USER_LEVELS],
    showTaskLifecycle: {
      showStart: false,
      showProgress: false,
      showComplete: true,
    },
    errors: {
      showStack: false,
      showDetails: 'debug',
    },
  };
}
