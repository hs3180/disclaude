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
  type CreateDiscussionOptions,
  type ChatOpsConfig,
} from './chat-ops.js';
