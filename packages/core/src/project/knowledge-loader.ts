/**
 * Knowledge Base Loader.
 *
 * Reads project instructions (CLAUDE.md) and knowledge files from
 * configured directories, formatting them for injection into prompts.
 *
 * Issue #1916: Part of the Project Knowledge Base feature.
 *
 * Design:
 * - Reads text files from configured knowledge directories
 * - Skips binary files based on extension whitelist
 * - Enforces configurable character limit with truncation
 * - Caches loaded content for performance
 *
 * @module project/knowledge-loader
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  ProjectConfig,
  KnowledgeEntry,
  LoadedProject,
} from './types.js';
import {
  KNOWLEDGE_FILE_EXTENSIONS,
  DEFAULT_MAX_KNOWLEDGE_LENGTH,
} from './types.js';

const logger = createLogger('KnowledgeLoader');

/**
 * Check if a file extension is supported for knowledge base reading.
 *
 * @param filePath - File path to check
 * @returns true if the file extension is in the supported set
 */
export function isSupportedKnowledgeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return KNOWLEDGE_FILE_EXTENSIONS.has(ext);
}

/**
 * Read a single file's content.
 *
 * @param absolutePath - Absolute path to the file
 * @returns File content string, or null if reading fails
 */
async function readFileContent(absolutePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(absolutePath, 'utf-8');
    return content;
  } catch (error) {
    logger.debug(
      { path: absolutePath, error: error instanceof Error ? error.message : String(error) },
      'Failed to read knowledge file, skipping',
    );
    return null;
  }
}

/**
 * Recursively collect all supported files from a directory.
 *
 * @param dirPath - Absolute directory path
 * @param maxDepth - Maximum recursion depth (default: 5)
 * @returns Array of absolute file paths
 */
async function collectFiles(dirPath: string, maxDepth: number = 5): Promise<string[]> {
  const files: string[] = [];

  if (maxDepth <= 0) {
    return files;
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // Skip hidden files and directories (starting with .)
      if (entry.name.startsWith('.')) {
        continue;
      }

      // Skip node_modules and common dependency directories
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '__pycache__') {
        continue;
      }

      if (entry.isDirectory()) {
        const subFiles = await collectFiles(fullPath, maxDepth - 1);
        files.push(...subFiles);
      } else if (entry.isFile() && isSupportedKnowledgeFile(fullPath)) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    logger.debug(
      { path: dirPath, error: error instanceof Error ? error.message : String(error) },
      'Failed to read knowledge directory, skipping',
    );
  }

  return files;
}

/**
 * Load knowledge entries from a list of source paths.
 *
 * Each source path can be a file or a directory.
 * Directories are recursively scanned for supported files.
 *
 * @param sources - Array of source paths (absolute)
 * @returns Array of KnowledgeEntry objects
 */
export async function loadKnowledgeEntries(
  sources: string[],
): Promise<KnowledgeEntry[]> {
  const entries: KnowledgeEntry[] = [];

  for (const source of sources) {
    try {
      const stat = await fs.stat(source);

      if (stat.isFile()) {
        if (!isSupportedKnowledgeFile(source)) {
          logger.debug({ path: source }, 'Skipping unsupported file format');
          continue;
        }

        const content = await readFileContent(source);
        if (content !== null) {
          entries.push({
            relativePath: path.basename(source),
            absolutePath: source,
            content,
            size: content.length,
          });
        }
      } else if (stat.isDirectory()) {
        const files = await collectFiles(source);

        for (const filePath of files) {
          const content = await readFileContent(filePath);
          if (content !== null) {
            entries.push({
              relativePath: path.relative(source, filePath),
              absolutePath: filePath,
              content,
              size: content.length,
            });
          }
        }
      }
    } catch (error) {
      logger.debug(
        { path: source, error: error instanceof Error ? error.message : String(error) },
        'Failed to access knowledge source, skipping',
      );
    }
  }

  return entries;
}

/**
 * Load instructions from a CLAUDE.md file or custom instructions path.
 *
 * @param instructionsPath - Absolute path to the instructions file
 * @returns Instructions content, or null if file doesn't exist or can't be read
 */
export async function loadInstructions(
  instructionsPath: string,
): Promise<string | null> {
  try {
    const stat = await fs.stat(instructionsPath);
    if (!stat.isFile()) {
      return null;
    }

    const content = await readFileContent(instructionsPath);
    return content;
  } catch {
    // File doesn't exist or can't be read - this is normal for optional instructions
    return null;
  }
}

