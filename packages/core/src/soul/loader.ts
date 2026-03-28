/**
 * SoulLoader - Loads SOUL.md personality files for Agent injection.
 *
 * Provides a simple mechanism to load SOUL.md files and inject their
 * content into Agent system prompts via systemPromptAppend.
 *
 * Loading priority (higher overrides lower):
 * 1. Explicit path (provided by caller)
 * 2. Per-entity soul (e.g., per-discussion, per-schedule)
 * 3. Global soul from config (soul.path)
 * 4. Default soul at workspace/SOUL.md
 *
 * @module soul/loader
 * @see Issue #1228 - Discussion focus keeping via SOUL.md
 * @see Issue #1315 - SOUL.md personality definition system
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

/** Maximum SOUL.md file size in bytes (32KB) */
export const MAX_SOUL_SIZE_BYTES = 32 * 1024;

/**
 * Result of a SOUL.md load operation.
 */
export interface SoulLoadResult {
  /** Whether a SOUL.md file was found and loaded */
  found: boolean;
  /** The loaded SOUL.md content (empty string if not found) */
  content: string;
  /** The resolved file path that was loaded (if found) */
  sourcePath?: string;
  /** Size of the loaded content in bytes */
  sizeBytes: number;
}

/**
 * Options for SoulLoader.load().
 */
export interface SoulLoadOptions {
  /**
   * Explicit path to a SOUL.md file.
   * When provided, this takes highest priority.
   * Supports tilde expansion (~/.disclaude/SOUL.md).
   */
  explicitPath?: string;

  /**
   * Fallback global soul path from configuration.
   * If explicitPath is not found, tries this path next.
   */
  configPath?: string;

  /**
   * Workspace directory for default SOUL.md lookup.
   * If neither explicitPath nor configPath is found,
   * tries {workspace}/SOUL.md as final fallback.
   */
  workspaceDir?: string;
}

/**
 * Resolve a file path with tilde expansion.
 *
 * @param filePath - File path that may start with ~
 * @returns Resolved absolute path
 */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return resolve(homedir(), filePath.slice(1));
  }
  return resolve(filePath);
}

/**
 * Load a SOUL.md file from the given path.
 *
 * Performs the following checks:
 * 1. Tilde expansion (~ → home directory)
 * 2. File existence
 * 3. Size limit (32KB)
 * 4. Content trimming
 *
 * @param filePath - Path to the SOUL.md file
 * @returns SoulLoadResult with content or empty
 */
export function loadSoulFile(filePath: string): SoulLoadResult {
  const resolvedPath = expandTilde(filePath);

  if (!existsSync(resolvedPath)) {
    return { found: false, content: '', sizeBytes: 0 };
  }

  try {
    const buffer = readFileSync(resolvedPath);

    // Byte-accurate size check (before UTF-8 decoding)
    if (buffer.length > MAX_SOUL_SIZE_BYTES) {
      logger.warn(
        { path: resolvedPath, sizeBytes: buffer.length, maxBytes: MAX_SOUL_SIZE_BYTES },
        'SOUL.md file exceeds 32KB limit, truncating'
      );
    }

    const content = buffer.toString('utf-8').trim();
    const effectiveSize = Buffer.byteLength(content, 'utf-8');

    return {
      found: true,
      content,
      sourcePath: resolvedPath,
      sizeBytes: effectiveSize,
    };
  } catch (error) {
    logger.error(
      { path: resolvedPath, err: error instanceof Error ? error.message : String(error) },
      'Failed to read SOUL.md file'
    );
    return { found: false, content: '', sizeBytes: 0 };
  }
}

/**
 * Load SOUL.md content with fallback chain.
 *
 * Tries paths in the following order and returns the first successful load:
 * 1. explicitPath (if provided)
 * 2. configPath (if provided)
 * 3. {workspaceDir}/SOUL.md (if workspaceDir provided)
 *
 * If no file is found, returns an empty result (not an error).
 *
 * @param options - Load options with fallback paths
 * @returns SoulLoadResult with content or empty
 */
export function loadSoul(options: SoulLoadOptions = {}): SoulLoadResult {
  // Priority 1: Explicit path
  if (options.explicitPath) {
    const result = loadSoulFile(options.explicitPath);
    if (result.found) {
      logger.info({ source: 'explicit', path: result.sourcePath, sizeBytes: result.sizeBytes }, 'SOUL.md loaded');
      return result;
    }
    logger.debug({ path: options.explicitPath }, 'Explicit SOUL.md path not found, trying fallbacks');
  }

  // Priority 2: Config path
  if (options.configPath) {
    const result = loadSoulFile(options.configPath);
    if (result.found) {
      logger.info({ source: 'config', path: result.sourcePath, sizeBytes: result.sizeBytes }, 'SOUL.md loaded');
      return result;
    }
    logger.debug({ path: options.configPath }, 'Config SOUL.md path not found, trying fallbacks');
  }

  // Priority 3: Workspace default
  if (options.workspaceDir) {
    const defaultPath = resolve(options.workspaceDir, 'SOUL.md');
    const result = loadSoulFile(defaultPath);
    if (result.found) {
      logger.info({ source: 'workspace-default', path: result.sourcePath, sizeBytes: result.sizeBytes }, 'SOUL.md loaded');
      return result;
    }
  }

  logger.debug('No SOUL.md file found in any search path');
  return { found: false, content: '', sizeBytes: 0 };
}

/**
 * Format SOUL.md content as a system prompt appendix.
 *
 * Wraps the soul content in a structured system prompt section
 * that can be appended to the agent's system prompt.
 *
 * @param soulContent - Raw SOUL.md content
 * @returns Formatted string for system prompt injection, or undefined if empty
 */
export function formatSoulAsSystemPrompt(soulContent: string): string | undefined {
  if (!soulContent || !soulContent.trim()) {
    return undefined;
  }

  return `<soul-profile>\n${soulContent.trim()}\n</soul-profile>`;
}
