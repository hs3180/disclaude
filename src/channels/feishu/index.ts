/**
 * Feishu Channel Module.
 *
 * Extracted components from feishu-channel.ts for better maintainability.
 * Issue #694: 拆分 feishu-channel.ts (1055行)
 */

export * from './types.js';
export { PassiveModeManager } from './passive-mode.js';
export { MentionDetector } from './mention-detector.js';
export { WelcomeEventHandler } from './welcome-event-handler.js';
export { FeishuMessageHandler } from './message-handler.js';
