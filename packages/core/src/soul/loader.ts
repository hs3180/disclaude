/**
 * SoulLoader - Loads SOUL.md personality definitions for Agent injection.
 *
 * SOUL.md is a "personality definition" design pattern that defines AI's core
 * behavioral guidelines through a Markdown file, enabling Agents to drive
 * behavior through "self-awareness" rather than "rule constraints".
 *
 * Design Principles (from Issue #1315 discussion):
 * - Single explicit path: Path is specified at construction, no multi-path discovery
 * - Tilde expansion: Supports `~` in paths for user home directory
 * - Size limit: Prevents oversized SOUL.md from wasting tokens
 * - Graceful fallback: Returns null if file doesn't exist (not an error)
 *
 * Usage:
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result) {
 *   // Inject result.content into agent's system prompt
 * }
 * ```
 *
 * @module @disclaude/core/soul
 * Issue #1315: SOUL.md - Agent personality/behavior definition system
 */

import { readFile, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Maximum allowed size for a SOUL.md file (32KB).
 *
 * This prevents accidentally loading very large files that would
 * waste API tokens. A well-written SOUL.md should be under 10KB.
 * 32KB provides a generous upper bound.
 */
export const MAX_SOUL_SIZE = 32 * 1024;

/**
 * Result of a successful SOUL.md load.
 */
export interface SoulLoadResult {
  /** The content of the SOUL.md file */
  content: string;
  /** The resolved absolute path of the loaded file */
  path: string;
  /** The size of the file in bytes */
  size: number;
}

/**
 * SoulLoader - Loads SOUL.md files with safety guards.
 *
 * Features:
 * - Tilde (`~`) path expansion for user home directory
 * - File size validation to prevent token waste
 * - Graceful handling of missing files (returns null instead of throwing)
 * - Explicit path construction (no implicit discovery)
 *
 * @example
 * ```typescript
 * // Global soul from config
 * const soulConfig = Config.getSoulConfig();
 * if (soulConfig?.path) {
 *   const loader = new SoulLoader(soulConfig.path);
 *   const result = await loader.load();
 *   if (result) {
 *     options.systemPromptAppend = result.content;
 *   }
 * }
 *
 * // Per-task soul
 * const taskSoulLoader = new SoulLoader(task.soul);
 * const taskSoul = await taskSoulLoader.load();
 * ```
 */
export class SoulLoader {
  /** Resolved absolute path to the SOUL.md file */
  private readonly soulMdPath: string;

  /**
   * Create a SoulLoader for the specified path.
   *
   * The path is resolved immediately at construction time:
   * - Tilde (`~`) is expanded to the user's home directory
   * - Relative paths are resolved against the current working directory
   * - Absolute paths are kept as-is
   *
   * @param soulMdPath - Path to the SOUL.md file (supports `~` prefix)
   *
   * @example
   * ```typescript
   * new SoulLoader('~/.disclaude/SOUL.md');
   * new SoulLoader('/etc/disclaude/soul.md');
   * new SoulLoader('./config/souls/custom.md');
   * ```
   */
  constructor(soulMdPath: string) {
    this.soulMdPath = SoulLoader.resolvePath(soulMdPath);
  }

  /**
   * Resolve a soul path, expanding tilde and resolving to absolute path.
   *
   * @param soulMdPath - Raw path (may contain `~` prefix)
   * @returns Resolved absolute path
   */
  static resolvePath(soulMdPath: string): string {
    if (soulMdPath.startsWith('~')) {
      return path.join(os.homedir(), soulMdPath.slice(1));
    }
    return path.resolve(soulMdPath);
  }

  /**
   * Load the SOUL.md file content.
   *
   * Returns null if the file does not exist (graceful fallback).
   * Throws an error if the file exists but cannot be read or exceeds size limit.
   *
   * @returns SoulLoadResult with content and metadata, or null if file doesn't exist
   * @throws Error if file exceeds MAX_SOUL_SIZE or cannot be read
   *
   * @example
   * ```typescript
   * const result = await loader.load();
   * if (result) {
   *   console.log(`Loaded soul from ${result.path} (${result.size} bytes)`);
   *   console.log(result.content);
   * } else {
   *   console.log('No SOUL.md file found, using default personality');
   * }
   * ```
   */
  async load(): Promise<SoulLoadResult | null> {
    try {
      const fileStat = await stat(this.soulMdPath);

      // Validate file size
      if (fileStat.size > MAX_SOUL_SIZE) {
        throw new Error(
          `SOUL.md file exceeds maximum size of ${MAX_SOUL_SIZE} bytes ` +
          `(actual: ${fileStat.size} bytes). ` +
          `Please reduce the file size or increase MAX_SOUL_SIZE.`
        );
      }

      const content = await readFile(this.soulMdPath, 'utf-8');

      return {
        content,
        path: this.soulMdPath,
        size: fileStat.size,
      };
    } catch (error) {
      // Graceful fallback for missing files
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      // Re-throw other errors (permission denied, etc.)
      throw error;
    }
  }

  /**
   * Get the resolved absolute path to the SOUL.md file.
   *
   * @returns Absolute path
   */
  getPath(): string {
    return this.soulMdPath;
  }
}
