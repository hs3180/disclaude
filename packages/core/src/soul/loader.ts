/**
 * SoulLoader - Simple SOUL.md file loader for Agent personality injection.
 *
 * Loads a SOUL.md file from a single explicit path and returns its content.
 * Used to inject personality/behavior definitions into the Agent system prompt
 * via the SDK's systemPrompt.append mechanism.
 *
 * Design principles (from Issue #1315 discussion):
 * - Single explicit path at construction (no multi-path discovery)
 * - Explicit config, predictable behavior
 * - Simple file read (no priority merging)
 * - Path controlled by config/caller
 *
 * @module soul/loader
 */

import { readFile } from 'node:fs/promises';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/**
 * Result of loading a SOUL.md file.
 */
export interface SoulLoadResult {
  /** Whether a SOUL.md file was found and loaded */
  loaded: boolean;
  /** Path to the SOUL.md file that was loaded */
  path: string;
  /** Content of the SOUL.md file (empty string if not found) */
  content: string;
}

/**
 * SOUL.md loader.
 *
 * Reads a SOUL.md file from a single explicit path.
 * If the file does not exist, returns empty content gracefully.
 *
 * @example
 * ```typescript
 * const loader = new SoulLoader('~/.disclaude/SOUL.md');
 * const result = await loader.load();
 * if (result.loaded) {
 *   console.log(`Loaded SOUL from ${result.path} (${result.content.length} chars)`);
 * }
 * ```
 */
export class SoulLoader {
  private readonly soulMdPath: string;

  /**
   * Create a SoulLoader for the given path.
   *
   * @param soulMdPath - Absolute or relative path to the SOUL.md file
   */
  constructor(soulMdPath: string) {
    this.soulMdPath = soulMdPath;
  }

  /**
   * Get the configured SOUL.md path.
   *
   * @returns The path to the SOUL.md file
   */
  getPath(): string {
    return this.soulMdPath;
  }

  /**
   * Load the SOUL.md file content.
   *
   * If the file does not exist, returns a result with `loaded: false`
   * and empty content. This allows callers to gracefully handle missing files.
   *
   * @returns SoulLoadResult with loaded status, path, and content
   */
  async load(): Promise<SoulLoadResult> {
    try {
      const content = await readFile(this.soulMdPath, 'utf-8');

      // Trim whitespace and skip empty files
      const trimmed = content.trim();
      if (trimmed.length === 0) {
        logger.debug({ path: this.soulMdPath }, 'SOUL.md file is empty');
        return { loaded: false, path: this.soulMdPath, content: '' };
      }

      logger.info(
        { path: this.soulMdPath, contentLength: trimmed.length },
        'SOUL.md loaded successfully'
      );

      return { loaded: true, path: this.soulMdPath, content: trimmed };
    } catch (error: unknown) {
      if (isFileNotFoundError(error)) {
        logger.debug({ path: this.soulMdPath }, 'SOUL.md file not found');
        return { loaded: false, path: this.soulMdPath, content: '' };
      }

      // Log unexpected errors but still return gracefully
      logger.warn(
        { path: this.soulMdPath, err: error instanceof Error ? error.message : String(error) },
        'Failed to load SOUL.md'
      );
      return { loaded: false, path: this.soulMdPath, content: '' };
    }
  }
}

/**
 * Create a SoulLoader from configuration.
 *
 * Resolves the SOUL.md path using the following priority:
 * 1. Explicit path from config (`soul.path`)
 * 2. Default path (`~/.disclaude/SOUL.md`)
 *
 * If no path is configured and no default exists, returns null.
 *
 * @param configPath - Optional explicit path from config
 * @returns SoulLoader instance, or null if no path available
 *
 * @example
 * ```typescript
 * const loader = createSoulLoader(config.soul?.path);
 * if (loader) {
 *   const result = await loader.load();
 *   if (result.loaded) {
 *     options.systemPrompt = { type: 'preset', preset: 'claude_code', append: result.content };
 *   }
 * }
 * ```
 */
export function createSoulLoader(configPath?: string): SoulLoader | null {
  const path = configPath ?? getDefaultSoulPath();
  if (!path) {
    return null;
  }

  return new SoulLoader(path);
}

/**
 * Get the default SOUL.md path.
 *
 * @returns Default path (`~/.disclaude/SOUL.md`), or null if HOME is not set
 */
export function getDefaultSoulPath(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    return null;
  }

  return `${home}/.disclaude/SOUL.md`;
}

/**
 * Check if an error is a "file not found" error.
 */
function isFileNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    return 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  return false;
}
