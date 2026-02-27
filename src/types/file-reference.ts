/**
 * File reference types for communication between nodes.
 *
 * @deprecated This module is deprecated. Import from '../file-transfer/types.js' instead.
 * All types and functions are now consolidated in the unified file-transfer module.
 *
 * @see Issue #194 - Refactor: 统一文件传输系统架构
 */

// Re-export all types and functions from the unified location
export {
  // Base types
  type FileRef,
  type InboundAttachment,
  type OutboundFile,

  // Legacy compatibility types
  type FileReference,
  type FileAttachment,

  // Request/Response types
  type FileUploadRequest,
  type FileUploadResponse,
  type FileDownloadResponse,
  type StoredFile,

  // Factory functions
  createFileRef,
  createInboundAttachment,
  createOutboundFile,
  createFileReference,
} from '../file-transfer/types.js';
