/**
 * Platform Adapter Base Types.
 *
 * These interfaces define platform-agnostic contracts for message handling
 * and file operations. Each platform (Feishu, REST, etc.) should implement
 * these interfaces.
 *
 * This file re-exports from channels/adapters/types.ts for backward compatibility
 * and provides a cleaner import path: `platforms/base` instead of `channels/adapters`.
 *
 * Architecture:
 * ```
 * Channel (BaseChannel)
 *     ├── IMessageSender (adapter)
 *     └── IFileHandler (adapter)
 * ```
 *
 * @see Issue #194 - Refactor: 统一文件传输系统架构
 */

// Re-export all types from channels/adapters/types.ts for backward compatibility
export type {
  FileAttachment,
  FileHandlerResult,
  IMessageSender,
  IFileHandler,
  IAttachmentManager,
  IPlatformAdapter,
} from '../../channels/adapters/types.js';
