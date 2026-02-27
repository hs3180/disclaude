/**
 * Feishu Platform Module.
 *
 * Exports Feishu-specific implementations of platform adapters.
 *
 * @see Issue #267 - Phase 2: 合并平台模块
 */

// Platform Adapter
export { FeishuPlatformAdapter, type FeishuPlatformAdapterConfig } from './feishu-adapter.js';

// Sub-adapters
export { FeishuMessageSender, type FeishuMessageSenderConfig } from './feishu-message-sender.js';
export { FeishuFileHandler, type FeishuFileHandlerConfig } from './feishu-file-handler.js';

// Card Builders
export { buildTextContent } from './card-builders/index.js';
