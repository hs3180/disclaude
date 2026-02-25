/**
 * File reference types for communication between nodes.
 *
 * When Communication Node and Execution Node are deployed separately,
 * file references (FileReference) are used to pass file identifiers
 * instead of local file paths.
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * File reference - unique identifier for files passed between nodes.
 *
 * @example
 * // When user uploads a file, comm node creates a fileRef
 * const fileRef: FileReference = {
 *   id: 'uuid-xxx',
 *   fileName: 'report.pdf',
 *   mimeType: 'application/pdf',
 *   size: 1024000,
 *   source: 'user',
 *   storageKey: '/data/files/uuid-xxx/report.pdf',
 *   createdAt: Date.now(),
 *   expiresAt: Date.now() + 24 * 60 * 60 * 1000,
 * };
 */
export interface FileReference {
  /** Unique file identifier (UUID) */
  id: string;

  /** Original file name */
  fileName: string;

  /** MIME type */
  mimeType?: string;

  /** File size (bytes) */
  size?: number;

  /** File source */
  source: 'user' | 'agent';

  /**
   * File storage location (internal use by comm node)
   * - Local storage: absolute path
   * - S3 storage: S3 key
   */
  storageKey?: string;

  /** Creation timestamp */
  createdAt: number;

  /** Expiration timestamp (optional, for auto cleanup) */
  expiresAt?: number;

  /** Associated chatId (optional, for context association) */
  chatId?: string;
}

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
  fileRef: FileReference;
}

/**
 * File download response.
 */
export interface FileDownloadResponse {
  /** File reference */
  fileRef: FileReference;

  /** File content (base64 encoded) */
  content: string;
}

/**
 * File storage info (internal use).
 */
export interface StoredFile {
  /** File reference */
  ref: FileReference;

  /** Local storage path */
  localPath: string;
}

/**
 * Factory function to create a FileReference.
 */
export function createFileReference(
  fileName: string,
  source: 'user' | 'agent',
  options?: {
    mimeType?: string;
    size?: number;
    storageKey?: string;
    chatId?: string;
    expiresInMs?: number;
  }
): FileReference {
  const now = Date.now();
  return {
    id: uuidv4(),
    fileName,
    mimeType: options?.mimeType,
    size: options?.size,
    source,
    storageKey: options?.storageKey,
    chatId: options?.chatId,
    createdAt: now,
    expiresAt: options?.expiresInMs ? now + options.expiresInMs : undefined,
  };
}
