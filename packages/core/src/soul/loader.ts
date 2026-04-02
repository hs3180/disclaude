/**
 * SoulLoader - Pure utility class for loading SOUL.md files.
 *
 * Reads a single SOUL.md file and returns its content for injection
 * into the Agent's system prompt via `systemPromptAppend`.
 *
 * Design principles (Issue #1315 简化版 v2):
 * - Single responsibility: only reads files, no caching/merging/discovery
 * - Explicit passing: content flows through function parameters, no static state
 * - Zero magic: all paths explicitly configured, no implicit behavior
 *
 * @module @disclaude/core/soul
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Maximum allowed SOUL.md file size in bytes (32 KB). */
export const SOUL_MAX_SIZE_BYTES = 32 * 1024;

/**
 * Result of a successful SOUL.md load.
 */
export interface SoulLoadResult {
  /** The resolved absolute path of the loaded file. */
  resolvedPath: string;
  /** The file content as a UTF-8 string. */
  content: string;
  /** The file size in bytes (from stat, not content.length). */
  sizeBytes: number;
}

/**
 * SoulLoader - Reads a single SOUL.md file from a configured path.
 *
 * Features:
 * - Tilde (`~`) expansion in paths
 * - File size limit (32 KB) to prevent token waste
 * - Graceful degradation: returns null if file doesn't exist
 * - No caching: each `load()` call reads from disk
 *
 * @example
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result) {
 *   console.log(`Loaded ${result.sizeBytes} bytes from ${result.resolvedPath}`);
 * }
 * ```
 */
export class SoulLoader {
  private readonly resolvedPath: string;

  /**
   * Create a SoulLoader for the given file path.
   *
   * The path is resolved at construction time:
   * - Tilde (`~`) is expanded to the user's home directory
   * - Relative paths are kept as-is (caller should provide absolute paths)
   *
   * @param filePath - Path to the SOUL.md file (may contain `~`)
   */
  constructor(filePath: string) {
    this.resolvedPath = SoulLoader.resolvePath(filePath);
  }

  /**
   * Load and return the SOUL.md file content.
   *
   * @returns SoulLoadResult if the file exists and is within size limits, null otherwise
   */
  async load(): Promise<SoulLoadResult | null> {
    try {
      const stat = await fs.stat(this.resolvedPath);

      // Check file size limit (using bytes from stat, not content length)
      if (stat.size > SOUL_MAX_SIZE_BYTES) {
        logger.warn(
          { path: this.resolvedPath, sizeBytes: stat.size, maxBytes: SOUL_MAX_SIZE_BYTES },
          'SOUL.md file exceeds size limit, skipping',
        );
        return null;
      }

      const content = await fs.readFile(this.resolvedPath, 'utf-8');

      logger.info(
        { path: this.resolvedPath, sizeBytes: stat.size, contentLength: content.length },
        'SOUL.md loaded successfully',
      );

      return {
        resolvedPath: this.resolvedPath,
        content,
        sizeBytes: stat.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ path: this.resolvedPath }, 'SOUL.md file not found, skipping');
        return null;
      }
      logger.error({ err: error, path: this.resolvedPath }, 'Failed to read SOUL.md');
      return null;
    }
  }

  /**
   * Resolve a file path, expanding tilde (`~`) to the user's home directory.
   *
   * This is a static utility so callers can resolve paths without
   * instantiating a SoulLoader.
   *
   * @param filePath - Path that may contain a leading `~`
   * @returns Absolute path with `~` expanded
   */
  static resolvePath(filePath: string): string {
    if (filePath.startsWith('~')) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
  }
}
