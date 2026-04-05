/**
 * Knowledge base loader.
 *
 * Reads project instructions (CLAUDE.md) and knowledge files from configured
 * directories, combining them into a context string for injection into agent prompts.
 *
 * Implements Issue #1916: Project-scoped knowledge base.
 *
 * @module knowledge/loader
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  ProjectConfig,
  KnowledgeLoadResult,
  KnowledgeFileInfo,
} from './types.js';
import {
  SUPPORTED_KNOWLEDGE_EXTENSIONS,
  MAX_KNOWLEDGE_CHARS,
  MAX_FILE_CHARS,
} from './types.js';

const logger = createLogger('KnowledgeLoader');

/**
 * Load a project's knowledge base including instructions and knowledge files.
 *
 * @param projectName - Name of the project to load
 * @param projectConfig - Project configuration
 * @param baseDir - Base directory for resolving relative paths
 * @returns Knowledge load result with instructions and file contents
 */
export async function loadProjectKnowledge(
  projectName: string,
  projectConfig: ProjectConfig,
  baseDir: string
): Promise<KnowledgeLoadResult> {
  const result: KnowledgeLoadResult = {
    projectName,
    projectFound: true,
    files: [],
    knowledgeContent: '',
    totalChars: 0,
    truncated: false,
    errors: [],
  };

  // Load project instructions (CLAUDE.md or custom path)
  if (projectConfig.instructions_path) {
    try {
      const instructionsPath = path.resolve(baseDir, projectConfig.instructions_path);
      const content = await readFileWithLimit(instructionsPath, MAX_FILE_CHARS);
      if (content !== null) {
        result.instructions = content;
        result.instructionsPath = instructionsPath;
        result.totalChars += content.length;
        logger.debug(
          { projectName, instructionsPath, chars: content.length },
          'Loaded project instructions'
        );
      }
    } catch (error) {
      const msg = `Failed to load instructions: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(msg);
      logger.warn({ projectName, err: error }, 'Failed to load project instructions');
    }
  }

  // Load knowledge files from configured directories
  if (projectConfig.knowledge && projectConfig.knowledge.length > 0) {
    const knowledgeParts: string[] = [];

    for (const knowledgeDir of projectConfig.knowledge) {
      try {
        const resolvedDir = path.resolve(baseDir, knowledgeDir);
        const files = await collectKnowledgeFiles(resolvedDir);
        result.files.push(...files);

        for (const file of files) {
          // Check if we've hit the total limit
          if (result.totalChars >= MAX_KNOWLEDGE_CHARS) {
            result.truncated = true;
            logger.warn(
              { projectName, totalChars: result.totalChars, limit: MAX_KNOWLEDGE_CHARS },
              'Knowledge content truncated due to size limit'
            );
            break;
          }

          try {
            const content = await readFileWithLimit(file.absolutePath, MAX_FILE_CHARS);
            if (content !== null) {
              const header = `\n### ${file.relativePath}\n\n`;
              const newTotal = result.totalChars + header.length + content.length;

              if (newTotal > MAX_KNOWLEDGE_CHARS) {
                // Truncate this file to fit
                const remaining = MAX_KNOWLEDGE_CHARS - result.totalChars - header.length;
                if (remaining > 0) {
                  knowledgeParts.push(header + content.slice(0, remaining) + '\n... [truncated]');
                  result.totalChars = MAX_KNOWLEDGE_CHARS;
                  result.truncated = true;
                }
              } else {
                knowledgeParts.push(header + content);
                result.totalChars = newTotal;
              }
            }
          } catch (error) {
            const msg = `Failed to read ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`;
            result.errors.push(msg);
            logger.warn({ file: file.relativePath, err: error }, 'Failed to read knowledge file');
          }
        }

        if (result.totalChars >= MAX_KNOWLEDGE_CHARS) {
          break;
        }
      } catch (error) {
        const msg = `Failed to scan knowledge directory "${knowledgeDir}": ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(msg);
        logger.warn({ knowledgeDir, err: error }, 'Failed to scan knowledge directory');
      }
    }

    result.knowledgeContent = knowledgeParts.join('\n---\n');
  }

  logger.info(
    {
      projectName,
      filesLoaded: result.files.length,
      totalChars: result.totalChars,
      hasInstructions: !!result.instructions,
      truncated: result.truncated,
      errors: result.errors.length,
    },
    'Project knowledge loaded'
  );

  return result;
}

/**
 * Read a file with character limit.
 *
 * @param filePath - Absolute path to the file
 * @param maxChars - Maximum characters to read
 * @returns File content as string, or null if file doesn't exist
 */
async function readFileWithLimit(
  filePath: string,
  maxChars: number
): Promise<string | null> {
  try {
    const buffer = await fs.readFile(filePath);
    let content = buffer.toString('utf-8');

    // Skip binary-like files (null bytes)
    if (content.includes('\x00')) {
      logger.debug({ filePath }, 'Skipping binary file');
      return null;
    }

    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '\n... [file truncated]';
    }

    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Recursively collect knowledge files from a directory.
 *
 * Only includes files with supported extensions.
 * Skips hidden files/directories, node_modules, .git, etc.
 *
 * @param dir - Directory to scan
 * @param relativeBase - Base path for relative path calculation
 * @returns List of knowledge file info
 */
async function collectKnowledgeFiles(
  dir: string,
  relativeBase: string = dir
): Promise<KnowledgeFileInfo[]> {
  const files: KnowledgeFileInfo[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files/directories and common exclude patterns
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(relativeBase, fullPath);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subFiles = await collectKnowledgeFiles(fullPath, relativeBase);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_KNOWLEDGE_EXTENSIONS.has(ext)) {
          try {
            const stat = await fs.stat(fullPath);
            files.push({
              relativePath,
              absolutePath: fullPath,
              size: stat.size,
              extension: ext,
            });
          } catch {
            // Skip files that can't be stat'd
          }
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ dir }, 'Knowledge directory does not exist');
    } else {
      throw error;
    }
  }

  return files;
}

/**
 * Build a formatted knowledge section for injection into agent prompts.
 *
 * @param result - Knowledge load result
 * @returns Formatted knowledge section string, or empty string if no content
 */
export function buildKnowledgeSection(result: KnowledgeLoadResult): string {
  const sections: string[] = [];

  // Project name header
  sections.push(`## Project Knowledge: ${result.projectName}`);

  // Instructions section
  if (result.instructions) {
    sections.push(`\n### Project Instructions\n\n${result.instructions}`);
  }

  // Knowledge files section
  if (result.knowledgeContent) {
    sections.push(`\n### Knowledge Base\n\n${result.knowledgeContent}`);
    if (result.truncated) {
      sections.push('\n> ⚠️ Knowledge content was truncated due to size limits.');
    }
  }

  // Summary footer
  if (result.files.length > 0) {
    sections.push(
      `\n---\n*Loaded ${result.files.length} file(s), ${result.totalChars.toLocaleString()} characters total.*`
    );
  }

  if (sections.length <= 1) {
    return '';
  }

  return sections.join('\n\n');
}
