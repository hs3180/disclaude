/**
 * Feishu/Lark module exports.
 *
 * This module exports the components needed for Feishu integration.
 * The bot functionality is handled by CommunicationNode which forwards
 * messages to the Execution Node via WebSocket.
 */

// Re-export platform adapters (consolidated from channels/platforms/feishu)
// @deprecated - Import from '../channels/platforms/feishu/index.js' instead
export {
  FeishuMessageSender,
  FeishuFileHandler,
  type FeishuMessageSenderConfig,
  type FeishuFileHandlerConfig,
} from '../channels/platforms/feishu/index.js';

// Re-export commonly used components
export { TaskFlowOrchestrator } from './task-flow-orchestrator.js';
export { messageLogger } from './message-logger.js';

// Re-export core components for backward compatibility
// @deprecated - Import from '../file-transfer/inbound/index.js' instead
export { attachmentManager } from '../file-transfer/inbound/index.js';
// @deprecated - Import from '../core/index.js' instead
export { messageHistoryManager } from '../core/message-history.js';
