/**
 * FeedbackController - Unified Feedback Collection Abstraction.
 *
 * Simplifies the pattern of "create channel → send message → collect feedback → make decision".
 * Used by v0.4 features: #357 (smart recommendations), #347 (dynamic admin), #393 (PR scanner).
 *
 * @see Issue #411 - FeedbackController design
 * @see Issue #402 - ChatOps integration for group channel creation
 */

import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import { createLogger } from '../utils/logger.js';
import { FeishuMessageSender } from '../platforms/feishu/feishu-message-sender.js';
import { InteractionManager } from '../platforms/feishu/interaction-manager.js';
import { createDiscussionChat } from '../platforms/feishu/chat-ops.js';
import {
  buildCard,
  buildDiv,
  buildActionGroup,
  buildButton,
  type BuiltCard,
  type ButtonStyle,
} from '../platforms/feishu/card-builders/interactive-card-builder.js';

/**
 * Channel type for communication.
 */
export type ChannelType = 'existing' | 'group' | 'private';

/**
 * Options for creating a communication channel.
 */
export interface CreateChannelOptions {
  /** Channel type */
  type: ChannelType;
  /** Existing chat ID (required when type is 'existing') */
  chatId?: string;
  /** Group name (used when type is 'group') */
  name?: string;
  /** Initial members (used when type is 'group') */
  members?: string[];
}

/**
 * Feedback type.
 */
export type FeedbackType = 'option' | 'freeform';

/**
 * User feedback data.
 */
export interface Feedback {
  /** Chat ID where feedback was collected */
  chatId: string;
  /** User who provided feedback */
  userId: string;
  /** Feedback type */
  type: FeedbackType;
  /** Selected option value or freeform text */
  value: string;
  /** Timestamp when feedback was received */
  timestamp: string;
}

/**
 * Final decision from feedback collection.
 */
export interface Decision {
  /** The decided action */
  action: string;
  /** Confidence level (0-1, useful for multi-user voting) */
  confidence: number;
  /** All collected feedbacks */
  feedbacks: Feedback[];
}

/**
 * Content for interactive cards.
 */
export interface CardContent {
  /** Card title */
  title: string;
  /** Card body content (markdown supported) */
  body: string;
  /** Optional action buttons */
  buttons?: Array<{
    text: string;
    value: string;
    style?: ButtonStyle;
  }>;
}

/**
 * Options for collecting feedback.
 */
export interface CollectFeedbackOptions {
  /** Chat ID to collect feedback from */
  chatId: string;
  /** Collection mode: sync (blocking) or async (callback) */
  mode: 'sync' | 'async';
  /** Option buttons to display (optional) */
  options?: string[];
  /** Whether to allow freeform text input */
  freeform?: boolean;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
  /** Callback for async mode */
  onFeedback?: (feedback: Feedback) => void;
}

/**
 * Pending feedback collection state.
 */
interface PendingFeedback {
  /** Chat ID */
  chatId: string;
  /** Options being waited for */
  options?: string[];
  /** Whether freeform is allowed */
  freeform: boolean;
  /** When this request was created */
  createdAt: number;
  /** When this request expires */
  expiresAt: number;
  /** Collected feedbacks */
  feedbacks: Feedback[];
  /** Resolve function for sync mode */
  resolve?: (decision: Decision) => void;
  /** Callback for async mode */
  onFeedback?: (feedback: Feedback) => void;
}

/**
 * FeedbackController configuration.
 */
export interface FeedbackControllerConfig {
  /** Feishu API client */
  client: lark.Client;
  /** Logger instance (optional) */
  logger?: Logger;
  /** Default timeout for feedback collection (default: 5 minutes) */
  defaultTimeout?: number;
}

/**
 * FeedbackController - Unified Feedback Collection Abstraction.
 *
 * Provides a simplified interface for:
 * 1. Creating communication channels (existing chat, new group, private chat)
 * 2. Sending messages and interactive cards
 * 3. Collecting user feedback (sync/async)
 * 4. Making decisions based on collected feedback
 *
 * @example
 * ```typescript
 * const controller = new FeedbackController({ client });
 *
 * // Create channel and send recommendation
 * const chatId = await controller.createChannel({
 *   type: 'existing',
 *   chatId: 'oc_xxx'
 * });
 *
 * await controller.sendMessage(chatId, {
 *   title: 'Schedule Recommendation',
 *   body: 'Create a daily summary task?',
 *   buttons: [
 *     { text: 'Create', value: 'create', style: 'primary' },
 *     { text: 'Ignore', value: 'ignore' }
 *   ]
 * });
 *
 * // Collect feedback synchronously
 * const decision = await controller.collectFeedback({
 *   chatId,
 *   mode: 'sync',
 *   options: ['create', 'ignore'],
 *   timeout: 60000
 * });
 *
 * console.log('User decided:', decision.action);
 * ```
 */
