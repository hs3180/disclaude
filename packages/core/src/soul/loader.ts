/**
 * SoulLoader - Pure utility class for loading SOUL.md personality files.
 *
 * Reads a single SOUL.md file from an explicit path and returns its content.
 * No caching, no discovery, no merging — just file reading with safety guards.
 *
 * Design Principles (Issue #1315 Simplified v2):
 * - Single responsibility: Only reads a file
 * - Explicit passing: Content returned to caller, no static state
 * - Zero magic: No implicit behavior, path given at construction
 *
 * @module soul/loader
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Maximum allowed SOUL.md file size in bytes (32KB) */
const MAX_SOUL_SIZE_BYTES = 32 * 1024;

/**
 * Result of a successful SOUL.md load.
 */
export interface SoulLoadResult {
  /** File content (trimmed) */
  content: string;
  /** Resolved absolute file path */
  resolvedPath: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * Resolve tilde (~) prefix in a file path to the user's home directory.
 *
 * If the path does not start with ~, returns it unchanged.
 *
 * @param rawPath - The path that may contain a tilde prefix
 * @returns The resolved absolute path
 */
export function resolveTilde(rawPath: string): string {
  if (rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

/**
 * Load SOUL.md content from a file path.
 *
 * Features:
 * - Tilde (~) expansion to home directory
 * - File size limit (32KB) with warning and skip on exceed
 * - Graceful handling: returns null when file doesn't exist
 * - Returns trimmed content
 *
 * @param soulPath - Path to the SOUL.md file (may contain ~ prefix)
 * @returns SoulLoadResult if loaded successfully, null if file doesn't exist
 * @throws Error for unexpected I/O errors (e.g., permission denied)
 */
export function loadSoulFile(soulPath: string): SoulLoadResult | null {
  const resolvedPath = resolveTilde(soulPath);

  // Check file existence — return null silently for ENOENT
  if (!fs.existsSync(resolvedPath)) {
    logger.debug({ path: resolvedPath }, 'SOUL.md file not found, skipping');
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    // Only silence ENOENT (race condition with existsSync)
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ path: resolvedPath }, 'SOUL.md disappeared before stat, skipping');
      return null;
    }
    throw err;
  }

  // Directory check
  if (!stat.isFile()) {
    logger.warn({ path: resolvedPath }, 'SOUL.md path is a directory, not a file');
    return null;
  }

  // Size limit check (use byte size from stat, not content.length)
  if (stat.size > MAX_SOUL_SIZE_BYTES) {
    logger.warn(
      { path: resolvedPath, sizeBytes: stat.size, maxSize: MAX_SOUL_SIZE_BYTES },
      'SOUL.md exceeds size limit, skipping',
    );
    return null;
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8').trim();

  if (!content) {
    logger.warn({ path: resolvedPath }, 'SOUL.md is empty, skipping');
    return null;
  }

  logger.info(
    { path: resolvedPath, sizeBytes: stat.size, contentLength: content.length },
    'SOUL.md loaded successfully',
  );

  return {
    content,
    resolvedPath,
    sizeBytes: stat.size,
  };
}
