/**
 * CLAUDE.md Loader - Reads CLAUDE.md from a project directory.
 *
 * Issue #1506: When handling development tasks, agents should automatically
 * load the CLAUDE.md from the target project's root directory to understand
 * project conventions, coding standards, and development guidelines.
 *
 * Design:
 * - Reads CLAUDE.md from a specified project directory
 * - Enforces a size limit to prevent token bloat (default: 32KB)
 * - Graceful handling: ENOENT silently skipped, other errors logged
 * - Returns undefined when file doesn't exist or on error
 *
 * @module utils/claude-md-loader
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('ClaudeMdLoader');

/** Default maximum size for CLAUDE.md content (32KB). */
const DEFAULT_MAX_SIZE = 32 * 1024;

/**
 * Load CLAUDE.md content from a project directory.
 *
 * Reads `CLAUDE.md` from the specified directory, validates size limits,
 * and returns the content as a string. Returns `undefined` if the file
 * doesn't exist or on unrecoverable errors.
 *
 * @param projectDir - Absolute path to the project root directory
 * @param maxSize - Maximum allowed file size in bytes (default: 32KB)
 * @returns CLAUDE.md content string, or undefined if not found/error
 *
 * @example
 * ```typescript
 * const content = await loadClaudeMd('/path/to/project');
 * if (content) {
 *   console.log(`Loaded ${content.length} bytes of project context`);
 * }
 * ```
 */
export async function loadClaudeMd(
  projectDir: string,
  maxSize: number = DEFAULT_MAX_SIZE
): Promise<string | undefined> {
  const filePath = join(projectDir, 'CLAUDE.md');

  try {
    const content = await readFile(filePath, 'utf-8');

    if (content.length > maxSize) {
      const truncated = content.slice(0, maxSize);
      logger.warn(
        { filePath, originalSize: content.length, maxSize, truncatedSize: truncated.length },
        'CLAUDE.md exceeds size limit, truncating'
      );
      return truncated + '\n\n... [truncated]';
    }

    logger.info(
      { filePath, size: content.length },
      'CLAUDE.md loaded successfully'
    );

    return content;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === 'ENOENT') {
      // File doesn't exist — this is expected for many projects
      logger.debug({ filePath }, 'CLAUDE.md not found, skipping');
      return undefined;
    }

    if (nodeError.code === 'EACCES') {
      logger.warn({ filePath, err: nodeError }, 'Permission denied reading CLAUDE.md');
      return undefined;
    }

    // Log other errors as warnings but don't throw
    logger.warn(
      { filePath, err: nodeError },
      'Failed to read CLAUDE.md'
    );
    return undefined;
  }
}
