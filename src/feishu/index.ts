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
export { ChatRegistry, chatRegistry, type ChatInfo } from './chat-registry.js';
export {
  ProactiveMessenger,
  createProactiveMessenger,
  type Recommendation,
  type ProactiveMessengerConfig,
} from './proactive-messenger.js';
