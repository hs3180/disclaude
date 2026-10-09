/**
 * Ruliu (如流) Platform Adapter.
 *
 * This module provides platform adapter for Baidu Ruliu (InfoFlow).
 *
 * Issue #725: Ruliu platform adapter integration
 *
 * @example
 * ```typescript
 * import { RuliuPlatformAdapter } from './platforms/ruliu';
 *
 * const adapter = new RuliuPlatformAdapter({
 *   config: {
 *     apiHost: 'https://apiin.im.baidu.com',
 *     checkToken: 'your-check-token',
 *     encodingAESKey: 'your-encoding-aes-key',
 *     appKey: 'your-app-key',
 *     appSecret: 'your-app-secret',
 *     robotName: 'MyBot',
 *     replyMode: 'mention-and-watch',
 *   },
 * });
 * ```
 */
export { RuliuPlatformAdapter } from './ruliu-adapter.js';
export { RuliuMessageSender } from './ruliu-message-sender.js';
export { RuliuWebhookHandler } from './ruliu-webhook-handler.js';
export { decryptMessage, encryptMessage, generateSignature, verifySignature, decodeAESKey, } from './ruliu-crypto.js';
