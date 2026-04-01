/**
 * SoulLoader - Pure utility class for loading SOUL.md files.
 *
 * SOUL.md is a personality definition pattern that defines AI core behavioral
 * guidelines through a Markdown file, enabling Agents to drive behavior through
 * "self-awareness" rather than "rule constraints".
 *
 * Design Principles (Issue #1315 Simplified v2):
 * - Single responsibility: Only reads files, no caching/merging/discovery
 * - Explicit passing: Soul content passes through function parameters, no static cache
 * - Startup loading: Loaded once at application startup, no cold start issues
 * - Zero magic: No implicit behavior, all paths explicitly configured
 *
 * @module soul/loader
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Default maximum file size for SOUL.md (32KB) */
const DEFAULT_MAX_SIZE_BYTES = 32 * 1024;

/**
 * Result of loading a SOUL.md file.
 */
export interface SoulLoadResult {
  /** The resolved absolute path to the SOUL.md file */
  path: string;
  /** The content of the SOUL.md file */
  content: string;
  /** The file size in bytes */
  size: number;
}

/**
 * SoulLoader - Pure utility class for loading SOUL.md files.
 *
 * Features:
 * - Single path file reading (no discovery, no merging)
 * - Tilde (~) path expansion
 * - File size limit (default: 32KB)
 * - Returns null when file doesn't exist (graceful degradation)
 * - No caching (caller is responsible for caching if needed)
 *
 * @example
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result) {
 *   console.log(`Loaded SOUL.md from ${result.path} (${result.size} bytes)`);
 * }
 * ```
 */
export class SoulLoader {
  private readonly resolvedPath: string;
  private readonly maxSizeBytes: number;

  /**
   * Create a SoulLoader instance.
   *
   * @param filePath - Path to the SOUL.md file (supports ~ for home directory)
   * @param options - Optional configuration
   * @param options.maxSizeBytes - Maximum file size in bytes (default: 32KB)
   */
  constructor(filePath: string, options?: { maxSizeBytes?: number }) {
    this.resolvedPath = SoulLoader.resolvePath(filePath);
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  }

  /**
   * Resolve a file path, expanding ~ to the user's home directory.
   *
   * @param filePath - Path to resolve (may start with ~)
   * @returns Absolute resolved path
   */
  static resolvePath(filePath: string): string {
    if (filePath.startsWith('~')) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    // If path is relative, resolve against cwd
    if (!path.isAbsolute(filePath)) {
      return path.resolve(filePath);
    }
    return filePath;
  }

  /**
   * Load the SOUL.md file.
   *
   * @returns SoulLoadResult if the file exists and is valid, null otherwise
   *
   * Failure cases (all return null):
   * - File does not exist
   * - File size exceeds maxSizeBytes
   * - File cannot be read (permission error, etc.)
   */
  async load(): Promise<SoulLoadResult | null> {
    try {
      // Check file exists and get stats
      const stat = await fs.stat(this.resolvedPath);
      if (!stat.isFile()) {
        logger.warn({ path: this.resolvedPath }, 'SOUL.md path is not a file');
        return null;
      }

      // Check file size
      if (stat.size > this.maxSizeBytes) {
        logger.warn(
          { path: this.resolvedPath, size: stat.size, maxSize: this.maxSizeBytes },
          'SOUL.md file exceeds maximum size, ignoring'
        );
        return null;
      }

      // Read file content
      const content = await fs.readFile(this.resolvedPath, 'utf-8');

      // Validate content is non-empty
      if (!content.trim()) {
        logger.warn({ path: this.resolvedPath }, 'SOUL.md file is empty, ignoring');
        return null;
      }

      logger.info(
        { path: this.resolvedPath, size: content.length },
        'SOUL.md loaded successfully'
      );

      return {
        path: this.resolvedPath,
        content: content.trim(),
        size: stat.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist - this is normal, not an error
        logger.debug({ path: this.resolvedPath }, 'SOUL.md file not found, skipping');
        return null;
      }

      // Other errors (permission, etc.)
      logger.error(
        { err: error, path: this.resolvedPath },
        'Failed to load SOUL.md'
      );
      return null;
    }
  }

  /**
   * Get the resolved absolute path.
   *
   * @returns Resolved path string
   */
  getPath(): string {
    return this.resolvedPath;
  }
}
