/**
 * Unified file transfer types.
 *
 * This module consolidates file-related types from across the codebase:
 * - src/types/file-reference.ts (node-to-node file references)
 * - src/channels/adapters/types.ts (FileAttachment for platform handling)
 *
 * @see Issue #194 - Refactor: 统一文件传输系统架构
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Base file reference - unique identifier for files in the system.
 *
 * This is the unified type that replaces both FileReference and FileAttachment.
 */
export interface FileRef {
  /** Unique file identifier (UUID) */
  id: string;

  /** Original file name */
  fileName: string;

  /** MIME type */
  mimeType?: string;

  /** File size in bytes */
  size?: number;

  /** File source: user upload or agent generated */
  source: 'user' | 'agent';

  /**
   * Local storage path.
   * - For downloaded user files: where the file is stored locally
   * - For agent files: where the file was created
   */
  localPath?: string;

  /**
   * Platform-specific file key.
   * - Feishu: file_key from the platform
   * - Other platforms: platform-specific identifier
   */
  platformKey?: string;

  /** Creation timestamp */
  createdAt: number;

  /** Expiration timestamp (optional, for auto cleanup) */
  expiresAt?: number;
}

/**
 * Inbound attachment - file uploaded by user.
 *
 * Used when a user sends a file/image to the system.
 */
export interface InboundAttachment extends FileRef {
  source: 'user';

  /** Chat/conversation ID where the file was uploaded */
  chatId: string;

  /** Message ID that contained the file */
  messageId?: string;

  /** File type classification */
  fileType: 'image' | 'file' | 'media';
}

/**
 * Outbound file - file to be sent to user.
 *
 * Used when the agent generates a file to send to the user.
 */
export interface OutboundFile extends FileRef {
  source: 'agent';

  /** Target chat/conversation ID */
  chatId?: string;

  /** Thread ID for threaded replies */
  threadId?: string;
}

/**
 * Legacy compatibility types.
 * These are kept for backward compatibility during migration.
 */

/** @deprecated Use FileRef instead */
export type FileReference = FileRef & {
  /** Legacy field - use localPath instead */
  storageKey?: string;
  /** Legacy field - now part of base FileRef */
  chatId?: string;
};

/** @deprecated Use InboundAttachment instead */
export type FileAttachment = InboundAttachment & {
  /** Legacy field - use platformKey instead */
  fileKey: string;
  /** Legacy field - use id instead */
  timestamp?: number;
};

/**
 * File upload request - exec node uploads file to comm node.
 */
export interface FileUploadRequest {
  /** File name */
  fileName: string;

  /** MIME type */
  mimeType?: string;

  /** File content (base64 encoded) */
  content: string;

  /** Associated chatId (optional) */
  chatId?: string;
}

/**
 * File upload response.
 */
export interface FileUploadResponse {
  /** File reference after successful upload */
  fileRef: FileRef;
}

/**
 * File download response.
 */
export interface FileDownloadResponse {
  /** File reference */
  fileRef: FileRef;

  /** File content (base64 encoded) */
  content: string;
}

/**
 * File storage info (internal use by comm node).
 */
export interface StoredFile {
  /** File reference */
  ref: FileRef;

  /** Local storage path */
  localPath: string;
}

/**
 * Factory function to create a FileRef.
 */
export function createFileRef(
  fileName: string,
  source: 'user' | 'agent',
  options?: {
    mimeType?: string;
    size?: number;
    localPath?: string;
    platformKey?: string;
    chatId?: string;
    messageId?: string;
    fileType?: 'image' | 'file' | 'media';
    expiresInMs?: number;
  }
): FileRef {
  const now = Date.now();
  return {
    id: uuidv4(),
    fileName,
    mimeType: options?.mimeType,
    size: options?.size,
    source,
    localPath: options?.localPath,
    platformKey: options?.platformKey,
    createdAt: now,
    expiresAt: options?.expiresInMs ? now + options.expiresInMs : undefined,
  };
}

/**
 * Factory function to create an InboundAttachment.
 */
export function createInboundAttachment(
  fileName: string,
  chatId: string,
  fileType: 'image' | 'file' | 'media',
  options?: {
    mimeType?: string;
    size?: number;
    localPath?: string;
    platformKey?: string;
    messageId?: string;
    expiresInMs?: number;
  }
): InboundAttachment {
  const fileRef = createFileRef(fileName, 'user', {
    ...options,
    chatId,
    fileType,
  });

  return {
    ...fileRef,
    source: 'user',
    chatId,
    messageId: options?.messageId,
    fileType,
  };
}

/**
 * Factory function to create an OutboundFile.
 */
export function createOutboundFile(
  fileName: string,
  options?: {
    mimeType?: string;
    size?: number;
    localPath?: string;
    chatId?: string;
    threadId?: string;
    expiresInMs?: number;
  }
): OutboundFile {
  const fileRef = createFileRef(fileName, 'agent', options);

  return {
    ...fileRef,
    source: 'agent',
    chatId: options?.chatId,
    threadId: options?.threadId,
  };
}
