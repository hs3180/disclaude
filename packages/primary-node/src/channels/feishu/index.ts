/**
 * Feishu channel submodules.
 *
 * Issue #694: Extracted from feishu-channel.ts
 * Migrated to @disclaude/primary-node (Issue #1040)
 * Issue #1351: Added WsConnectionManager for health detection & auto-reconnect.
 */

// Re-export types from @disclaude/core
export type {
  FeishuEventData,
  FeishuMessageEvent,
  FeishuCardActionEvent,
  FeishuCardActionEventData,
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEventData,
  TopicNotifyConfig,
} from '@disclaude/core';

// Trigger Mode (Issue #2193: renamed from PassiveMode)
export { TriggerModeManager, type TriggerModeRecord } from './passive-mode.js';

// Mention Detection
export { MentionDetector, type BotInfo } from './mention-detector.js';

// Welcome Handler
export { WelcomeHandler } from './welcome-handler.js';

// Message Handler
export { MessageHandler, type MessageCallbacks } from './message-handler.js';

// Message Logger (moved to shared utils - Issue #4015)
export { MessageLogger, messageLogger } from '../../utils/message-logger.js';

// WebSocket Connection Manager (Issue #1351, #1666)
export {
  WsConnectionManager,
  calculateReconnectDelay,
  type WsConnectionState,
  type WsConnectionManagerEvents,
  type WsConnectionManagerConfig,
} from './ws-connection-manager.js';

// Topic Group Notifier (Issue #4031)
export { TopicNotifier } from './topic-notifier.js';
