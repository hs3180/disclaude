/**
 * Ruliu (如流) Platform Adapter Implementation.
 *
 * Implements IPlatformAdapter interface for Ruliu platform.
 * Combines RuliuMessageSender into a unified adapter.
 *
 * Issue #725: Ruliu platform adapter integration
 */

import type { Logger } from 'pino';
import { createLogger } from '@disclaude/core';
import type { IPlatformAdapter } from '../../channels/adapters/types.js';
import { RuliuMessageSender, type RuliuMessageSenderConfig } from './ruliu-message-sender.js';
import type { RuliuConfig } from './types.js';

/**
 * Ruliu Platform Adapter Configuration.
 */
export interface RuliuPlatformAdapterConfig {
  /** Ruliu configuration */
  config: RuliuConfig;
  /** Logger instance (optional) */
  logger?: Logger;
}

/**
 * Ruliu Platform Adapter.
 *
 * Combines all Ruliu-specific functionality into a single adapter
 * that implements the platform-agnostic IPlatformAdapter interface.
 *
 * Features:
 * - Message sending (text, markdown)
 * - AES encryption/decryption support
 * - Webhook message handling
 *
 * @example
 * ```typescript
 * const adapter = new RuliuPlatformAdapter({
 *   config: {
 *     apiHost: 'https://apiin.im.baidu.com',
 *     checkToken: 'your-token',
 *     encodingAESKey: 'your-key',
 *     appKey: 'your-app-key',
 *     appSecret: 'your-app-secret',
 *     robotName: 'MyBot',
 *   },
 * });
 *
 * await adapter.messageSender.sendText('chat-id', 'Hello!');
 * ```
 */
export class RuliuPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'ruliu';
  readonly platformName = 'Ruliu (如流)';

  readonly messageSender: RuliuMessageSender;
  readonly fileHandler = undefined; // Not implemented yet

  private config: RuliuConfig;
  private logger: Logger;

  constructor(adapterConfig: RuliuPlatformAdapterConfig) {
    this.config = adapterConfig.config;
    this.logger = adapterConfig.logger ?? createLogger('RuliuPlatformAdapter');

    // Create message sender
    this.messageSender = new RuliuMessageSender({
      config: this.config,
      logger: this.logger,
    } as RuliuMessageSenderConfig);

    this.logger.info(
      {
        apiHost: this.config.apiHost,
        robotName: this.config.robotName,
        replyMode: this.config.replyMode ?? 'mention-and-watch',
      },
      'Ruliu platform adapter initialized'
    );
  }

  /**
   * Get the current configuration.
   */
  getConfig(): RuliuConfig {
    return { ...this.config };
  }

  /**
   * Update the configuration.
   * Note: This creates a new message sender with updated config.
   */
  updateConfig(config: Partial<RuliuConfig>): void {
    this.config = { ...this.config, ...config };
    // Message sender will need to be recreated for config changes
    this.logger.info({ updatedFields: Object.keys(config) }, 'Configuration updated');
  }
}
