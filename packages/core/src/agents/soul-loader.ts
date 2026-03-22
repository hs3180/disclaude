/**
 * SoulLoader - SOUL.md discovery, loading, and merging.
 *
 * Issue #1315: Agent personality/behavior definition system.
 *
 * SOUL.md is a "personality definition" design pattern that defines AI's
 * core behavior guidelines through Markdown files, letting Agent drive
 * behavior through "self-awareness" rather than "rule constraints".
 *
 * ## Key Design Decisions (learned from rejected PR #1408)
 *
 * - SOUL.md is loaded during Agent initialization, NOT through the Skill layer
 * - Content is injected via system_prompt (AgentQueryOptions.systemPrompt)
 * - No SoulLoader skill module — personality should not be coupled with tools
 *
 * ## Discovery Order (highest priority first)
 *
 * | Priority | Location | Use Case |
 * |----------|----------|----------|
 * | 3 (high) | `~/.disclaude/SOUL.md` | User-defined personality |
 * | 2 (mid)  | `{workspace}/.claude/SOUL.md` | Project-specific personality |
 * | 1 (low)  | `{workspace}/config/SOUL.md` | Default system personality |
 *
 * @module agents/soul-loader
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SoulLoader');

// ============================================================================
// Types
// ============================================================================

/**
 * A discovered SOUL.md file.
 */
export interface DiscoveredSoul {
  /** Absolute path to the SOUL.md file */
  path: string;
  /** Priority (higher = more important) */
  priority: number;
  /** Domain where the file was found */
  domain: 'user' | 'project' | 'default';
}

/**
 * Options for SOUL.md loading.
 */
export interface SoulLoaderOptions {
  /** Custom search paths (overrides defaults) */
  searchPaths?: SoulSearchPath[];
  /** Whether to include default search paths (default: true) */
  includeDefaults?: boolean;
}

/**
 * A search path for SOUL.md files.
 */
export interface SoulSearchPath {
  /** Directory path to search for SOUL.md */
  dir: string;
  /** Priority (higher = more important) */
  priority: number;
  /** Domain identifier */
  domain: 'user' | 'project' | 'default';
}

/**
 * Result of loading SOUL.md content.
 */
export interface SoulLoadResult {
  /** Merged SOUL.md content (empty string if none found) */
  content: string;
  /** List of discovered SOUL.md files (sorted by priority, highest first) */
  sources: DiscoveredSoul[];
}

// ============================================================================
// Default Search Paths
// ============================================================================

/**
 * Get default search paths for SOUL.md files.
 *
 * Search order (highest priority first):
 * 1. User domain: `~/.disclaude/SOUL.md` (priority 3)
 * 2. Project domain: `{workspace}/.claude/SOUL.md` (priority 2)
 * 3. Default domain: `{workspace}/config/SOUL.md` (priority 1)
 *
 * @returns Array of search paths sorted by priority (highest first)
 */
export function getDefaultSoulSearchPaths(): SoulSearchPath[] {
  const workspaceDir = Config.getWorkspaceDir();

  const paths: SoulSearchPath[] = [
    // User domain - highest priority (user's personal personality)
    {
      dir: path.join(os.homedir(), '.disclaude'),
      domain: 'user',
      priority: 3,
    },
    // Project domain - medium priority (project-specific personality)
    {
      dir: path.join(workspaceDir, '.claude'),
      domain: 'project',
      priority: 2,
    },
    // Default domain - lowest priority (system default personality)
    {
      dir: path.join(workspaceDir, 'config'),
      domain: 'default',
      priority: 1,
    },
  ];

  return paths.sort((a, b) => b.priority - a.priority);
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Discover SOUL.md files across all search paths.
 *
 * Searches for `SOUL.md` (case-sensitive) in each search path,
 * returning all found files sorted by priority (highest first).
 *
 * @param options - Optional loading options
 * @returns Array of discovered SOUL.md files
 */
export async function discoverSoulFiles(
  options: SoulLoaderOptions = {}
): Promise<DiscoveredSoul[]> {
  const includeDefaults = options.includeDefaults ?? true;
  const searchPaths = options.searchPaths ?? (
    includeDefaults ? getDefaultSoulSearchPaths() : []
  );

  const discovered: DiscoveredSoul[] = [];

  for (const searchPath of searchPaths) {
    const soulFile = path.join(searchPath.dir, 'SOUL.md');

    try {
      await fs.access(soulFile);
      discovered.push({
        path: soulFile,
        priority: searchPath.priority,
        domain: searchPath.domain,
      });
      logger.debug(
        { path: soulFile, domain: searchPath.domain, priority: searchPath.priority },
        'Discovered SOUL.md'
      );
    } catch {
      // File doesn't exist, continue
    }
  }

  // Sort by priority (highest first)
  discovered.sort((a, b) => b.priority - a.priority);

  return discovered;
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Load and merge SOUL.md files.
 *
 * Discovers SOUL.md files across all search paths, reads their content,
 * and merges them in priority order. Higher priority files come first
 * in the merged output.
 *
 * The merge strategy is simple concatenation with separators:
 * ```
 * [User SOUL.md content]
 * ---
 * [Project SOUL.md content]
 * ---
 * [Default SOUL.md content]
 * ```
 *
 * @param options - Optional loading options
 * @returns Merged content and source file list
 */
export async function loadSoul(
  options: SoulLoaderOptions = {}
): Promise<SoulLoadResult> {
  const sources = await discoverSoulFiles(options);

  if (sources.length === 0) {
    logger.debug('No SOUL.md files found');
    return { content: '', sources: [] };
  }

  const contents: string[] = [];

  for (const source of sources) {
    try {
      const content = await fs.readFile(source.path, 'utf-8');
      const trimmed = content.trim();
      if (trimmed) {
        contents.push(trimmed);
        logger.info(
          { path: source.path, domain: source.domain, contentLength: trimmed.length },
          'Loaded SOUL.md'
        );
      }
    } catch (error) {
      logger.warn(
        { path: source.path, error },
        'Failed to read SOUL.md, skipping'
      );
    }
  }

  const merged = contents.join('\n\n---\n\n');

  logger.info(
    { sourceCount: sources.length, totalLength: merged.length },
    'SOUL.md merged'
  );

  return { content: merged, sources };
}

/**
 * Load SOUL.md content for system prompt injection.
 *
 * Convenience function that returns only the merged content string,
 * suitable for passing as `systemPrompt` in agent configuration.
 *
 * @param options - Optional loading options
 * @returns Merged SOUL.md content (empty string if none found)
 */
export async function loadSoulContent(
  options: SoulLoaderOptions = {}
): Promise<string> {
  const result = await loadSoul(options);
  return result.content;
}
