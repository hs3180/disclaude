/**
 * Knowledge Loader - Loads project instructions and knowledge files.
 *
 * Issue #1916: Implements Claude Projects-like knowledge base functionality.
 * Reads CLAUDE.md as project instructions and scans knowledge directories
 * for files to inject into agent prompts.
 *
 * Design:
 * - File-based: No external dependencies (no vector DB, no RAG pipeline)
 * - Simple: Reads text files and concatenates content
 * - Configurable: File extensions, exclude patterns, size limits
 * - Compatible with Claude Code's CLAUDE.md ecosystem
 *
 * @module knowledge/knowledge-loader
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';
import type { KnowledgeConfig } from '../config/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('KnowledgeLoader');

/** Default max characters for injected knowledge */
const DEFAULT_MAX_KNOWLEDGE_CHARS = 30000;

/** Default file extensions to include */
const DEFAULT_INCLUDE_EXTENSIONS = ['.md', '.txt', '.markdown'];

/** Default glob patterns to exclude */
const DEFAULT_EXCLUDE_PATTERNS = ['node_modules/**', '.git/**', 'dist/**', 'build/**'];

/**
 * A single knowledge file entry.
 */
export interface KnowledgeFileEntry {
  /** Relative file path (from the knowledge directory root) */
  relativePath: string;
  /** Absolute file path */
  absolutePath: string;
  /** File content */
  content: string;
  /** File size in bytes */
  size: number;
}

/**
 * Loaded knowledge result containing instructions and knowledge files.
 */
export interface LoadedKnowledge {
  /** Project instructions content (from CLAUDE.md or similar), or undefined if not configured */
  instructions?: string;
  /** Instructions file path */
  instructionsPath?: string;
  /** Loaded knowledge file entries */
  files: KnowledgeFileEntry[];
  /** Total characters of loaded content (instructions + files) */
  totalChars: number;
  /** Whether the content was truncated due to size limit */
  truncated: boolean;
}

/**
 * Simple pattern matcher for exclude patterns.
 *
 * Supports two formats:
 * - `dirname/**` - matches any path starting with `dirname/`
 * - `dirname` - matches any path starting with `dirname/` or equal to `dirname`
 *
 * This avoids adding minimatch as a dependency for simple use cases.
 */
function matchesExcludePattern(relPath: string, pattern: string): boolean {
  // Normalize: remove trailing /**
  const base = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  return relPath === base || relPath.startsWith(base + '/') || relPath.startsWith(base + '\\');
}

/**
 * Load project instructions and knowledge files based on configuration.
 *
 * @param config - Knowledge configuration
 * @param workspaceDir - Optional workspace directory for resolving relative paths.
 *                       Defaults to process.cwd().
 * @returns Loaded knowledge with instructions and file entries
 */
