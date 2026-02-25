/**
 * File Storage Service
 *
 * Manages file storage and retrieval for the Communication Node.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { createFileReference, type FileReference, type StoredFile } from '../types/file-reference.js';

const logger = createLogger('FileStorageService');

/**
 * File storage service configuration.
 */
export interface FileStorageConfig {
  /** Root directory for file storage */
  storageDir: string;

  /** Maximum file size (bytes), default 100MB */
  maxFileSize?: number;
}

/**
 * File Storage Service
 */
export class FileStorageService {
  private storageDir: string;
  private maxFileSize: number;

  /** File storage mapping: id -> StoredFile */
  private files = new Map<string, StoredFile>();

  constructor(config: FileStorageConfig) {
    this.storageDir = config.storageDir;
    this.maxFileSize = config.maxFileSize ?? 100 * 1024 * 1024; // 100MB

    logger.info({
      storageDir: this.storageDir,
      maxFileSize: this.maxFileSize,
    }, 'FileStorageService created');
  }

  /**
   * Initialize the storage service.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true });
    logger.info({ storageDir: this.storageDir }, 'FileStorageService initialized');
  }

  /**
   * Store a file from a local path.
   */
  async storeFromLocal(
    localPath: string,
    fileName: string,
    mimeType?: string,
    source: 'user' | 'agent' = 'user',
    chatId?: string
  ): Promise<FileReference> {
    const stats = await fs.stat(localPath);

    if (stats.size > this.maxFileSize) {
      throw new Error(`File size exceeds maximum allowed size: ${stats.size} > ${this.maxFileSize}`);
    }

    const fileRef = createFileReference(fileName, source, {
      mimeType,
      size: stats.size,
      chatId,
    });

    const fileDir = path.join(this.storageDir, fileRef.id);
    await fs.mkdir(fileDir, { recursive: true });

    const storedPath = path.join(fileDir, fileName);
    await fs.copyFile(localPath, storedPath);

    fileRef.storageKey = storedPath;
    this.files.set(fileRef.id, { ref: fileRef, localPath: storedPath });

    logger.info({
      fileId: fileRef.id,
      fileName,
      size: stats.size,
      source,
    }, 'File stored from local path');

    return fileRef;
  }

  /**
   * Store a file from base64 content.
   */
  async storeFromBase64(
    content: string,
    fileName: string,
    mimeType?: string,
    source: 'user' | 'agent' = 'agent',
    chatId?: string
  ): Promise<FileReference> {
    const buffer = Buffer.from(content, 'base64');

    if (buffer.length > this.maxFileSize) {
      throw new Error(`File size exceeds maximum allowed size: ${buffer.length} > ${this.maxFileSize}`);
    }

    const fileRef = createFileReference(fileName, source, {
      mimeType,
      size: buffer.length,
      chatId,
    });

    const fileDir = path.join(this.storageDir, fileRef.id);
    await fs.mkdir(fileDir, { recursive: true });

    const storedPath = path.join(fileDir, fileName);
    await fs.writeFile(storedPath, buffer);

    fileRef.storageKey = storedPath;
    this.files.set(fileRef.id, { ref: fileRef, localPath: storedPath });

    logger.info({
      fileId: fileRef.id,
      fileName,
      size: buffer.length,
      source,
    }, 'File stored from base64');

    return fileRef;
  }

  /**
   * Get a file by ID.
   */
  get(fileId: string): StoredFile | undefined {
    return this.files.get(fileId);
  }

  /**
   * Get file content as base64.
   */
  async getContent(fileId: string): Promise<string> {
    const stored = this.files.get(fileId);
    if (!stored) {
      throw new Error(`File not found: ${fileId}`);
    }

    const buffer = await fs.readFile(stored.localPath);
    return buffer.toString('base64');
  }

  /**
   * Get file local path.
   */
  getLocalPath(fileId: string): string | undefined {
    const stored = this.files.get(fileId);
    return stored?.localPath;
  }

  /**
   * Delete a file.
   */
  async delete(fileId: string): Promise<boolean> {
    const stored = this.files.get(fileId);
    if (!stored) {
      return false;
    }

    try {
      const fileDir = path.dirname(stored.localPath);
      await fs.rm(fileDir, { recursive: true, force: true });
      this.files.delete(fileId);

      logger.info({ fileId }, 'File deleted');
      return true;
    } catch (error) {
      logger.error({ err: error, fileId }, 'Failed to delete file');
      return false;
    }
  }

  /**
   * Check if a file exists.
   */
  has(fileId: string): boolean {
    return this.files.has(fileId);
  }

  /**
   * Get storage statistics.
   */
  getStats(): {
    totalFiles: number;
    totalSize: number;
  } {
    let totalSize = 0;

    for (const stored of this.files.values()) {
      totalSize += stored.ref.size ?? 0;
    }

    return {
      totalFiles: this.files.size,
      totalSize,
    };
  }

  /**
   * Shutdown the storage service.
   */
  shutdown(): void {
    logger.info('FileStorageService shutdown');
  }
}
