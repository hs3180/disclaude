/**
 * Project Context module for scoped instructions and knowledge bases.
 *
 * Issue #1916: Implements Claude Projects-like functionality by loading
 * project-scoped instructions (CLAUDE.md) and knowledge base files
 * for injection into agent prompts.
 *
 * Architecture:
 * - ProjectContext: Loads and caches project configuration
 * - Instructions loaded from CLAUDE.md files
 * - Knowledge base files scanned from configured directories
 * - Content formatted for prompt injection with size limits
 *
 * @module agents/project-context
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  ProjectsConfig,
  ProjectConfigEntry,
  ProjectKnowledgeEntry,
} from '../config/types.js';

const logger = createLogger('ProjectContext');

/**
 * Default file extensions supported for knowledge base files.
 * Covers common text-based formats that can be injected into prompts.
 */
const DEFAULT_KNOWLEDGE_EXTENSIONS = [
  '.md', '.txt', '.markdown',
  '.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.toml',
  '.py', '.rb', '.go', '.rs', '.java',
  '.sh', '.bash', '.zsh',
  '.css', '.scss', '.less', '.html',
  '.sql', '.graphql',
  '.env', '.env.example',
  '.csv', '.xml',
];

/**
 * Default maximum total characters for knowledge base content.
 * Kept well under Claude's 200K context window to leave room for
 * conversation history and other context.
 */
const DEFAULT_MAX_KNOWLEDGE_CHARS = 100_000;

/**
 * Result of loading a project's context.
 */
export interface ProjectContextResult {
  /** Project name */
  name: string;
  /** Formatted project context string for prompt injection */
  context: string;
  /** Number of knowledge files loaded */
  knowledgeFileCount: number;
  /** Total characters in knowledge content */
  knowledgeChars: number;
  /** Whether instructions were loaded */
  hasInstructions: boolean;
  /** Path to the CLAUDE.md instructions file (if found) */
  instructionsPath?: string;
}

/**
 * Information about a single knowledge file.
 */
export interface KnowledgeFileInfo {
  /** Relative file path from the knowledge directory root */
  relativePath: string;
  /** Absolute file path */
  absolutePath: string;
  /** File size in bytes */
  size: number;
  /** File extension */
  extension: string;
}

/**
 * Project Context manager.
 *
 * Loads project-scoped instructions (CLAUDE.md) and knowledge base files
 * for injection into agent prompts. Supports multiple named projects with
 * an active project selector.
 *
 * Usage:
 * ```typescript
 * const projectCtx = new ProjectContext(config.projects, '/workspace');
 * const ctx = await projectCtx.loadActiveProject();
 * if (ctx) {
 *   // Inject ctx.context into the agent prompt
 * }
 * ```
 *
 * @see Issue #1916
 */
export class ProjectContext {
  private readonly config: ProjectsConfig | undefined;
  private readonly configDir: string;
  private cache = new Map<string, ProjectContextResult>();

  constructor(config: ProjectsConfig | undefined, configDir: string) {
    this.config = config;
    this.configDir = configDir;
  }

  /**
   * Load the currently active project's context.
   *
   * Falls back to the "default" project if no active project is set.
   * Returns null if no project configuration exists.
   *
   * @returns Project context result, or null if no projects configured
   */
  async loadActiveProject(): Promise<ProjectContextResult | null> {
    if (!this.config) {
      return null;
    }

    const activeName = this.config.active || 'default';
    return this.loadProject(activeName);
  }

  /**
   * Load a specific project's context by name.
   *
   * Results are cached - subsequent calls for the same project name
   * return the cached result unless the cache is explicitly cleared.
   *
   * @param name - Project name to load
   * @returns Project context result, or null if project not found
   */
  async loadProject(name: string): Promise<ProjectContextResult | null> {
    // Check cache
    const cached = this.cache.get(name);
    if (cached) {
      return cached;
    }

    const entry = this.resolveProjectEntry(name);
    if (!entry) {
      logger.debug({ projectName: name }, 'Project not found in config');
      return null;
    }

    const result = await this.buildProjectContext(name, entry);
    this.cache.set(name, result);

    logger.info(
      {
        project: name,
        hasInstructions: result.hasInstructions,
        knowledgeFiles: result.knowledgeFileCount,
        knowledgeChars: result.knowledgeChars,
      },
      'Loaded project context',
    );

    return result;
  }

  /**
   * Get the names of all configured projects.
   *
   * @returns Array of project names
   */
  getProjectNames(): string[] {
    if (!this.config) {
      return [];
    }

    return Object.keys(this.config).filter(
      (key) => key !== 'active' && this.resolveProjectEntry(key) != null,
    );
  }

  /**
   * Get the currently active project name.
   *
   * @returns Active project name, or undefined if no projects configured
   */
  getActiveProjectName(): string | undefined {
    if (!this.config) {
      return undefined;
    }
    return this.config.active || 'default';
  }

  /**
   * Clear the project context cache.
   * Useful when project configuration changes at runtime.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Resolve a project entry from config, handling both object and string formats.
   */
  private resolveProjectEntry(name: string): ProjectConfigEntry | null {
    if (!this.config) {
      return null;
    }

    const entry = this.config[name];

    // String format: just a path to instructions
    if (typeof entry === 'string') {
      return { instructionsPath: entry };
    }

    // Object format: full project config
    if (entry && typeof entry === 'object') {
      return entry;
    }

    return null;
  }