export function loadKnowledge(config: KnowledgeConfig, workspaceDir?: string): LoadedKnowledge {
  const baseDir = workspaceDir || process.cwd();
  const maxChars = config.maxKnowledgeChars ?? DEFAULT_MAX_KNOWLEDGE_CHARS;
  const includeExtensions = config.includeExtensions ?? DEFAULT_INCLUDE_EXTENSIONS;
  const excludePatterns = config.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;

  let instructions: string | undefined;
  let instructionsPath: string | undefined;

  // 1. Load project instructions (CLAUDE.md)
  if (config.instructionsPath) {
    const resolvedPath = resolve(baseDir, config.instructionsPath);
    if (existsSync(resolvedPath)) {
      try {
        instructions = readFileSync(resolvedPath, 'utf-8');
        instructionsPath = resolvedPath;
        logger.info(
          { path: resolvedPath, chars: instructions.length },
          'Loaded project instructions'
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn({ path: resolvedPath, error: msg }, 'Failed to read project instructions');
      }
    } else {
      logger.warn({ path: resolvedPath }, 'Project instructions file not found');
    }
  }

  // 2. Load knowledge files from directories
  const files: KnowledgeFileEntry[] = [];
  const knowledgeDirs = config.knowledgeDirs ?? [];

  for (const dir of knowledgeDirs) {
    const resolvedDir = resolve(baseDir, dir);
    const entries = loadKnowledgeDirectory(resolvedDir, includeExtensions, excludePatterns);
    files.push(...entries);
    logger.info(
      { dir: resolvedDir, filesFound: entries.length },
      'Scanned knowledge directory'
    );
  }

  // 3. Calculate total and apply truncation
  const instructionsChars = instructions?.length ?? 0;
  let totalChars = instructionsChars + files.reduce((sum, f) => sum + f.content.length, 0);
  let truncated = false;

  if (totalChars > maxChars) {
    // Truncate files from the end until we fit within the limit
    truncated = true;

    while (files.length > 0 && (instructionsChars + files.reduce((s, f) => s + f.content.length, 0)) > maxChars) {
      const removed = files.pop()!;
      logger.debug(
        { file: removed.relativePath, chars: removed.content.length },
        'Excluded knowledge file due to size limit'
      );
    }

    totalChars = instructionsChars + files.reduce((s, f) => s + f.content.length, 0);
  }

  logger.info(
    {
      instructionsChars,
      filesCount: files.length,
      filesChars: totalChars - instructionsChars,
      totalChars,
      truncated,
      maxChars,
    },
    'Knowledge loading complete'
  );

  return {
    instructions,
    instructionsPath,
    files,
    totalChars,
    truncated,
  };
}

/**
 * Recursively load knowledge files from a directory.
 *
 * @param dir - Absolute directory path
 * @param includeExtensions - File extensions to include
 * @param excludePatterns - Glob patterns to exclude
 * @returns Array of knowledge file entries
 */
function loadKnowledgeDirectory(
  dir: string,
  includeExtensions: string[],
  excludePatterns: string[]
): KnowledgeFileEntry[] {
  const entries: KnowledgeFileEntry[] = [];

  if (!existsSync(dir)) {
    logger.warn({ dir }, 'Knowledge directory does not exist');
    return entries;
  }

  const dirStat = statSync(dir);
  if (!dirStat.isDirectory()) {
    logger.warn({ dir }, 'Knowledge path is not a directory');
    return entries;
  }

  scanDirectoryRecursive(dir, dir, includeExtensions, excludePatterns, entries);

  // Sort by path for deterministic ordering
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return entries;
}

/**
 * Recursively scan a directory for knowledge files.
 */
function scanDirectoryRecursive(
  currentDir: string,
  rootDir: string,
  includeExtensions: string[],
  excludePatterns: string[],
  entries: KnowledgeFileEntry[]
): void {
  let items: string[];
  try {
    items = readdirSync(currentDir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ dir: currentDir, error: msg }, 'Failed to read directory');
    return;
  }

  for (const item of items) {
    const fullPath = join(currentDir, item);
    const relPath = relative(rootDir, fullPath);

    // Check exclude patterns (simple prefix/dir matching, no glob dependency)
    const shouldExclude = excludePatterns.some((pattern) => matchesExcludePattern(relPath, pattern));
    if (shouldExclude) {
      continue;
    }

    let itemStat: ReturnType<typeof statSync>;
    try {
      itemStat = statSync(fullPath);
    } catch {
      continue;
    }

    if (itemStat.isDirectory()) {
      scanDirectoryRecursive(fullPath, rootDir, includeExtensions, excludePatterns, entries);
    } else if (itemStat.isFile()) {
      const ext = item.startsWith('.') ? item.toLowerCase() : `.${item.split('.').pop()?.toLowerCase()}`;
      const hasMatchingExt = includeExtensions.some(
        (e) => ext === e || ext === e.toLowerCase()
      );

      if (hasMatchingExt) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          entries.push({
            relativePath: relPath,
            absolutePath: fullPath,
            content,
            size: itemStat.size,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.warn({ file: fullPath, error: msg }, 'Failed to read knowledge file');
        }
      }
    }
  }
}

/**
 * Format loaded knowledge into a prompt section string.
 *
 * Combines project instructions and knowledge files into a single
 * formatted section suitable for injection into an agent prompt.
 *
 * @param knowledge - Loaded knowledge result
 * @returns Formatted knowledge section string, or empty string if no knowledge loaded
 */
export function formatKnowledgeForPrompt(knowledge: LoadedKnowledge): string {
  if (!knowledge.instructions && knowledge.files.length === 0) {
    return '';
  }

  const sections: string[] = [];

  // Project instructions section
  if (knowledge.instructions) {
    sections.push(
      `### Project Instructions\n\n${knowledge.instructions}`
    );
  }

  // Knowledge files section
  if (knowledge.files.length > 0) {
    const fileList = knowledge.files
      .map((f) => {
        const header = `#### ${f.relativePath}`;
        return `${header}\n\n${f.content}`;
      })
      .join('\n\n---\n\n');

    sections.push(`### Knowledge Base\n\n${fileList}`);
  }

  let result = sections.join('\n\n---\n\n');

  if (knowledge.truncated) {
    result += '\n\n> ⚠️ **Note**: Knowledge content was truncated due to size limits. Some files were excluded.';
  }

  return result;
}
