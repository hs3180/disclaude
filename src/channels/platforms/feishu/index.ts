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

// File Transfer
export {
  downloadFile,
  extractFileExtension,
} from './feishu-file-downloader.js';
export {
  detectFileType,
  uploadFile,
  sendFileMessage,
  uploadAndSendFile,
  type UploadResult,
} from './feishu-file-uploader.js';

// Card Builders
export {
  buildTextContent,
  DiffCardBuilder,
  WriteCardBuilder,
} from './card-builders/index.js';
