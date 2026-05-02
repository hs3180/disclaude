/**
 * SoulLoader - SOUL.md file loading utility.
 *
 * Reads a SOUL.md file from a given path, performs tilde expansion,
 * enforces a size limit (32 KB), and returns the content string.
 *
 * Design principles (from Issue #1315 simplified v2):
 * - Single-path file reading only
 * - No caching, no merging, no discovery
 * - Tilde expansion + size limit + graceful degradation
 * - All paths are explicitly configured
 *
 * @module @disclaude/core/soul
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Maximum allowed SOUL.md file size (32 KB) */
const MAX_SOUL_SIZE_BYTES = 32 * 1024;

/**
 * Result of a successful soul file load.
 */
export interface SoulLoadResult {
  /** The soul content text */
  content: string;
  /** Absolute path the file was loaded from */
  path: string;
  /** File size in bytes */
  size: number;
}

/**
 * SoulLoader - Pure utility class for loading SOUL.md files.
 *
 * Usage:
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result) {
 *   console.log(result.content);
 * }
 * ```
 */
export class SoulLoader {
  private readonly resolvedPath: string;

  /**
   * Create a SoulLoader for the given path.
   *
   * @param filePath - Path to the SOUL.md file (supports ~ expansion)
   */
  constructor(filePath: string) {
    this.resolvedPath = SoulLoader.resolvePath(filePath);
  }

  /**
   * Load and return the SOUL.md file content.
   *
   * Returns null if:
   * - The file does not exist
   * - The file exceeds the size limit
   * - A read error occurs
   *
   * @returns SoulLoadResult with content, or null if file unavailable
   */
  async load(): Promise<SoulLoadResult | null> {
    try {
      if (!existsSync(this.resolvedPath)) {
        logger.debug({ path: this.resolvedPath }, 'SOUL.md file not found');
        return null;
      }

      const content = await readFile(this.resolvedPath, 'utf-8');
      const size = Buffer.byteLength(content, 'utf-8');

      if (size > MAX_SOUL_SIZE_BYTES) {
        logger.warn(
          { path: this.resolvedPath, size, max: MAX_SOUL_SIZE_BYTES },
          'SOUL.md file exceeds size limit, skipping'
        );
        return null;
      }

      logger.info(
        { path: this.resolvedPath, size },
        'SOUL.md file loaded successfully'
      );

      return {
        content,
        path: this.resolvedPath,
        size,
      };
    } catch (error) {
      logger.warn(
        { path: this.resolvedPath, err: error },
        'Failed to load SOUL.md file'
      );
      return null;
    }
  }

  /**
   * Resolve a file path with tilde (~) expansion.
   *
   * @param filePath - Path that may start with ~
   * @returns Resolved absolute path
   */
  static resolvePath(filePath: string): string {
    if (filePath.startsWith('~')) {
      return resolve(homedir(), filePath.slice(1));
    }
    return resolve(filePath);
  }

  /**
   * Get the resolved path (useful for debugging).
   */
  get resolvedFilePath(): string {
    return this.resolvedPath;
  }
}