  /**
   * Build the full project context from a project entry.
   */
  private async buildProjectContext(
    name: string,
    entry: ProjectConfigEntry,
  ): Promise<ProjectContextResult> {
    const sections: string[] = [];
    let knowledgeFileCount = 0;
    let knowledgeChars = 0;
    let hasInstructions = false;
    let instructionsPath: string | undefined;

    // 1. Load project instructions (CLAUDE.md)
    if (entry.instructionsPath) {
      const instructionsContent = await this.loadInstructions(entry.instructionsPath);
      if (instructionsContent) {
        sections.push(
          `### Project Instructions\n\n${instructionsContent}`,
        );
        hasInstructions = true;
        instructionsPath = path.resolve(this.configDir, entry.instructionsPath);
      }
    }

    // 2. Load knowledge base files
    if (entry.knowledge && entry.knowledge.length > 0) {
      const knowledgeResult = await this.loadKnowledge(entry.knowledge);
      if (knowledgeResult.content) {
        sections.push(
          `### Project Knowledge Base\n\n${knowledgeResult.content}`,
        );
        knowledgeFileCount = knowledgeResult.fileCount;
        knowledgeChars = knowledgeResult.totalChars;
      }
    }

    // Build final context
    const context = sections.length > 0
      ? `## Project: ${name}\n\n${sections.join('\n\n')}`
      : '';

    return {
      name,
      context,
      knowledgeFileCount,
      knowledgeChars,
      hasInstructions,
      instructionsPath,
    };
  }

  /**
   * Load project instructions from a CLAUDE.md file.
   *
   * @param instructionsPath - Path to the instructions file
   * @returns File content, or empty string if file doesn't exist
   */
  async loadInstructions(instructionsPath: string): Promise<string> {
    try {
      const absolutePath = path.resolve(this.configDir, instructionsPath);
      const content = await fs.readFile(absolutePath, 'utf-8');
      const trimmed = content.trim();

      if (trimmed.length === 0) {
        logger.debug({ path: absolutePath }, 'Instructions file is empty');
        return '';
      }

      logger.debug({ path: absolutePath, chars: trimmed.length }, 'Loaded project instructions');
      return trimmed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ path: instructionsPath }, 'Instructions file not found, skipping');
        return '';
      }
      logger.warn({ path: instructionsPath, error }, 'Failed to load project instructions');
      return '';
    }
  }

  /**
   * Load knowledge base files from configured directories.
   *
   * Files are sorted alphabetically and concatenated until the
   * maxChars limit is reached. Each file is prefixed with its
   * relative path for context.
   */
  private async loadKnowledge(
    knowledgeEntries: ProjectKnowledgeEntry[],
  ): Promise<{ content: string; fileCount: number; totalChars: number }> {
    const allFiles: KnowledgeFileInfo[] = [];
    const maxChars = knowledgeEntries[0]?.maxChars ?? DEFAULT_MAX_KNOWLEDGE_CHARS;

    for (const entry of knowledgeEntries) {
      const extensions = entry.extensions ?? DEFAULT_KNOWLEDGE_EXTENSIONS;
      const files = await this.scanKnowledgeDir(entry.dir, extensions);
      allFiles.push(...files);
    }

    if (allFiles.length === 0) {
      return { content: '', fileCount: 0, totalChars: 0 };
    }

    // Sort by path for deterministic ordering
    allFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const parts: string[] = [];
    let totalChars = 0;
    let fileCount = 0;

    for (const file of allFiles) {
      try {
        const content = await fs.readFile(file.absolutePath, 'utf-8');
        const trimmed = content.trim();

        if (trimmed.length === 0) continue;

        // Check if adding this file would exceed the limit
        const fileHeader = `\n#### 📄 ${file.relativePath}\n\n`;
        const entrySize = fileHeader.length + trimmed.length;

        if (totalChars + entrySize > maxChars && fileCount > 0) {
          logger.debug(
            { file: file.relativePath, totalChars, maxChars },
            'Knowledge base char limit reached, skipping remaining files',
          );
          break;
        }

        parts.push(`${fileHeader}${trimmed}`);
        totalChars += entrySize;
        fileCount++;
      } catch (error) {
        logger.warn({ file: file.absolutePath, error }, 'Failed to read knowledge file');
      }
    }

    return {
      content: parts.join('\n\n'),
      fileCount,
      totalChars,
    };
  }

  /**
   * Scan a directory for knowledge base files matching the given extensions.
   *
   * Recursively walks the directory, collecting files with matching extensions.
   *
   * @param dirPath - Directory path to scan
   * @param extensions - Allowed file extensions (with dot prefix)
   * @returns Array of knowledge file info objects
   */
  private async scanKnowledgeDir(
    dirPath: string,
    extensions: string[],
  ): Promise<KnowledgeFileInfo[]> {
    const absoluteDir = path.resolve(this.configDir, dirPath);
    const files: KnowledgeFileInfo[] = [];
    const extSet = new Set(extensions.map((e) => e.toLowerCase()));

    try {
      await this.walkDir(absoluteDir, async (filePath, stat) => {
        if (!stat.isFile()) return;

        const ext = path.extname(filePath).toLowerCase();
        if (!extSet.has(ext)) return;

        const relativePath = path.relative(absoluteDir, filePath);
        files.push({
          relativePath,
          absolutePath: filePath,
          size: stat.size,
          extension: ext,
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug({ dir: dirPath }, 'Knowledge directory not found');
        return [];
      }
      logger.warn({ dir: dirPath, error }, 'Failed to scan knowledge directory');
    }

    return files;
  }

  /**
   * Recursively walk a directory, calling the callback for each entry.
   */
  private async walkDir(
    dir: string,
    callback: (filePath: string, stat: { isFile: () => boolean; size: number }) => Promise<void>,
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files and common ignore directories
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.walkDir(fullPath, callback);
      } else if (entry.isFile()) {
        await callback(fullPath, entry);
      }
    }
  }
}
