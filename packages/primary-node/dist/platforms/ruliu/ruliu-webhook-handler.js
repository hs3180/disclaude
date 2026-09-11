/**
 * Ruliu (如流) Webhook Handler.
 *
 * Handles incoming webhook messages from Ruliu platform.
 * Performs signature verification, decryption, and message parsing.
 *
 * Issue #725: Ruliu platform adapter integration
 */
import { createLogger } from "../../../../core/dist/index.js";
import { decryptMessage, verifySignature, } from './ruliu-crypto.js';
/**
 * Ruliu Webhook Handler.
 *
 * Processes incoming webhook requests from Ruliu:
 * 1. Verifies signature
 * 2. Decrypts message content
 * 3. Parses message event
 * 4. Routes to appropriate handler
 */
export class RuliuWebhookHandler {
    config;
    logger;
    callbacks;
    constructor(handlerConfig) {
        this.config = handlerConfig.config;
        this.logger = handlerConfig.logger ?? createLogger('RuliuWebhookHandler');
        this.callbacks = handlerConfig.callbacks;
    }
    /**
     * Handle incoming webhook request.
     *
     * @param body - Request body (parsed JSON or raw string)
     * @param query - Query parameters (signature, timestamp, nonce)
     * @returns Response to send back to Ruliu
     */
    async handleWebhook(body, query) {
        try {
            // Parse body if string
            const encrypted = typeof body === 'string' ? JSON.parse(body) : body;
            // Verify signature
            if (query.signature && query.timestamp && query.nonce) {
                const isValid = verifySignature(query.signature, this.config.checkToken, query.timestamp, query.nonce, encrypted.encrypt);
                if (!isValid) {
                    this.logger.warn({ query }, 'Invalid webhook signature');
                    return { status: 401, body: 'Invalid signature' };
                }
            }
            // Decrypt message
            const decryptedContent = decryptMessage(encrypted.encrypt, this.config.encodingAESKey);
            this.logger.debug({ content: decryptedContent }, 'Decrypted message');
            // Parse decrypted content
            const content = JSON.parse(decryptedContent);
            // Convert to message event
            const event = this.parseMessageEvent(content);
            if (event) {
                // Route to message handler
                await this.callbacks.onMessage(event);
            }
            // Return success response (Ruliu expects "success")
            return { status: 200, body: 'success' };
        }
        catch (error) {
            this.logger.error({ err: error }, 'Failed to handle webhook');
            return { status: 500, body: 'Internal error' };
        }
    }
    /**
     * Parse decrypted content to message event.
     */
    parseMessageEvent(content) {
        // Skip non-message types
        if (content.msgType !== 'text' && content.msgType !== 'markdown') {
            this.logger.debug({ msgType: content.msgType }, 'Skipping non-text message');
            return null;
        }
        // Determine chat type
        const chatType = content.groupId ? 'group' : 'direct';
        // Parse message content
        const messageContent = content.content;
        let wasMentioned = false;
        // Check for @mentions in the content
        // Ruliu format: @username or @[robotName]
        if (this.config.robotName) {
            const mentionPattern = new RegExp(`@\\[?${this.config.robotName}\\]?`, 'i');
            wasMentioned = mentionPattern.test(messageContent);
        }
        // Build message event
        const event = {
            fromuser: content.fromUsername,
            mes: messageContent,
            chatType,
            groupId: content.groupId ? parseInt(content.groupId, 10) : undefined,
            messageId: content.msgId,
            timestamp: content.createTime,
            wasMentioned,
        };
        return event;
    }
    /**
     * Handle URL verification request from Ruliu.
     * This is called when setting up the webhook URL.
     *
     * @param body - Request body with challenge
     * @param query - Query parameters
     * @returns Response with decrypted challenge
     */
    handleUrlVerification(body, query) {
        try {
            // Parse body if string
            const encrypted = typeof body === 'string' ? JSON.parse(body) : body;
            // Verify signature
            if (query.signature && query.timestamp && query.nonce) {
                const isValid = verifySignature(query.signature, this.config.checkToken, query.timestamp, query.nonce, encrypted.encrypt);
                if (!isValid) {
                    this.logger.warn({ query }, 'Invalid URL verification signature');
                    return { status: 401, body: 'Invalid signature' };
                }
            }
            // Decrypt and return the challenge
            const decrypted = decryptMessage(encrypted.encrypt, this.config.encodingAESKey);
            this.logger.info('URL verification successful');
            return { status: 200, body: decrypted };
        }
        catch (error) {
            this.logger.error({ err: error }, 'Failed URL verification');
            return { status: 500, body: 'Internal error' };
        }
    }
}
