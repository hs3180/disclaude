/**
 * SoulLoader - Pure utility class for loading SOUL.md files.
 *
 * Issue #1315: SOUL.md Agent personality/behavior definition system.
 *
 * Design principles (simplified v2):
 * - Single path: reads from one explicit path, no multi-path discovery
 * - Tilde expansion: supports `~/.disclaude/SOUL.md` style paths
 * - Size limit: 32KB max to prevent token waste
 * - Graceful degradation: returns null if file not found or invalid
 * - No caching: caller is responsible for caching if needed
 *
 * @module soul/loader
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Maximum SOUL.md file size in bytes (32KB) */
export const SOUL_MAX_SIZE_BYTES = 32 * 1024;

/**
 * Result of a successful SoulLoader.load() call.
 */
export interface SoulLoadResult {
  /** The resolved absolute path to the SOUL.md file */
  resolvedPath: string;
  /** The content of the SOUL.md file */
  content: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * Error types for SoulLoader operations.
 */
export type SoulLoadErrorReason =
  | 'not_found'
  | 'too_large'
  | 'read_error';

/**
 * Error result from SoulLoader.load().
 */
export interface SoulLoadError {
  /** The reason the load failed */
  reason: SoulLoadErrorReason;
  /** Human-readable error message */
  message: string;
}

/**
 * SoulLoader - Pure utility class for loading SOUL.md personality files.
 *
 * Usage:
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result) {
 *   console.log(result.content); // SOUL.md content
 * } else {
 *   // File not found or invalid - use default behavior
 * }
 * ```
 */
export class SoulLoader {
  private readonly rawPath: string;
  private readonly resolvedPath: string;

  /**
   * Create a SoulLoader for the given path.
   *
   * @param soulPath - Path to the SOUL.md file (supports ~ expansion)
   */
  constructor(soulPath: string) {
    this.rawPath = soulPath;
    this.resolvedPath = SoulLoader.resolvePath(soulPath);
  }

  /**
   * Resolve a path, expanding ~ to the user's home directory.
   *
   * @param filePath - Path to resolve (may start with ~)
   * @returns Absolute resolved path
   */
  static resolvePath(filePath: string): string {
    if (filePath.startsWith('~')) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return path.resolve(filePath);
  }

  /**
   * Get the raw (unresolved) path.
   */
  getRawPath(): string {
    return this.rawPath;
  }

  /**
   * Get the resolved absolute path.
   */
  getResolvedPath(): string {
    return this.resolvedPath;
  }

  /**
   * Load the SOUL.md file.
   *
   * Returns null if the file does not exist (graceful degradation).
   * Returns an error object if the file exists but cannot be loaded.
   * Returns a SoulLoadResult if the file was loaded successfully.
   *
   * @returns SoulLoadResult on success, SoulLoadError on failure, null if not found
   */
  async load(): Promise<SoulLoadResult | SoulLoadError | null> {
    try {
      // Check file exists and get size
      const stat = await fsPromises.stat(this.resolvedPath);

      // Check size limit (use fileStat.size which is bytes, not content.length)
      if (stat.size > SOUL_MAX_SIZE_BYTES) {
        const message = `SOUL.md file too large: ${stat.size} bytes (max ${SOUL_MAX_SIZE_BYTES} bytes)`;
        logger.warn({ path: this.resolvedPath, size: stat.size, maxSize: SOUL_MAX_SIZE_BYTES }, message);
        return { reason: 'too_large', message };
      }

      // Read file content
      const content = await fsPromises.readFile(this.resolvedPath, 'utf-8');

      // Double-check content size (stat.size is bytes, content.length is characters)
      // We use Buffer.byteLength for accurate byte measurement
      const byteLength = Buffer.byteLength(content, 'utf-8');
      if (byteLength > SOUL_MAX_SIZE_BYTES) {
        const message = `SOUL.md content too large: ${byteLength} bytes (max ${SOUL_MAX_SIZE_BYTES} bytes)`;
        logger.warn({ path: this.resolvedPath, byteLength, maxSize: SOUL_MAX_SIZE_BYTES }, message);
        return { reason: 'too_large', message };
      }

      logger.info(
        { path: this.resolvedPath, sizeBytes: byteLength },
        'SOUL.md loaded successfully',
      );

      return {
        resolvedPath: this.resolvedPath,
        content,
        sizeBytes: byteLength,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ path: this.resolvedPath }, 'SOUL.md file not found, using default behavior');
        return null;
      }

      const message = `Failed to read SOUL.md: ${(error as Error).message}`;
      logger.error({ err: error, path: this.resolvedPath }, message);
      return { reason: 'read_error', message };
    }
  }
}
