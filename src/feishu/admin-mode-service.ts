/**
 * AdminModeService - Dynamic admin mode management.
 *
 * Handles detection of admin mode intent and automatic log chat creation.
 * Integrates with UserStateStore for state persistence and ChatOps for
 * group chat management.
 *
 * @see Issue #347 - Dynamic admin mode setup and auto-create log chat
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';
import { UserStateStore, userStateStore } from './user-state-store.js';
import { isEnableAdminIntent, isDisableAdminIntent } from './intent-recognition.js';

const logger = createLogger('AdminModeService');

/**
 * Admin mode service configuration.
 */
export interface AdminModeConfig {
  /** Feishu API client */
  client: lark.Client;
  /** User state store instance */
  userStateStore?: UserStateStore;
  /** Whether to auto-create log chat */
  autoCreateLogChat?: boolean;
}

/**
 * Result of admin mode handling.
 */
export interface AdminModeHandleResult {
  /** Whether the message was handled as admin mode intent */
  handled: boolean;
  /** Action taken */
  action?: 'enabled' | 'disabled' | 'confirmed' | 'rejected';
  /** Log chat ID (if created) */
  logChatId?: string;
  /** Response message to send */
  response?: string;
}

/**
 * AdminModeService - Manages dynamic admin mode setup.
 *
 * Features:
 * - Detects admin mode intent from user messages
 * - Enables/disables admin mode for users
 * - Creates log chat for admin mode (optional)
 * - Persists admin mode state
 */
export class AdminModeService {
  private readonly client: lark.Client;
  private readonly store: UserStateStore;
  private readonly autoCreateLogChat: boolean;

  constructor(config: AdminModeConfig) {
    this.client = config.client;
    this.store = config.userStateStore ?? userStateStore;
    this.autoCreateLogChat = config.autoCreateLogChat ?? false;
  }

  /**
   * Initialize the service.
   */
  async init(): Promise<void> {
    await this.store.init();
    logger.info('AdminModeService initialized');
  }

  /**
   * Handle incoming message for admin mode intent.
   *
   * @param userId - User open_id
   * @param _chatId - Chat ID where message was received (reserved for future use)
   * @param message - Message text
   * @returns Handle result
   */
  handleMessage(
    userId: string,
    _chatId: string,
    message: string
  ): Promise<AdminModeHandleResult> {
    // Check if this is an admin mode intent
    if (!isEnableAdminIntent(message) && !isDisableAdminIntent(message)) {
      return Promise.resolve({ handled: false });
    }

    const currentState = this.store.get(userId);
    const isAdminMode = currentState?.adminModeEnabled ?? false;

    // Handle enable admin mode
    if (isEnableAdminIntent(message)) {
      if (isAdminMode) {
        return Promise.resolve({
          handled: true,
          action: 'confirmed',
          response: '管理员模式已经开启。',
        });
      }

      return this.enableAdminMode(userId);
    }

    // Handle disable admin mode
    if (isDisableAdminIntent(message)) {
      if (!isAdminMode) {
        return Promise.resolve({
          handled: true,
          action: 'confirmed',
          response: '管理员模式已经关闭。',
        });
      }

      return this.disableAdminMode(userId);
    }

    return Promise.resolve({ handled: false });
  }

  /**
   * Enable admin mode for a user.
   */
  private async enableAdminMode(userId: string): Promise<AdminModeHandleResult> {
    try {
      let logChatId: string | undefined;

      // Auto-create log chat if enabled
      if (this.autoCreateLogChat) {
        logChatId = await this.createLogChat(userId);
      }

      // Update state
      await this.store.setAdminMode(userId, true, logChatId);

      logger.info({ userId, logChatId }, 'Admin mode enabled');

      return {
        handled: true,
        action: 'enabled',
        logChatId,
        response: logChatId
          ? `管理员模式已开启。日志群已创建: ${logChatId}`
          : '管理员模式已开启。',
      };
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to enable admin mode');
      return {
        handled: true,
        action: 'rejected',
        response: '开启管理员模式失败，请稍后重试。',
      };
    }
  }

  /**
   * Disable admin mode for a user.
   */
  private async disableAdminMode(userId: string): Promise<AdminModeHandleResult> {
    try {
      await this.store.setAdminMode(userId, false);

      logger.info({ userId }, 'Admin mode disabled');

      return {
        handled: true,
        action: 'disabled',
        response: '管理员模式已关闭。',
      };
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to disable admin mode');
      return {
        handled: true,
        action: 'rejected',
        response: '关闭管理员模式失败，请稍后重试。',
      };
    }
  }

  /**
   * Create a log chat for admin mode.
   *
   * Note: This is a placeholder implementation. Full implementation
   * requires ChatOps from PR #423.
   */
  private async createLogChat(userId: string): Promise<string> {
    // TODO: Use ChatOps from PR #423 when merged
    // For now, return a placeholder
    logger.warn(
      { userId },
      'createLogChat called but ChatOps not available. Enable autoCreateLogChat after PR #423 merges.'
    );

    // Placeholder: Create chat using raw API
    try {
      const response = await this.client.im.chat.create({
        data: {
          name: `Admin Log - ${userId.substring(0, 8)}`,
          chat_mode: 'group',
          chat_type: 'group',
          user_id_list: [userId],
        },
        params: {
          user_id_type: 'open_id',
        },
      });

      const chatId = response?.data?.chat_id;
      if (!chatId) {
        throw new Error('Failed to get chat_id from response');
      }

      logger.info({ chatId, userId }, 'Log chat created');
      return chatId;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to create log chat');
      throw error;
    }
  }

  /**
   * Check if admin mode is enabled for a user.
   */
  isAdminModeEnabled(userId: string): boolean {
    return this.store.isAdminModeEnabled(userId);
  }

  /**
   * Get log chat ID for a user.
   */
  getLogChatId(userId: string): string | undefined {
    return this.store.getLogChatId(userId);
  }

  /**
   * Get all users with admin mode enabled.
   */
  getAdminUsers() {
    return this.store.getAdminUsers();
  }
}
