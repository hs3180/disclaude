/**
 * Feishu/Lark module exports.
 *
 * This module exports the components needed for Feishu integration.
 * The bot functionality is handled by CommunicationNode which forwards
 * messages to the Execution Node via WebSocket.
 */

// Re-export commonly used components
export { MessageSender } from './message-sender.js';
export { FileHandler } from './file-handler.js';
export { TaskFlowOrchestrator } from './task-flow-orchestrator.js';
export { messageLogger } from './message-logger.js';

// Re-export core components for backward compatibility
// @deprecated - Import from '../core/index.js' instead
export { attachmentManager } from '../core/attachment-manager.js';
export { messageHistoryManager } from '../core/message-history.js';
