/**
 * SoulLoader - Simple SOUL.md file loader with safety checks.
 *
 * Issue #1315: SOUL.md - Agent personality/behavior definition system.
 *
 * Design principles (learned from 6 rejected PRs):
 * - NO caching — caller manages lifecycle
 * - NO multi-path search — caller provides explicit path
 * - Tilde expansion for user convenience
 * - Byte-based size limit (not character-based) for Unicode safety
 * - Explicit error codes for actionable error handling
 *
 * @module soul/soul-loader
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../utils/logger.js';
import type { SoulConfig, SoulLoadResult } from './types.js';
import { SoulLoadError } from './types.js';

const logger = createLogger('SoulLoader');

/** Default maximum SOUL.md file size: 32KB */
const DEFAULT_MAX_SIZE = 32 * 1024;

/**
 * Load a SOUL.md file with safety checks.
 *
 * This function:
 * 1. Expands tilde (~) in the path
 * 2. Resolves relative paths against the workspace directory
 * 3. Validates file existence
 * 4. Checks file size in bytes (not characters — Unicode-safe)
 * 5. Reads and returns the file content
 *
 * @param config - Soul configuration (path and optional maxSize)
 * @param workspaceDir - Workspace directory for resolving relative paths
 * @returns SoulLoadResult with content, resolved path, and size
 * @throws SoulLoadError if loading fails
 *
 * @example
 * ```typescript
 * try {
 *   const soul = await loadSoul({ path: '~/.disclaude/SOUL.md' }, '/workspace');
 *   console.log(soul.content); // SOUL.md file content
 * } catch (err) {
 *   if (err instanceof SoulLoadError && err.code === 'NOT_FOUND') {
 *     logger.info('No SOUL.md configured, using default personality');
 *   }
 * }
 * ```
 */
export async function loadSoul(
  config: SoulConfig,
  workspaceDir?: string
): Promise<SoulLoadResult> {
  const soulPath = config.path;

  if (!soulPath) {
    throw new SoulLoadError('No SOUL.md path configured', 'INVALID_PATH');
  }

  // Expand tilde (~) to home directory
  const expandedPath = soulPath.startsWith('~')
    ? path.join(os.homedir(), soulPath.slice(1))
    : soulPath;

  // Resolve to absolute path (relative paths resolved against workspace)
  const resolvedPath = path.isAbsolute(expandedPath)
    ? expandedPath
    : workspaceDir
      ? path.resolve(workspaceDir, expandedPath)
      : path.resolve(expandedPath);

  const maxSize = config.maxSize ?? DEFAULT_MAX_SIZE;

  // Check file existence
  try {
    await fs.promises.access(resolvedPath, fs.constants.R_OK);
  } catch {
    throw new SoulLoadError(
      `SOUL.md file not found or not readable: ${resolvedPath}`,
      'NOT_FOUND'
    );
  }

  // Get file stats (byte-based size check for Unicode safety)
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolvedPath);
  } catch (err) {
    throw new SoulLoadError(
      `Failed to stat SOUL.md file: ${resolvedPath}`,
      'READ_ERROR',
      err instanceof Error ? err : new Error(String(err))
    );
  }

  // Size check uses bytes (stat.size), NOT content.length (characters)
  // This avoids Unicode mismatch bugs (e.g., Chinese/emoji characters)
  if (stat.size > maxSize) {
    throw new SoulLoadError(
      `SOUL.md file too large: ${stat.size} bytes (max: ${maxSize} bytes)`,
      'TOO_LARGE'
    );
  }

  // Read file content
  let content: string;
  try {
    content = await fs.promises.readFile(resolvedPath, 'utf-8');
  } catch (err) {
    throw new SoulLoadError(
      `Failed to read SOUL.md file: ${resolvedPath}`,
      'READ_ERROR',
      err instanceof Error ? err : new Error(String(err))
    );
  }

  logger.info(
    { resolvedPath, sizeBytes: stat.size, contentLength: content.length },
    'SOUL.md loaded successfully'
  );

  return {
    content: content.trim(),
    resolvedPath,
    sizeBytes: stat.size,
  };
}

/**
 * Check if soul configuration is present and valid.
 * Returns true if a soul path is configured.
 *
 * @param config - Soul configuration
 * @returns true if soul path is configured
 */
export function hasSoulConfig(config: SoulConfig): boolean {
  return !!config.path;
}
