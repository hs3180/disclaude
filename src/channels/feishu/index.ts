/**
 * Feishu Channel Components.
 *
 * This module exports the extracted components from feishu-channel.ts
 * for better code organization and testability.
 */

export { MentionDetector, type BotInfo } from './mention-detector.js';
export { PassiveModeManager } from './passive-mode.js';
export { WelcomeHandler } from './welcome-handler.js';
export { FeishuMessageProcessor, type MessageHandlerCallbacks } from './message-handler.js';
export { CardHandler, type CardHandlerCallbacks } from './card-handler.js';
