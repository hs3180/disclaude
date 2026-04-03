/**
 * Knowledge Loader - Loads project instructions and knowledge base files.
 *
 * Issue #1916: Implements Claude Projects-like knowledge management.
 * Reads CLAUDE.md for project instructions and scans configured directories
 * for knowledge base files, returning formatted content for injection into
 * agent context via the MessageBuilder guidance system.
 *
 * Design principles:
 * - File I/O is isolated in this module (not in MessageBuilder)
 * - Output is a plain string passed to buildProjectKnowledgeGuidance()
 * - Supports size limits to prevent exceeding context window
 * - Uses fs operations that can be replaced for testing
 *
 * @module knowledge/knowledge-loader
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { KnowledgeConfig } from '../config/types.js';

const logger = createLogger('KnowledgeLoader');

/**
 * Default file extensions to include when scanning knowledge directories.
 * Covers common text-based formats.
 */
const DEFAULT_INCLUDE_EXTENSIONS = new Set([
  '.md', '.markdown',
  '.txt', '.text',
  '.json',
  '.yaml', '.yml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.rs', '.go', '.java', '.kt', '.scala',
  '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh',
  '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv',
  '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.sql', '.graphql',
  '.env', '.example',
  '.dockerfile',
  '.gitignore', '.prettierrc', '.eslintrc',
]);

/**
 * Default maximum characters for knowledge content.
 * Conservative limit to leave room for conversation context
 * within Claude's 200K token context window.
 */
const DEFAULT_MAX_CHARS = 50000;

/**
 * Maximum individual file size in characters.
 * Prevents a single large file from consuming the entire budget.
 */
const MAX_FILE_CHARS = 30000;

/**
 * Result of loading knowledge content.
 */
export interface KnowledgeContent {
  /** Project instructions content (from CLAUDE.md or configured path) */
  instructions: string;
  /** Knowledge base files with their relative paths and content */
  files: Array<{ path: string; content: string }>;
  /** Whether content was truncated due to size limits */
  truncated: boolean;
  /** Total characters across all loaded content */
  totalChars: number;
}

/**
 * File system operations used by loadKnowledge.
 * Replace for testing to avoid real file I/O.
 * @internal
 */
export const fsOps = {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
};

/**
 * Load project knowledge content from configuration.
 *
 * This function:
 * 1. Reads project instructions from CLAUDE.md (or configured path)
 * 2. Scans configured directories for knowledge files
 * 3. Applies size limits to prevent exceeding context window
 *
 * The returned content can be passed to `buildProjectKnowledgeGuidance()`
 * for formatting in the agent prompt.
 *
 * @param config - Knowledge configuration
 * @param workspaceDir - Workspace directory for resolving relative paths
 * @returns Loaded knowledge content
 *
 * @example
 * ```typescript
 * const knowledge = await loadKnowledge(config.knowledge, workspaceDir);
 * const guidance = buildProjectKnowledgeGuidance(knowledge);
 * // Include guidance in the agent prompt
 * ```
 */
