/**
 * SoulLoader - Pure utility for loading SOUL.md personality files.
 *
 * This module provides a simple, stateless file reader for SOUL.md content.
 * It handles:
 * - Single-path file reading (no discovery, no merging)
 * - Tilde (~) expansion for home directory paths
 * - File size limit (32KB) to prevent token waste
 * - Graceful degradation (returns null when file not found)
 *
 * Design principles (Issue #1315 simplified v2):
 * - Single responsibility: only reads files, no caching
 * - Explicit passing: content passed via function parameters
 * - Zero magic: no implicit behavior, all paths explicit
 *
 * @module @disclaude/core/soul
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Default maximum SOUL.md file size in bytes (32KB) */
export const SOUL_MAX_SIZE_BYTES = 32 * 1024;

/**
 * Result of loading a SOUL.md file.
 */
export interface SoulLoadResult {
  /** The content of the SOUL.md file */
  content: string;
  /** Absolute path to the loaded file */
  sourcePath: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * SoulLoader - Pure utility for loading SOUL.md personality files.
 *
 * This class is stateless and side-effect free. Each load() call
 * reads the file independently. No caching, no global state.
 *
 * @example
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result) {
 *   console.log(`Loaded SOUL from ${result.sourcePath} (${result.sizeBytes} bytes)`);
 *   // Pass result.content as systemPromptAppend to agent
 * }
 * ```
 */
export class SoulLoader {
  private readonly resolvedPath: string;

  /**
   * Create a SoulLoader for the given path.
   *
   * The path is resolved at construction time (tilde expansion applied).
   * The file is NOT read until load() is called.
   *
   * @param filePath - Path to the SOUL.md file (supports ~ for home directory)
   */
  constructor(filePath: string) {
    this.resolvedPath = SoulLoader.resolvePath(filePath);
  }

  /**
   * Load the SOUL.md file content.
   *
   * Returns null if:
   * - File does not exist (graceful degradation, no error thrown)
   * - File exceeds size limit (logs warning, returns null)
   * - File is empty
   *
   * @returns SoulLoadResult with content and metadata, or null if unavailable
   */
  async load(): Promise<SoulLoadResult | null> {
    try {
      const stat = await fs.stat(this.resolvedPath);

      // Check file size limit (using bytes, not characters)
      if (stat.size > SOUL_MAX_SIZE_BYTES) {
        logger.warn(
          { path: this.resolvedPath, sizeBytes: stat.size, maxSize: SOUL_MAX_SIZE_BYTES },
          'SOUL.md file exceeds size limit, skipping',
        );
        return null;
      }

      // Check for empty file
      if (stat.size === 0) {
        logger.debug({ path: this.resolvedPath }, 'SOUL.md file is empty');
        return null;
      }

      const content = await fs.readFile(this.resolvedPath, 'utf-8');

      // Trim trailing whitespace but preserve leading whitespace for formatting
      const trimmedContent = content.trimEnd();

      if (!trimmedContent) {
        logger.debug({ path: this.resolvedPath }, 'SOUL.md file has no content after trimming');
        return null;
      }

      logger.info(
        { path: this.resolvedPath, sizeBytes: stat.size, contentLength: trimmedContent.length },
        'SOUL.md loaded successfully',
      );

      return {
        content: trimmedContent,
        sourcePath: this.resolvedPath,
        sizeBytes: stat.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ path: this.resolvedPath }, 'SOUL.md file not found, skipping');
        return null;
      }

      logger.error(
        { err: error, path: this.resolvedPath },
        'Failed to load SOUL.md file',
      );
      return null;
    }
  }

  /**
   * Get the resolved absolute path for this SoulLoader.
   *
   * @returns Absolute path with tilde expanded
   */
  getResolvedPath(): string {
    return this.resolvedPath;
  }

  /**
   * Resolve a file path, expanding tilde (~) to home directory.
   *
   * This is a static utility that can be used without creating an instance.
   *
   * @param filePath - Path to resolve (supports ~ for home directory)
   * @returns Absolute path with tilde expanded
   */
  static resolvePath(filePath: string): string {
    if (filePath.startsWith('~/') || filePath === '~') {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return path.resolve(filePath);
  }
}
