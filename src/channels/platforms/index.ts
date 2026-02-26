/**
 * Platform Adapters Module.
 *
 * Exports all platform-specific adapter implementations.
 */

// Feishu Platform
export {
  FeishuPlatformAdapter,
  FeishuMessageSender,
  FeishuFileHandler,
  type FeishuPlatformAdapterConfig,
  type FeishuMessageSenderConfig,
  type FeishuFileHandlerConfig,
} from './feishu/index.js';

// REST Platform
export {
  RestPlatformAdapter,
  RestMessageSender,
  type RestPlatformAdapterConfig,
} from './rest/index.js';
