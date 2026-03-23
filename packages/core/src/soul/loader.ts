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

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Maximum allowed SOUL.md file size (32KB). */
const MAX_SOUL_FILE_SIZE = 32 * 1024;

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
 * Expand a tilde (~) prefix to the user's home directory.
 *
 * @param filePath - Path that may start with ~
 * @returns Expanded absolute path
 */
export function expandTilde(filePath: string): string {
  if (filePath === '~' || filePath.startsWith('~/')) {
    const home = os.homedir();
    return filePath === '~' ? home : path.join(home, filePath.slice(1));
  }
  return filePath;
}

/**
 * SOUL.md loader.
 *
 * Reads a SOUL.md file from a single explicit path.
 * If the file does not exist, returns empty content gracefully.
 *
 * Features:
 * - Tilde (~) path expansion
 * - File size limit (32KB)
 * - Graceful handling of missing files
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
   * The path is resolved (tilde expanded) at construction time.
   *
   * @param soulMdPath - Absolute or relative path to the SOUL.md file
   */
  constructor(soulMdPath: string) {
    this.soulMdPath = expandTilde(soulMdPath);
  }

  /**
   * Get the resolved SOUL.md path (after tilde expansion).
   *
   * @returns The resolved path to the SOUL.md file
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
   * If the file exceeds MAX_SOUL_FILE_SIZE (32KB), logs a warning
   * and returns loaded=false to prevent token waste.
   *
   * @returns SoulLoadResult with loaded status, path, and content
   */
  async load(): Promise<SoulLoadResult> {
    try {
      // Check file size before reading (Critical #3: file size limit)
      const stats = await stat(this.soulMdPath);
      if (stats.size > MAX_SOUL_FILE_SIZE) {
        logger.warn(
          { path: this.soulMdPath, size: stats.size, max: MAX_SOUL_FILE_SIZE },
          'SOUL.md file exceeds maximum size, skipping'
        );
        return { loaded: false, path: this.soulMdPath, content: '' };
      }

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
  const resolvedPath = configPath ?? getDefaultSoulPath();
  if (!resolvedPath) {
    return null;
  }

  return new SoulLoader(resolvedPath);
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

  return path.join(home, '.disclaude', 'SOUL.md');
}

/**
 * Resolve a soul path that may be:
 * - An absolute path
 * - A relative path starting with ~/ (expanded to home dir)
 * - A bare name (looked up in ~/.disclaude/souls/ directory)
 *
 * Used by ScheduleExecutor for per-task soul resolution.
 *
 * @param soulSpec - Soul path or name from ScheduledTask.soul
 * @returns Resolved absolute path, or null if unresolvable
 */
export function resolveSoulPath(soulSpec: string): string | null {
  if (!soulSpec) {
    return null;
  }

  // Already absolute path (or tilde path)
  if (path.isAbsolute(soulSpec) || soulSpec.startsWith('~/')) {
    return expandTilde(soulSpec);
  }

  // Bare name: look up in ~/.disclaude/souls/
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    return null;
  }

  const namedPath = path.join(home, '.disclaude', 'souls', `${soulSpec}.md`);
  return namedPath;
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