export class FeedbackController {
  private client: lark.Client;
  private logger: Logger;
  private messageSender: FeishuMessageSender;
  private interactionManager: InteractionManager;
  private pendingFeedbacks: Map<string, PendingFeedback> = new Map();
  private defaultTimeout: number;

  constructor(config: FeedbackControllerConfig) {
    this.client = config.client;
    this.logger = config.logger ?? createLogger('FeedbackController');
    this.defaultTimeout = config.defaultTimeout ?? 5 * 60 * 1000; // 5 minutes

    this.messageSender = new FeishuMessageSender({
      client: this.client,
      logger: this.logger,
    });

    this.interactionManager = new InteractionManager({
      defaultTimeout: this.defaultTimeout,
    });

    this.logger.debug({ defaultTimeout: this.defaultTimeout }, 'FeedbackController created');
  }

  /**
   * Create or reuse a communication channel.
   *
   * @param options - Channel creation options
   * @returns The chat ID to use for communication
   *
   * @example
   * // Use existing chat
   * const chatId = await controller.createChannel({
   *   type: 'existing',
   *   chatId: 'oc_xxx'
   * });
   *
   * // Create new group (uses ChatOps)
   * const chatId = await controller.createChannel({
   *   type: 'group',
   *   name: 'PR #123 Discussion',
   *   members: ['ou_user1', 'ou_user2']
   * });
   */
  async createChannel(options: CreateChannelOptions): Promise<string> {
    switch (options.type) {
      case 'existing':
        if (!options.chatId) {
          throw new Error('chatId is required for existing channel type');
        }
        this.logger.debug({ chatId: options.chatId }, 'Using existing channel');
        return options.chatId;

      case 'group':
        if (!options.name) {
          throw new Error('name is required for group channel type');
        }
        if (!options.members || options.members.length === 0) {
          throw new Error('members is required for group channel type');
        }
        const chatId = await createDiscussionChat(this.client, {
          topic: options.name,
          members: options.members,
        });
        this.logger.info({ chatId, name: options.name, memberCount: options.members.length }, 'Group channel created');
        return chatId;

      case 'private':
        // TODO: Implement private channel creation
        throw new Error(
          'Private channel creation not yet implemented. ' +
            'Use type: "existing" with a private chat ID for now.'
        );

      default:
        throw new Error(`Unknown channel type: ${(options as { type: string }).type}`);
    }
  }

  /**
   * Send a message or card to a channel.
   *
   * @param chatId - Target chat ID
   * @param content - Text string or card content
   * @param threadId - Optional thread ID for replies
   */
  async sendMessage(chatId: string, content: string | CardContent, threadId?: string): Promise<void> {
    if (typeof content === 'string') {
      await this.messageSender.sendText(chatId, content, threadId);
      this.logger.debug({ chatId, messageType: 'text' }, 'Text message sent');
    } else {
      const card = this.buildFeedbackCard(content);
      await this.messageSender.sendCard(chatId, card as unknown as Record<string, unknown>, content.title, threadId);
      this.logger.debug({ chatId, messageType: 'card', title: content.title }, 'Card message sent');
    }
  }

  /**
   * Collect user feedback.
   *
   * Sync mode: Blocks until a response is received or timeout.
   * Async mode: Returns immediately, calls onFeedback callback.
   *
   * @param options - Feedback collection options
   * @returns Decision (sync mode) or void (async mode)
   *
   * @example
   * // Sync mode - blocks until user responds
   * const decision = await controller.collectFeedback({
   *   chatId: 'oc_xxx',
   *   mode: 'sync',
   *   options: ['yes', 'no'],
   *   timeout: 30000
   * });
   *
   * // Async mode - returns immediately
   * await controller.collectFeedback({
   *   chatId: 'oc_xxx',
   *   mode: 'async',
   *   options: ['approve', 'reject'],
   *   onFeedback: (feedback) => console.log('Got feedback:', feedback)
   * });
   */
  async collectFeedback(options: CollectFeedbackOptions): Promise<Decision | void> {
    // Note: This method returns a Promise directly for control flow, but is marked async
    // for API consistency. The promise creation is synchronous, but awaiting is handled
    // by the caller.
    await Promise.resolve(); // Satisfy require-await lint rule
    const { chatId, mode, options: feedbackOptions, freeform = false, timeout, onFeedback } = options;

    const effectiveTimeout = timeout ?? this.defaultTimeout;
    const now = Date.now();

    const pending: PendingFeedback = {
      chatId,
      options: feedbackOptions,
      freeform,
      createdAt: now,
      expiresAt: now + effectiveTimeout,
      feedbacks: [],
      onFeedback: mode === 'async' ? onFeedback : undefined,
    };

    // Generate unique key for this feedback request
    const key = `${chatId}-${now}`;

    if (mode === 'sync') {
      // Sync mode: return a promise that resolves when feedback is received
      return new Promise((resolve, reject) => {
        pending.resolve = resolve;

        this.pendingFeedbacks.set(key, pending);

        // Set timeout to reject if no response
        setTimeout(() => {
          if (this.pendingFeedbacks.has(key)) {
            this.pendingFeedbacks.delete(key);
            reject(new Error(`Feedback collection timed out after ${effectiveTimeout}ms`));
          }
        }, effectiveTimeout);

        this.logger.debug(
          { chatId, key, timeout: effectiveTimeout, options: feedbackOptions },
          'Waiting for sync feedback'
        );
      });
    } else {
      // Async mode: store pending and return immediately
      this.pendingFeedbacks.set(key, pending);

      // Set cleanup timeout
      setTimeout(() => {
        if (this.pendingFeedbacks.has(key)) {
          this.pendingFeedbacks.delete(key);
          this.logger.debug({ chatId, key }, 'Async feedback collection expired');
        }
      }, effectiveTimeout);

      this.logger.debug(
        { chatId, key, timeout: effectiveTimeout, options: feedbackOptions },
        'Async feedback collection started'
      );

      return Promise.resolve();
    }
  }

