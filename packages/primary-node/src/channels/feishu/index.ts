/**
 * Feishu channel submodules.
 *
 * Issue #694: Extracted from feishu-channel.ts
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

// Re-export types from @disclaude/core
export type {
  FeishuEventData,
  FeishuMessageEvent,
  FeishuCardActionEvent,
  FeishuCardActionEventData,
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEventData,
} from '@disclaude/core';

// Passive Mode
export { PassiveModeManager } from './passive-mode.js';

// Mention Detection
export { MentionDetector, type BotInfo } from './mention-detector.js';

// Welcome Handler
export { WelcomeHandler } from './welcome-handler.js';

// Message Handler
export { MessageHandler, type MessageCallbacks } from './message-handler.js';

// Message Logger
export { MessageLogger, messageLogger } from './message-logger.js';
