/**
 * SoulLoader - Single-path SOUL.md loader for Agent personality injection.
 *
 * Issue #1315: SOUL.md - Agent 人格/行为定义系统
 *
 * Design principles (from issue feedback on PR #1440):
 * - Single explicit path given at construction time (no multi-path discovery)
 * - No merging logic (caller decides the path)
 * - Simple file read, predictable behavior
 * - Path is determined by the caller (AgentFactory / Config)
 *
 * Usage:
 * ```typescript
 * const loader = new SoulLoader('/path/to/SOUL.md');
 * const content = await loader.load();
 * // content is injected via system_prompt.append
 * ```
 *
 * @module soul/loader
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Result of loading a SOUL.md file.
 */
export interface SoulLoadResult {
  /** Whether the SOUL.md file was found and loaded */
  loaded: boolean;
  /** The SOUL.md content (empty string if not loaded) */
  content: string;
  /** The path that was attempted */
  path: string;
}

/**
 * SoulLoader - Loads a SOUL.md personality definition from a single explicit path.
 *
 * This class does NOT perform path discovery or merging. The caller is responsible
 * for determining which SOUL.md file to use. This keeps the implementation simple,
 * predictable, and debuggable.
 *
 * @example
 * ```typescript
 * // In AgentFactory or Config layer
 * const soulPath = config.soul?.path
 *   ?? path.join(os.homedir(), '.disclaude', 'SOUL.md');
 *
 * const loader = new SoulLoader(soulPath);
 * const result = await loader.load();
 *
 * if (result.loaded) {
 *   // Inject result.content into system_prompt.append
 * }
 * ```
 */
export class SoulLoader {
  private readonly soulMdPath: string;
  private readonly logger: Logger;
  private cachedResult?: SoulLoadResult;

  /**
   * Create a SoulLoader for the given path.
   *
   * @param soulMdPath - Absolute or relative path to the SOUL.md file
   */
  constructor(soulMdPath: string) {
    this.soulMdPath = path.resolve(soulMdPath);
    this.logger = createLogger('SoulLoader');
  }

  /**
   * Load the SOUL.md file content.
   *
   * Results are cached after the first successful load. Subsequent calls
   * return the cached result without re-reading the file.
   *
   * @returns SoulLoadResult with loaded status and content
   */
  async load(): Promise<SoulLoadResult> {
    // Return cached result if available
    if (this.cachedResult) {
      return this.cachedResult;
    }

    // Check if file exists
    if (!existsSync(this.soulMdPath)) {
      this.logger.debug(
        { path: this.soulMdPath },
        'SOUL.md not found, skipping personality injection'
      );
      this.cachedResult = {
        loaded: false,
        content: '',
        path: this.soulMdPath,
      };
      return this.cachedResult;
    }

    try {
      const content = await readFile(this.soulMdPath, 'utf-8');

      // Trim trailing whitespace/newlines but preserve intentional formatting
      const trimmedContent = content.trimEnd();

      this.logger.info(
        { path: this.soulMdPath, contentLength: trimmedContent.length },
        'SOUL.md loaded successfully'
      );

      this.cachedResult = {
        loaded: true,
        content: trimmedContent,
        path: this.soulMdPath,
      };
      return this.cachedResult;
    } catch (error) {
      this.logger.error(
        { err: error, path: this.soulMdPath },
        'Failed to read SOUL.md'
      );

      this.cachedResult = {
        loaded: false,
        content: '',
        path: this.soulMdPath,
      };
      return this.cachedResult;
    }
  }

  /**
   * Get the resolved path to the SOUL.md file.
   *
   * @returns Absolute path to the SOUL.md file
   */
  getPath(): string {
    return this.soulMdPath;
  }

  /**
   * Clear the cached result, forcing a re-read on next load().
   * Useful for testing or when the file may have changed.
   */
  clearCache(): void {
    this.cachedResult = undefined;
  }
}
