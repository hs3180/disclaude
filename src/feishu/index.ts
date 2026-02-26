/**
 * Feishu/Lark module exports.
 *
 * This module exports the components needed for Feishu integration.
 * The bot functionality is handled by CommunicationNode which forwards
 * messages to the Execution Node via WebSocket.
 *
 * @deprecated This module is deprecated. Import directly from:
 * - '../channels/platforms/feishu/index.js' for Feishu-specific components
 * - '../core/index.js' for core components
 */

// Re-export platform adapters (consolidated from channels/platforms/feishu)
// @deprecated - Import from '../channels/platforms/feishu/index.js' instead
export {
  FeishuMessageSender,
  FeishuFileHandler,
  type FeishuMessageSenderConfig,
  type FeishuFileHandlerConfig,
  downloadFile,
  extractFileExtension,
  detectFileType,
  uploadFile,
  sendFileMessage,
  uploadAndSendFile,
  type UploadResult,
} from '../channels/platforms/feishu/index.js';

// Re-export commonly used components
// @deprecated - Import from '../core/index.js' instead
export { TaskFlowOrchestrator } from '../core/task-flow-orchestrator.js';
export { messageLogger } from '../core/message-logger.js';

// Re-export core components for backward compatibility
// @deprecated - Import from '../core/index.js' instead
export { attachmentManager } from '../core/attachment-manager.js';
export { messageHistoryManager } from '../core/message-history.js';