export function loadKnowledge(
  config: KnowledgeConfig | undefined,
  workspaceDir?: string
): KnowledgeContent {
  const result: KnowledgeContent = {
    instructions: '',
    files: [],
    truncated: false,
    totalChars: 0,
  };

  if (!config) {
    return result;
  }

  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  const extensions = config.includeExtensions
    ? new Set(config.includeExtensions.map(ext => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`))
    : DEFAULT_INCLUDE_EXTENSIONS;

  // Load project instructions (CLAUDE.md)
  const instructionsPath = resolveInstructionsPath(config.instructionsPath, workspaceDir);
  if (instructionsPath) {
    const { content, truncated } = loadFileContent(instructionsPath, 'instructions', maxChars);
    result.instructions = content;
    result.totalChars += content.length;
    result.truncated = result.truncated || truncated;
  }

  // Load knowledge base files from directories
  if (config.paths && config.paths.length > 0) {
    for (const dirPath of config.paths) {
      const resolvedDir = workspaceDir
        ? path.resolve(workspaceDir, dirPath)
        : path.resolve(dirPath);

      const files = loadDirectoryFiles(resolvedDir, extensions, maxChars - result.totalChars);
      result.files.push(...files.items);
      result.totalChars += files.chars;
      result.truncated = result.truncated || files.truncated;
    }
  }

  // Check if we hit the limit
  if (result.totalChars > maxChars) {
    result.truncated = true;
  }

  logger.info(
    {
      instructionsChars: result.instructions.length,
      fileCount: result.files.length,
      totalChars: result.totalChars,
      truncated: result.truncated,
    },
    'Knowledge content loaded'
  );

  return result;
}

/**
 * Resolve the instructions file path.
 *
 * Priority:
 * 1. Explicit path from config
 * 2. CLAUDE.md in workspace directory
 *
 * @param configPath - Explicit path from config
 * @param workspaceDir - Workspace directory
 * @returns Resolved path, or undefined if not found
 */
function resolveInstructionsPath(
  configPath: string | undefined,
  workspaceDir?: string
): string | undefined {
  // Explicitly disabled
  if (configPath === '' || configPath === 'false' || configPath === 'disabled') {
    return undefined;
  }

  // Explicit path from config
  if (configPath) {
    const resolved = workspaceDir
      ? path.resolve(workspaceDir, configPath)
      : path.resolve(configPath);
    if (fsOps.existsSync(resolved)) {
      return resolved;
    }
    logger.warn({ path: resolved }, 'Instructions file not found at configured path');
    return undefined;
  }

  // Auto-detect CLAUDE.md in workspace
  if (workspaceDir) {
    const autoPath = path.resolve(workspaceDir, 'CLAUDE.md');
    if (fsOps.existsSync(autoPath)) {
      return autoPath;
    }
  }

  return undefined;
}

/**
 * Load content from a single file.
 *
 * @param filePath - Path to the file
 * @param label - Label for logging
 * @param remainingChars - Remaining character budget
 * @returns Object with file content and truncation flag
 */
function loadFileContent(filePath: string, label: string, remainingChars: number): { content: string; truncated: boolean } {
  try {
    let content = fsOps.readFileSync(filePath, 'utf-8');
    let truncated = false;

    if (content.length > remainingChars) {
      content = content.substring(0, remainingChars);
      truncated = true;
      logger.warn(
        { path: filePath, chars: content.length, budget: remainingChars },
        `${label} file truncated to fit knowledge budget`
      );
    }

    logger.debug({ path: filePath, chars: content.length }, `Loaded ${label} file`);
    return { content, truncated };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ path: filePath, error: errorMessage }, `Failed to read ${label} file`);
    return { content: '', truncated: false };
  }
}

/**
 * Result of loading files from a directory.
 */
interface DirectoryLoadResult {
  items: Array<{ path: string; content: string }>;
  chars: number;
  truncated: boolean;
}

/**
 * Load all eligible files from a directory.
 *
 * Files are sorted by path for deterministic ordering.
 * Binary files and files with disallowed extensions are skipped.
 *
 * @param dirPath - Directory path to scan
 * @param extensions - Allowed file extensions
 * @param remainingChars - Remaining character budget
 * @returns Loaded files with their content
 */
function loadDirectoryFiles(
  dirPath: string,
  extensions: Set<string>,
  remainingChars: number
): DirectoryLoadResult {
  const result: DirectoryLoadResult = { items: [], chars: 0, truncated: false };

  if (!fsOps.existsSync(dirPath)) {
    logger.warn({ path: dirPath }, 'Knowledge directory not found');
    return result;
  }

  let dirEntries: string[];
  try {
    dirEntries = fsOps.readdirSync(dirPath);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ path: dirPath, error: errorMessage }, 'Failed to read knowledge directory');
    return result;
  }

  // Sort for deterministic ordering
  const sortedEntries = dirEntries.sort();

  for (const entry of sortedEntries) {
    if (result.chars >= remainingChars) {
      result.truncated = true;
      break;
    }

    const fullPath = path.join(dirPath, entry);

    try {
      const stat = fsOps.statSync(fullPath);

      if (stat.isDirectory()) {
        // Recursively load subdirectories
        const subResult = loadDirectoryFiles(fullPath, extensions, remainingChars - result.chars);
        result.items.push(...subResult.items);
        result.chars += subResult.chars;
        result.truncated = result.truncated || subResult.truncated;
      } else if (stat.isFile()) {
        // Check file extension
        const ext = path.extname(entry).toLowerCase();
        if (extensions.size > 0 && !extensions.has(ext)) {
          continue;
        }

        // Check remaining budget
        const budget = remainingChars - result.chars;
        if (budget <= 0) {
          result.truncated = true;
          break;
        }

        // Load file content
        let content: string;
        try {
          content = fsOps.readFileSync(fullPath, 'utf-8');
        } catch {
          // Skip unreadable files
          continue;
        }

        // Truncate if needed
        if (content.length > MAX_FILE_CHARS) {
          content = content.substring(0, MAX_FILE_CHARS);
          logger.debug(
            { path: fullPath, originalChars: content.length, maxChars: MAX_FILE_CHARS },
            'Knowledge file truncated to MAX_FILE_CHARS'
          );
        }

        if (content.length > budget) {
          content = content.substring(0, budget);
          result.truncated = true;
        }

        result.items.push({ path: fullPath, content });
        result.chars += content.length;
      }
    } catch {
      // Skip entries that can't be stat'd
    }
  }

  return result;
}
