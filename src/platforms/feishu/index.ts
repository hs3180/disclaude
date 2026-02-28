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

// Chat Manager (Issue #347)
export {
  FeishuChatManager,
  getFeishuChatManager,
  setFeishuChatManager,
  resetFeishuChatManager,
  type LogChatResult,
  type FeishuChatManagerOptions,
} from './feishu-chat-manager.js';

// Card Builders
export { buildTextContent } from './card-builders/index.js';
