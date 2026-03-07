/**
 * Platform Adapters Module.
 *
 * Exports all platform-specific adapter implementations.
 * Note: Feishu platform has been moved to src/platforms/feishu/
 */

// Feishu Platform (re-export from platforms module)
export {
  FeishuPlatformAdapter,
  FeishuMessageSender,
  FeishuFileHandler,
  type FeishuPlatformAdapterConfig,
  type FeishuMessageSenderConfig,
  type FeishuFileHandlerConfig,
} from '../platforms/feishu/index.js';

// REST Platform
export {
  RestPlatformAdapter,
  RestMessageSender,
  type RestPlatformAdapterConfig,
} from './rest/index.js';
