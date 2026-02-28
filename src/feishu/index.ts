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
export { ChatManager } from './chat-manager.js';
export type { ChatManagerConfig, CreateGroupOptions, ChatInfo } from './chat-manager.js';
