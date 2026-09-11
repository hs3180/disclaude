/**
 * Feishu channel submodules.
 *
 * Issue #694: Extracted from feishu-channel.ts
 * Migrated to @disclaude/service (Issue #1040)
 * Issue #1351: Added WsConnectionManager for health detection & auto-reconnect.
 */
// Trigger Mode (Issue #2193: renamed from PassiveMode)
export { TriggerModeManager } from './passive-mode.js';
// Mention Detection
export { MentionDetector } from './mention-detector.js';
// Welcome Handler
export { WelcomeHandler } from './welcome-handler.js';
// Message Handler
export { MessageHandler } from './message-handler.js';
// Message Logger (moved to shared utils - Issue #4015)
export { MessageLogger, messageLogger } from '../../utils/message-logger.js';
// WebSocket Connection Manager (Issue #1351, #1666)
export { WsConnectionManager, calculateReconnectDelay, } from './ws-connection-manager.js';