  /**
   * Handle incoming user message as potential feedback.
   *
   * Call this method when a user message is received to check if it matches
   * a pending feedback collection request.
   *
   * @param chatId - Chat ID where message was received
   * @param userId - User who sent the message
   * @param content - Message content
   * @returns Whether the message was handled as feedback
   */
  handleIncomingMessage(chatId: string, userId: string, content: string): boolean {
    // Find pending feedback for this chat
    for (const [key, pending] of this.pendingFeedbacks) {
      if (pending.chatId !== chatId) {
        continue;
      }
      if (pending.expiresAt < Date.now()) {
        this.pendingFeedbacks.delete(key);
        continue;
      }

      // Check if content matches expected options
      const trimmedContent = content.trim().toLowerCase();
      let matchedOption: string | undefined;

      if (pending.options) {
        matchedOption = pending.options.find(
          (opt) => opt.toLowerCase() === trimmedContent
        );
      }

      // If no option match and freeform is allowed, accept any input
      if (!matchedOption && pending.freeform) {
        matchedOption = content.trim();
      }

      if (!matchedOption) {
        continue; // Not a valid response for this pending feedback
      }

      // Create feedback record
      const feedback: Feedback = {
        chatId,
        userId,
        type: pending.options ? 'option' : 'freeform',
        value: matchedOption,
        timestamp: new Date().toISOString(),
      };

      pending.feedbacks.push(feedback);

      this.logger.info(
        { chatId, userId, value: matchedOption, key },
        'Feedback received'
      );

      // Handle based on mode
      if (pending.resolve) {
        // Sync mode: resolve the promise
        const decision: Decision = {
          action: matchedOption,
          confidence: 1.0,
          feedbacks: pending.feedbacks,
        };
        pending.resolve(decision);
        this.pendingFeedbacks.delete(key);
      } else if (pending.onFeedback) {
        // Async mode: call callback
        pending.onFeedback(feedback);
      }

      return true;
    }

    return false;
  }

  /**
   * Handle card button action as feedback.
   *
   * Call this method when a card button is clicked to process it as feedback.
   *
   * @param chatId - Chat ID where action occurred
   * @param userId - User who clicked
   * @param actionValue - Button value
   * @returns Whether the action was handled as feedback
   */
  handleCardAction(chatId: string, userId: string, actionValue: string): boolean {
    return this.handleIncomingMessage(chatId, userId, actionValue);
  }

  /**
   * Get pending feedback collections for a chat.
   *
   * @param chatId - Chat ID to check
   * @returns Array of pending feedback keys
   */
  getPendingForChat(chatId: string): string[] {
    const keys: string[] = [];
    for (const [key, pending] of this.pendingFeedbacks) {
      if (pending.chatId === chatId && pending.expiresAt >= Date.now()) {
        keys.push(key);
      }
    }
    return keys;
  }

  /**
   * Cancel a pending feedback collection.
   *
   * @param key - Pending feedback key
   * @returns Whether the cancellation was successful
   */
  cancelPending(key: string): boolean {
    const deleted = this.pendingFeedbacks.delete(key);
    if (deleted) {
      this.logger.debug({ key }, 'Pending feedback cancelled');
    }
    return deleted;
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this.interactionManager.dispose();
    this.pendingFeedbacks.clear();
    this.logger.debug('FeedbackController disposed');
  }

  /**
   * Build an interactive card for feedback collection.
   */
  private buildFeedbackCard(content: CardContent): BuiltCard {
    const elements: BuiltCard['elements'] = [
      buildDiv(content.body),
    ];

    if (content.buttons && content.buttons.length > 0) {
      elements.push(
        buildActionGroup(
          content.buttons.map((btn) =>
            buildButton({
              text: btn.text,
              value: btn.value,
              style: btn.style,
            })
          )
        )
      );
    }

    return buildCard({
      header: {
        title: content.title,
        template: 'blue',
      },
      elements,
    });
  }
}
