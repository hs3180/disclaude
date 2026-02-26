/**
 * File Transfer Module.
 *
 * Unified file transfer system for handling file operations across:
 * - Inbound: User uploads to system
 * - Outbound: Agent sends files to user
 * - Node Transfer: Distributed mode file transfer between nodes
 *
 * @see Issue #194 - Refactor: 统一文件传输系统架构
 */

// Unified types
export {
  // Types
  type FileRef,
  type InboundAttachment,
  type OutboundFile,
  type FileReference,
  type FileAttachment,
  type FileUploadRequest,
  type FileUploadResponse,
  type FileDownloadResponse,
  type StoredFile,
  // Factory functions
  createFileRef,
  createInboundAttachment,
  createOutboundFile,
} from './types.js';
