/**
 * SoulLoader - Pure utility class for loading SOUL.md personality files.
 *
 * Issue #1315: SOUL.md Agent personality/behavior definition system.
 *
 * Design principles (simplified v2):
 * - Single responsibility: Only reads files, no caching/merging/discovery
 * - Explicit passing: Soul content passed via function parameters, no static cache
 * - Startup loading: Loaded once at application startup
 * - Zero magic: All paths explicitly specified via configuration
 *
 * @module soul/loader
 */

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/** Default maximum SOUL.md file size (32KB) */
const DEFAULT_MAX_SIZE_BYTES = 32 * 1024;

/**
 * Result from loading a SOUL.md file.
 */
export interface SoulLoadResult {
  /** Loaded soul content */
  content: string;
  /** Source file path (resolved, absolute) */
  sourcePath: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * Pure utility class for loading SOUL.md personality files.
 *
 * Reads a single file, performs tilde expansion, enforces size limits,
 * and returns null for missing files (graceful degradation).
 *
 * No caching, no discovery, no merging — just file reading.
 *
 * @example
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result) {
 *   console.log(`Loaded soul from ${result.sourcePath} (${result.sizeBytes} bytes)`);
 *   // Pass result.content as systemPromptAppend to AgentFactory
 * }
 * ```
 */
export class SoulLoader {
  private readonly resolvedPath: string;
  private readonly maxSizeBytes: number;

  /**
   * Create a SoulLoader for the given path.
   *
   * @param filePath - Path to the SOUL.md file (supports ~ for home directory)
   * @param maxSizeBytes - Maximum allowed file size in bytes (default: 32KB)
   */
  constructor(filePath: string, maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES) {
    this.resolvedPath = SoulLoader.resolvePath(filePath);
    this.maxSizeBytes = maxSizeBytes;
  }

  /**
   * Load and validate the SOUL.md file.
   *
   * Returns null if:
   * - File does not exist (graceful degradation)
   * - File exceeds size limit
   * - File cannot be read (permissions, etc.)
   *
   * @returns SoulLoadResult with content and metadata, or null if unavailable
   */
  async load(): Promise<SoulLoadResult | null> {
    try {
      // Check file exists and get stats
      const stat = await fsPromises.stat(this.resolvedPath);

      // Validate file size using byte length (fixes Unicode bug from PR #1632)
      // stat.size returns bytes, which is the correct metric for size limits
      if (stat.size > this.maxSizeBytes) {
        return null;
      }

      // Read file content
      const content = await fsPromises.readFile(this.resolvedPath, 'utf-8');

      return {
        content,
        sourcePath: this.resolvedPath,
        sizeBytes: stat.size,
      };
    } catch (error) {
      // Graceful degradation: return null for any file system error
      // (file not found, permission denied, etc.)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      return null;
    }
  }

  /**
   * Resolve a file path, expanding ~ to home directory.
   *
   * @param filePath - Path to resolve (may start with ~)
   * @returns Absolute resolved path
   */
  static resolvePath(filePath: string): string {
    if (filePath.startsWith('~/')) {
      return path.join(os.homedir(), filePath.slice(2));
    }
    return path.resolve(filePath);
  }
}
