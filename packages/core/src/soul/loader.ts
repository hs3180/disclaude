/**
 * SoulLoader - Pure utility class for loading SOUL.md files.
 *
 * SoulLoader provides a minimal, stateless mechanism for reading a single SOUL.md
 * file and returning its content for injection into Agent system prompts.
 *
 * Design principles (Issue #1315, simplified v2):
 * - Single responsibility: Only reads files, no caching or merging
 * - Explicit passing: Soul content is passed via function parameters, not static state
 * - Zero magic: All paths are explicitly configured, no implicit discovery
 * - Graceful degradation: Returns null if file doesn't exist, logs warning
 *
 * @module soul/loader
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Maximum SOUL.md file size in bytes (32 KB) */
const MAX_SOUL_SIZE_BYTES = 32 * 1024;

/**
 * Result of loading a SOUL.md file.
 */
export interface SoulLoadResult {
  /** The resolved absolute path of the loaded file */
  resolvedPath: string;
  /** The content of the SOUL.md file */
  content: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * SoulLoader - Pure utility class for loading SOUL.md personality files.
 *
 * Reads a single SOUL.md file from an explicit path, performing:
 * - Tilde (~) expansion for home directory paths
 * - File size validation (max 32KB)
 * - UTF-8 text reading
 *
 * Does NOT perform caching, multi-path discovery, or merging.
 * The caller is responsible for deciding when and how often to load.
 *
 * @example
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result) {
 *   // result.content contains the soul text
 *   agentOptions.systemPromptAppend = result.content;
 * }
 * ```
 */
export class SoulLoader {
  private readonly resolvedPath: string;

  /**
   * Create a SoulLoader for the given path.
   *
   * The path is resolved at construction time:
   * - Tilde (~) is expanded to the user's home directory
   * - Relative paths are NOT resolved (caller should pass absolute paths)
   *
   * @param filePath - Path to the SOUL.md file
   */
  constructor(filePath: string) {
    this.resolvedPath = SoulLoader.resolvePath(filePath);
  }

  /**
   * Load the SOUL.md file.
   *
   * @returns SoulLoadResult with content, or null if file doesn't exist or is invalid
   */
  async load(): Promise<SoulLoadResult | null> {
    try {
      // Check file exists and get stats
      const stat = await fs.stat(this.resolvedPath);

      // Validate file size (in bytes, not characters)
      if (stat.size > MAX_SOUL_SIZE_BYTES) {
        logger.warn(
          { path: this.resolvedPath, sizeBytes: stat.size, maxSize: MAX_SOUL_SIZE_BYTES },
          'SOUL.md file exceeds maximum size, skipping'
        );
        return null;
      }

      // Read file content
      const content = await fs.readFile(this.resolvedPath, 'utf-8');

      if (!content.trim()) {
        logger.warn({ path: this.resolvedPath }, 'SOUL.md file is empty, skipping');
        return null;
      }

      logger.info(
        { path: this.resolvedPath, sizeBytes: stat.size, contentLength: content.length },
        'SOUL.md loaded successfully'
      );

      return {
        resolvedPath: this.resolvedPath,
        content,
        sizeBytes: stat.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist - this is expected, don't warn
        logger.debug({ path: this.resolvedPath }, 'SOUL.md file not found, using default personality');
        return null;
      }

      logger.error(
        { err: error, path: this.resolvedPath },
        'Failed to load SOUL.md file'
      );
      return null;
    }
  }

  /**
   * Get the resolved path for this loader.
   *
   * @returns The resolved absolute path
   */
  getResolvedPath(): string {
    return this.resolvedPath;
  }

  /**
   * Resolve a file path, expanding tilde (~) to home directory.
   *
   * This is a static utility method that can be used without creating a loader.
   *
   * @param filePath - Path to resolve (may contain ~)
   * @returns Resolved path with tilde expanded
   */
  static resolvePath(filePath: string): string {
    if (filePath.startsWith('~/') || filePath === '~') {
      const home = process.env.HOME || process.env.USERPROFILE || '/root';
      return path.join(home, filePath.slice(2));
    }
    return filePath;
  }
}
