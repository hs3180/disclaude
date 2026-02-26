/**
 * Platform Adapters Module.
 *
 * Exports platform-agnostic interfaces and types for message handling
 * and file operations.
 */

// Types
export type {
  FileAttachment,
  FileHandlerResult,
  IMessageSender,
  IFileHandler,
  IAttachmentManager,
  IPlatformAdapter,
} from './types.js';

// Factory
export {
  PlatformAdapterFactory,
  createPlatformAdapterFactory,
  type PlatformType,
  type BasePlatformConfig,
  type FeishuConfig,
  type RestConfig,
  type PlatformConfig,
  type PlatformAdapterFactoryFn,
} from './factory.js';
