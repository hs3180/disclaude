/**
 * Shared types for the REST channel subsystem (Issue #4127).
 *
 * Co-locating these here lets modules under channels/rest/ depend on a neutral
 * type home instead of back-importing from rest-channel.ts (the host class),
 * which would create a compile-time circular type dependency as more routes are
 * extracted. rest-channel.ts re-exports `IFileStorageService` for back-compat.
 *
 * @module primary-node/channels/rest/types
 */

import type { FileRef } from '@disclaude/core';

/**
 * File storage service interface for dependency injection.
 */
export interface IFileStorageService {
  initialize(): Promise<void>;
  shutdown(): void;
  storeFromBase64(
    content: string,
    fileName: string,
    mimeType?: string,
    userId?: string,
    chatId?: string
  ): Promise<FileRef>;
  get(fileId: string): { ref: FileRef } | undefined;
  getContent(fileId: string): Promise<string>;
}

/**
 * File upload response.
 *
 * REST-channel envelope; deliberately distinct from `@disclaude/core`'s
 * `FileUploadResponse` (which uses `fileRef` and no success/error envelope).
 */
export interface FileUploadResponse {
  /** Success status. */
  success: boolean;
  /** File reference. */
  file?: FileRef;
  /** Error message (if failed). */
  error?: string;
}

/** File info (metadata) response. */
export interface FileInfoResponse {
  /** Success status. */
  success: boolean;
  /** File reference. */
  file?: FileRef;
  /** Error message (if failed). */
  error?: string;
}

/**
 * File download response.
 *
 * REST-channel envelope; deliberately distinct from `@disclaude/core`'s
 * `FileDownloadResponse` (which uses `fileRef` and no success/error envelope).
 */
export interface FileDownloadResponse {
  /** Success status. */
  success: boolean;
  /** File reference. */
  file?: FileRef;
  /** File content (base64 encoded). */
  content?: string;
  /** Error message (if failed). */
  error?: string;
}
