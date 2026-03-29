/**
 * SoulLoader - Loads SOUL.md personality definition for Agent injection.
 *
 * Issue #1315: SOUL.md Agent personality/behavior definition system.
 *
 * Design Principles (from PR #1484 review feedback):
 * - Single explicit path (no multi-path discovery)
 * - Tilde expansion for user paths (Critical #2 fix)
 * - File size limit to prevent token waste (Critical #3 fix)
 * - Graceful fallback when file doesn't exist
 *
 * Architecture:
 * ```
 * Config (soul.path) → SoulLoader(path) → load() → content → systemPrompt.append
 * ```
 *
 * @module @disclaude/core/soul
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Default maximum SOUL.md file size: 32KB */
const DEFAULT_MAX_SIZE_BYTES = 32 * 1024;

/**
 * Result of loading a SOUL.md file.
 */
export interface SoulLoadResult {
  /** Whether the file was successfully loaded */
  loaded: boolean;
  /** The loaded content (empty string if not loaded) */
  content: string;
  /** The resolved file path that was attempted */
  resolvedPath: string;
  /** Reason for not loading (undefined if loaded successfully) */
  reason?: string;
}

/**
 * SoulLoader - Loads a SOUL.md personality definition from a single explicit path.
 *
 * The path is provided at construction time (not discovered from multiple locations).
 * This makes the behavior explicit and predictable.
 *
 * Features:
 * - Tilde (~) path expansion
 * - File size limit (default 32KB)
 * - Graceful fallback when file doesn't exist
 * - Clear logging for debugging
 *
 * @example
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result.loaded) {
 *   // Inject result.content into system prompt
 * }
 * ```
 */
export class SoulLoader {
  private readonly soulPath: string;
  private readonly maxSizeBytes: number;

  /**
   * Create a SoulLoader for the given path.
   *
   * @param soulPath - Path to the SOUL.md file (supports ~ for home directory)
   * @param maxSizeBytes - Maximum file size in bytes (default: 32KB)
   */
  constructor(soulPath: string, maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES) {
    this.soulPath = soulPath;
    this.maxSizeBytes = maxSizeBytes;
  }

  /**
   * Load the SOUL.md file content.
   *
   * Handles:
   * - Tilde (~) expansion to home directory
   * - File existence check
   * - File size limit enforcement
   * - UTF-8 encoding
   *
   * @returns SoulLoadResult with loaded content or failure reason
   */
  async load(): Promise<SoulLoadResult> {
    const resolvedPath = this.resolvePath(this.soulPath);

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      logger.debug({ path: resolvedPath }, 'SOUL.md file not found, skipping');
      return {
        loaded: false,
        content: '',
        resolvedPath,
        reason: 'File not found',
      };
    }

    try {
      // Check file size before reading (Critical #3 fix)
      const stats = fs.statSync(resolvedPath);
      if (stats.size > this.maxSizeBytes) {
        logger.warn(
          { path: resolvedPath, size: stats.size, max: this.maxSizeBytes },
          'SOUL.md file exceeds size limit, skipping'
        );
        return {
          loaded: false,
          content: '',
          resolvedPath,
          reason: `File size (${stats.size} bytes) exceeds limit (${this.maxSizeBytes} bytes)`,
        };
      }

      // Read file content
      const content = fs.readFileSync(resolvedPath, 'utf-8').trim();

      if (!content) {
        logger.debug({ path: resolvedPath }, 'SOUL.md file is empty, skipping');
        return {
          loaded: false,
          content: '',
          resolvedPath,
          reason: 'File is empty',
        };
      }

      logger.info(
        { path: resolvedPath, size: stats.size },
        'SOUL.md loaded successfully'
      );

      return {
        loaded: true,
        content,
        resolvedPath,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ path: resolvedPath, err: message }, 'Failed to load SOUL.md');
      return {
        loaded: false,
        content: '',
        resolvedPath,
        reason: `Read error: ${message}`,
      };
    }
  }

  /**
   * Resolve a path, expanding ~ to the user's home directory.
   *
   * Critical #2 fix: Users configure paths like `~/.disclaude/SOUL.md`,
   * which must be expanded before use.
   *
   * @param filePath - Path to resolve (may contain ~)
   * @returns Resolved absolute path
   */
  private resolvePath(filePath: string): string {
    if (filePath.startsWith('~')) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return path.resolve(filePath);
  }
}
