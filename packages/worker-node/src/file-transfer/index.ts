/**
 * File Transfer Module
 *
 * Provides file transfer capabilities between nodes.
 */

// Types - re-exported from @disclaude/core (Issue #1041)
export type {
  FileRef,
  InboundAttachment,
  OutboundFile,
  FileUploadRequest,
  FileUploadResponse,
  FileDownloadResponse,
  StoredFile,
} from '@disclaude/core';

export {
  createFileRef,
  createInboundAttachment,
  createOutboundFile,
} from '@disclaude/core';

// Inbound (file download from platforms)
export { AttachmentManager, attachmentManager } from './inbound/attachment-manager.js';

// Node transfer (inter-node file transfer)
export { FileStorageService, type FileStorageConfig } from './node-transfer/file-storage.js';
export { FileClient, type FileClientConfig } from './node-transfer/file-client.js';
export { createFileTransferAPIHandler, type FileTransferAPIConfig, type FileTransferAPIHandler } from './node-transfer/file-api.js';
