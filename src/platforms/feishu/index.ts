/**
 * Feishu Platform Module.
 *
 * Exports Feishu-specific implementations of platform adapters.
 */

// Platform Adapter
export { FeishuPlatformAdapter, type FeishuPlatformAdapterConfig } from './feishu-adapter.js';

// Sub-adapters
export { FeishuMessageSender, type FeishuMessageSenderConfig } from './feishu-message-sender.js';
export { FeishuFileHandler, type FeishuFileHandlerConfig } from './feishu-file-handler.js';

// Card Builders
export { buildTextContent } from './card-builders/index.js';

// Chat Operations (for FeedbackController integration)
export {
  createDiscussionChat,
  dissolveChat,
  addMembers,
  removeMembers,
  getMembers,
  type CreateDiscussionOptions,
  type ChatOpsConfig,
} from './chat-ops.js';

// Group Service (Issue #486)
export { GroupService, getGroupService, type GroupInfo, type GroupServiceConfig } from './group-service.js';

// Debug Chat Service (Issue #487)
export { DebugChatService, getDebugChatService, type DebugChatServiceConfig } from './debug-chat-service.js';
