/**
 * Feishu channel submodules.
 *
 * Issue #694: Extracted from feishu-channel.ts
 * Migrated to @disclaude/primary-node (Issue #1040)
 * Issue #1351: Added WsConnectionManager for health detection & auto-reconnect.
 * Issue #1229: Added TriggerDetector and SessionEndManager for smart session end.
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

// WebSocket Connection Manager (Issue #1351)
export {
  WsConnectionManager,
  calculateReconnectDelay,
  isPongFrame,
  type WsConnectionState,
  type WsConnectionManagerEvents,
  type WsConnectionManagerConfig,
} from './ws-connection-manager.js';

// Session End (Issue #1229)
export {
  TriggerDetector,
  DEFAULT_TRIGGER_KEYWORD,
  TRIGGER_REASONS,
  type TriggerResult,
  type TriggerDetectorConfig,
} from './trigger-detector.js';

export {
  SessionEndManager,
} from './session-end-manager.js';
