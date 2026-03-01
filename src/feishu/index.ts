/**
 * Feishu/Lark module exports.
 *
 * This module exports the components needed for Feishu integration.
 * The bot functionality is handled by CommunicationNode which forwards
 * messages to the Execution Node via WebSocket.
 */

// Re-export commonly used components
export { TaskFlowOrchestrator } from './task-flow-orchestrator.js';
export { messageLogger } from './message-logger.js';

// Admin mode components (Issue #347)
export { UserStateStore, userStateStore, type UserState } from './user-state-store.js';
export {
  recognizeIntent,
  isAdminModeIntent,
  isEnableAdminIntent,
  isDisableAdminIntent,
  Intent,
  type IntentResult,
} from './intent-recognition.js';
export { AdminModeService, type AdminModeConfig, type AdminModeHandleResult } from './admin-mode-service.js';
