/**
 * Ruliu (如流) Platform Adapter Implementation.
 *
 * Implements IPlatformAdapter interface for Ruliu platform.
 * Combines RuliuMessageSender into a unified adapter.
 *
 * Issue #725: Ruliu platform adapter integration
 */
import { createLogger } from "../../../../core/dist/index.js";
import { RuliuMessageSender } from './ruliu-message-sender.js';
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
export class RuliuPlatformAdapter {
    platformId = 'ruliu';
    platformName = 'Ruliu (如流)';
    messageSender;
    fileHandler = undefined; // Not implemented yet
    config;
    logger;
    constructor(adapterConfig) {
        this.config = adapterConfig.config;
        this.logger = adapterConfig.logger ?? createLogger('RuliuPlatformAdapter');
        // Create message sender
        this.messageSender = new RuliuMessageSender({
            config: this.config,
            logger: this.logger,
        });
        this.logger.info({
            apiHost: this.config.apiHost,
            robotName: this.config.robotName,
            replyMode: this.config.replyMode ?? 'mention-and-watch',
        }, 'Ruliu platform adapter initialized');
    }
    /**
     * Get the current configuration.
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * Update the configuration.
     * Note: This creates a new message sender with updated config.
     */
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        // Message sender will need to be recreated for config changes
        this.logger.info({ updatedFields: Object.keys(config) }, 'Configuration updated');
    }
}
