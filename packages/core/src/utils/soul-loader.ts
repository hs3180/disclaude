/**
 * SoulLoader - Simple SOUL.md file loader for personality injection.
 *
 * Loads a SOUL.md file and returns its content as a string
 * for injection into agent system prompts.
 *
 * Design principles (Issue #1315, simplified from PR #1632):
 * - No caching — caller decides when to load and cache
 * - No multi-path search — caller provides exact path
 * - Tilde (~) expansion for user home directory paths
 * - File size limit to prevent token waste
 * - Uses fs.stat().size (bytes) for size checking, not content.length (chars)
 *
 * @module @disclaude/core/utils/soul-loader
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from './logger.js';

const logger = createLogger('SoulLoader');

/** Default maximum SOUL.md file size: 32KB */
const DEFAULT_MAX_SIZE = 32 * 1024;

/**
 * Load SOUL.md content from a file path.
 *
 * @param filePath - Path to the SOUL.md file (supports ~ expansion)
 * @param maxSize - Maximum allowed file size in bytes (default: 32768)
 * @returns File content as string, or null if file doesn't exist or exceeds size limit
 *
 * @example
 * ```typescript
 * // At startup, load global soul once
 * const soulConfig = Config.getSoulConfig();
 * const globalSoul = soulConfig.path
 *   ? loadSoulContent(soulConfig.path, soulConfig.maxSize)
 *   : null;
 *
 * // Per-task soul override
 * const taskSoul = task.soul
 *   ? loadSoulContent(task.soul)
 *   : globalSoul;
 * ```
 */
export function loadSoulContent(filePath: string, maxSize?: number): string | null {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  // Expand tilde (~) to home directory
  const expandedPath = filePath.startsWith('~')
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;

  const effectiveMaxSize = maxSize ?? DEFAULT_MAX_SIZE;

  try {
    // Check file size using stat (bytes) — not content.length (chars/Unicode)
    // This fixes the Unicode bug from PR #1632 where content.length was used
    const stat = fs.statSync(expandedPath, { throwIfNoEntry: false });

    if (!stat) {
      logger.debug({ path: expandedPath }, 'SOUL.md file not found, skipping');
      return null;
    }

    if (stat.size > effectiveMaxSize) {
      logger.warn(
        { path: expandedPath, size: stat.size, maxSize: effectiveMaxSize },
        `SOUL.md file exceeds size limit (${Math.round(stat.size / 1024)}KB > ${Math.round(effectiveMaxSize / 1024)}KB), skipping`,
      );
      return null;
    }

    const content = fs.readFileSync(expandedPath, 'utf-8');
    const trimmed = content.trim();

    if (!trimmed) {
      logger.debug({ path: expandedPath }, 'SOUL.md file is empty, skipping');
      return null;
    }

    logger.info(
      { path: expandedPath, size: stat.size, contentLength: trimmed.length },
      'SOUL.md loaded successfully',
    );

    return trimmed;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      logger.debug({ path: expandedPath }, 'SOUL.md file not found, skipping');
      return null;
    }
    logger.error({ err, path: expandedPath }, 'Failed to load SOUL.md');
    return null;
  }
}
