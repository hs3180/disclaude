/**
 * SoulLoader - Pure utility for loading SOUL.md personality files.
 *
 * This module provides a simple, stateless file loader for SOUL.md files
 * that define AI agent personality and behavior rules.
 *
 * Design Principles (Issue #1315 Simplified v2):
 * - Single responsibility: Only reads files, no caching/discovery logic
 * - Explicit passing: Content passed via function parameters, no static state
 * - Startup loading: Load once at startup, pass through constructor chain
 * - Zero magic: No implicit behavior, all paths explicitly configured
 *
 * @module @disclaude/core/soul
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Maximum allowed SOUL.md file size in bytes (32KB) */
export const SOUL_MAX_SIZE_BYTES = 32 * 1024;

/** Result of loading a SOUL.md file */
export interface SoulLoadResult {
  /** The loaded SOUL.md content */
  content: string;
  /** Absolute path of the loaded file */
  resolvedPath: string;
  /** File size in bytes */
  size: number;
}

/**
 * Resolve a SOUL.md path with tilde (~) expansion.
 *
 * Supports tilde expansion for home directory references:
 * - `~/.disclaude/SOUL.md` → `/home/user/.disclaude/SOUL.md`
 * - `/absolute/path/SOUL.md` → `/absolute/path/SOUL.md` (no change)
 * - `relative/path/SOUL.md` → resolved against cwd (no change)
 *
 * @param rawPath - Path to resolve, may contain leading ~
 * @returns Resolved absolute path
 */
export function resolveSoulPath(rawPath: string): string {
  if (rawPath.startsWith('~/')) {
    return path.join(homedir(), rawPath.slice(1));
  }
  return rawPath;
}

/**
 * Load a SOUL.md file from the given path.
 *
 * Features:
 * - Tilde (~) expansion for home directory paths
 * - 32KB file size limit (prevents token waste)
 * - Graceful degradation: returns null if file doesn't exist
 * - Content trimming: strips leading/trailing whitespace
 *
 * @param soulPath - Path to the SOUL.md file (may use ~ for home dir)
 * @returns SoulLoadResult if file was loaded successfully, null otherwise
 *
 * @example
 * ```typescript
 * const result = await loadSoulFile('~/.disclaude/SOUL.md');
 * if (result) {
 *   console.log(`Loaded SOUL.md (${result.size} bytes) from ${result.resolvedPath}`);
 *   agent.systemPromptAppend = result.content;
 * }
 * ```
 */
export async function loadSoulFile(soulPath: string): Promise<SoulLoadResult | null> {
  const resolvedPath = resolveSoulPath(soulPath);

  // Check if file exists
  if (!existsSync(resolvedPath)) {
    logger.debug({ path: resolvedPath }, 'SOUL.md file not found, skipping');
    return null;
  }

  try {
    const content = await readFile(resolvedPath, 'utf-8');

    // Check file size
    const sizeBytes = Buffer.byteLength(content, 'utf-8');
    if (sizeBytes > SOUL_MAX_SIZE_BYTES) {
      logger.warn(
        { path: resolvedPath, sizeBytes, maxBytes: SOUL_MAX_SIZE_BYTES },
        'SOUL.md file exceeds maximum size, skipping'
      );
      return null;
    }

    // Trim whitespace
    const trimmedContent = content.trim();

    if (!trimmedContent) {
      logger.debug({ path: resolvedPath }, 'SOUL.md file is empty, skipping');
      return null;
    }

    logger.info(
      { path: resolvedPath, sizeBytes },
      'Loaded SOUL.md personality file'
    );

    return {
      content: trimmedContent,
      resolvedPath,
      size: sizeBytes,
    };
  } catch (error) {
    logger.error(
      { err: error, path: resolvedPath },
      'Failed to read SOUL.md file'
    );
    return null;
  }
}
