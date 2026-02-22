/**
 * Feishu/Lark module exports.
 *
 * This module exports the components needed for Feishu integration.
 * The bot functionality is now handled by CommunicationNode and ExecutionNode
 * through the Transport abstraction layer.
 */

// Re-export commonly used components
export { MessageSender } from './message-sender.js';
export { FileHandler } from './file-handler.js';
export { TaskFlowOrchestrator } from './task-flow-orchestrator.js';
export { attachmentManager } from './attachment-manager.js';
export { messageLogger } from './message-logger.js';
