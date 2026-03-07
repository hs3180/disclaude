/**
 * Feishu Platform Adapter Implementation.
 *
 * Implements IPlatformAdapter interface for Feishu/Lark platform.
 * Combines FeishuMessageSender and FeishuFileHandler into a unified adapter.
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import type { IPlatformAdapter } from '../../../src/channels/adapters/types.js';
import { FeishuMessageSender, type FeishuMessageSenderConfig } from './feishu-message-sender.js';
import { FeishuFileHandler, type FeishuFileHandlerConfig } from './feishu-file-handler.js';
import { createFeishuClient } from './create-feishu-client.js';

/**
 * Feishu Platform Adapter Configuration.
 */
export interface FeishuPlatformAdapterConfig {
  /** Feishu App ID */
  appId: string;
  /** Feishu App Secret */
  appSecret: string;
  /** Lark client instance (optional, will be created if not provided) */
  client?: lark.Client;
  /** Logger instance */
  logger: Logger;
  /** Attachment manager for file handling */
  attachmentManager: FeishuFileHandlerConfig['attachmentManager'];
  /** File download function */
  downloadFile: FeishuFileHandlerConfig['downloadFile'];
}

/**
 * Feishu Platform Adapter.
 *
 * Combines all Feishu-specific functionality into a single adapter
 * that implements the platform-agnostic IPlatformAdapter interface.
 *
 * Features:
 * - Message sending (text, card, file)
 * - File handling (download, process)
 * - Reaction support
 */
export class FeishuPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'feishu';
  readonly platformName = 'Feishu/Lark';

  readonly messageSender: FeishuMessageSender;
  readonly fileHandler: FeishuFileHandler;

  private client: lark.Client;
  private logger: Logger;

  constructor(config: FeishuPlatformAdapterConfig) {
    this.logger = config.logger;
    this.client = config.client ?? this.createClient(config.appId, config.appSecret);

    // Create message sender
    this.messageSender = new FeishuMessageSender({
      client: this.client,
      logger: this.logger,
    } as FeishuMessageSenderConfig);

    // Create file handler
    this.fileHandler = new FeishuFileHandler({
      attachmentManager: config.attachmentManager,
      downloadFile: config.downloadFile,
    });
  }

  /**
   * Get the underlying Lark client.
   * Useful for advanced operations not covered by the adapter.
   */
  getClient(): lark.Client {
    return this.client;
  }

  /**
   * Update the Lark client (e.g., after token refresh).
   */
  updateClient(client: lark.Client): void {
    this.client = client;
    // Note: FeishuMessageSender would need to be recreated if client changes
    // For now, this is mainly for testing/mocking purposes
  }

  /**
   * Create a new Lark client with timeout configuration.
   */
  private createClient(appId: string, appSecret: string): lark.Client {
    return createFeishuClient(appId, appSecret);
  }
}
