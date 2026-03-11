/**
 * Platform Adapter Base Types.
 *
 * These interfaces define platform-agnostic contracts for message handling
 * and file operations. Each platform (Feishu, REST, etc.) should implement
 * these interfaces.
 *
 * This file re-exports from @disclaude/core for backward compatibility
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
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

// Re-export all types from @disclaude/core
export type {
  FileAttachment,
  FileHandlerResult,
  IMessageSender,
  IFileHandler,
  IAttachmentManager,
  IPlatformAdapter,
} from '@disclaude/core';