/**
 * Load a complete project configuration.
 *
 * Reads instructions and knowledge files, then formats them
 * for injection into the agent prompt.
 *
 * @param projectName - Name of the project
 * @param config - Project configuration
 * @param workspaceDir - Workspace directory for resolving relative paths
 * @returns LoadedProject with instructions, knowledge entries, and metadata
 */
export async function loadProject(
  projectName: string,
  config: ProjectConfig,
  workspaceDir: string,
): Promise<LoadedProject> {
  const maxKnowledgeLength = config.maxKnowledgeLength ?? DEFAULT_MAX_KNOWLEDGE_LENGTH;

  // Load instructions
  let instructions: string | null = null;
  if (config.instructionsPath) {
    const resolvedPath = path.isAbsolute(config.instructionsPath)
      ? config.instructionsPath
      : path.resolve(workspaceDir, config.instructionsPath);
    instructions = await loadInstructions(resolvedPath);
  }

  // Load knowledge files
  let knowledge: KnowledgeEntry[] = [];
  if (config.knowledge && config.knowledge.length > 0) {
    const resolvedSources = config.knowledge.map(source =>
      path.isAbsolute(source) ? source : path.resolve(workspaceDir, source),
    );
    knowledge = await loadKnowledgeEntries(resolvedSources);
  }

  // Calculate total length and truncate if necessary
  let totalLength = knowledge.reduce((sum, entry) => sum + entry.size, 0);
  let truncated = false;
  let originalLength = totalLength;

  if (totalLength > maxKnowledgeLength) {
    truncated = true;
    // Keep entries that fit, truncate the last one
    let accumulated = 0;
    const truncatedKnowledge: KnowledgeEntry[] = [];

    for (const entry of knowledge) {
      if (accumulated + entry.size <= maxKnowledgeLength) {
        truncatedKnowledge.push(entry);
        accumulated += entry.size;
      } else {
        // Truncate the last entry to fit
        const remaining = maxKnowledgeLength - accumulated;
        if (remaining > 0) {
          truncatedKnowledge.push({
            ...entry,
            content: entry.content.slice(0, remaining) + '\n\n... [truncated]',
            size: remaining,
          });
          accumulated = maxKnowledgeLength;
        }
        break;
      }
    }

    knowledge = truncatedKnowledge;
    totalLength = accumulated;
  }

  logger.info({
    project: projectName,
    instructions: instructions ? `${instructions.length} chars` : 'none',
    knowledgeFiles: knowledge.length,
    totalKnowledgeLength: totalLength,
    truncated,
  }, 'Project loaded');

  return {
    name: projectName,
    instructions,
    knowledge,
    truncated,
    originalLength,
    totalLength,
  };
}

/**
 * Format loaded project as a prompt section.
 *
 * Combines instructions and knowledge entries into a single
 * Markdown section suitable for injection into the agent prompt.
 *
 * @param project - Loaded project data
 * @returns Formatted Markdown string for prompt injection, or empty string if no content
 */
export function formatProjectAsPromptSection(project: LoadedProject): string {
  const sections: string[] = [];

  // Project instructions section
  if (project.instructions) {
    sections.push(
      `## Project Instructions\n\n${project.instructions}`,
    );
  }

  // Knowledge base section
  if (project.knowledge.length > 0) {
    const knowledgeParts = project.knowledge.map(entry => {
      const header = `### 📄 ${entry.relativePath}`;
      return `${header}\n\n\`\`\`\n${entry.content}\n\`\`\``;
    });

    let knowledgeSection = `## Project Knowledge Base\n\n`;
    knowledgeSection += `> ${project.knowledge.length} file(s) loaded`;
    if (project.truncated) {
      knowledgeSection += ` (truncated from ${project.originalLength.toLocaleString()} to ${project.totalLength.toLocaleString()} chars)`;
    }
    knowledgeSection += `\n\n`;
    knowledgeSection += knowledgeParts.join('\n\n');
    sections.push(knowledgeSection);
  }

  if (sections.length === 0) {
    return '';
  }

  return `--- Project Context: ${project.name} ---\n\n${sections.join('\n\n---\n\n')}\n\n--- End Project Context ---`;
}
