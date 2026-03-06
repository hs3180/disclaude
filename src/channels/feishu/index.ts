/**
 * Feishu Channel submodules.
 *
 * Issue #694: Split feishu-channel.ts into modular components
 */

export { PassiveModeManager } from './passive-mode.js';
export { MentionDetector, type BotInfo } from './mention-detector.js';
export { WelcomeHandler } from './welcome-handler.js';
export { FeishuMessageHandler, type FeishuMessageHandlerContext } from './message-handler.js';
