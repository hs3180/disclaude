/**
 * Knowledge Base Loader - Scans directories and loads text files for project knowledge.
 *
 * Issue #1916: Implements the knowledge base loading component of the
 * Claude Projects-like feature.
 *
 * This module scans configured directories for text files, reads their content,
 * and formats them for injection into the agent prompt. It handles:
 * - Recursive directory scanning
 * - File extension filtering
 * - Size limits (per-file and total)
 * - Content truncation with clear markers
 *
 * @module projects/knowledge-base-loader
 */

import path from 'path';
import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import {
  type KnowledgeFile,
  type KnowledgeLoadResult,
  type KnowledgeBaseLoaderOptions,
  DEFAULT_KNOWLEDGE_LOADER_OPTIONS,
} from './types.js';

const logger = createLogger('KnowledgeBaseLoader');

/**
 * Supported binary file extensions to skip.
 * These file types are not useful as knowledge base content.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.lock', '.log',
]);

/**
 * Directories to skip during recursive scanning.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '__pycache__',
  '.next', '.nuxt', 'dist', 'build', 'coverage',
  '.cache', '.tmp', '.temp', 'tmp', 'temp',
]);

export class KnowledgeBaseLoader {
  private readonly options: Required<KnowledgeBaseLoaderOptions>;

  constructor(options?: KnowledgeBaseLoaderOptions) {
    this.options = {
      ...DEFAULT_KNOWLEDGE_LOADER_OPTIONS,
      ...options,
    };
  }

  /**
   * Load knowledge base content from a list of directory paths.
   *
   * Scans each directory recursively for text files, reads their content,
   * and formats them into a single knowledge context string.
   *
   * @param dirs - List of directory paths to scan
   * @returns Formatted knowledge content for prompt injection
   */
  async loadFromDirectories(dirs: string[]): Promise<KnowledgeLoadResult> {
    if (!dirs || dirs.length === 0) {
      return { content: '', fileCount: 0, totalSize: 0, files: [], truncated: false };
    }

    const allFiles: KnowledgeFile[] = [];

    for (const dir of dirs) {
      try {
        const files = await this.scanDirectory(dir);
        allFiles.push(...files);
      } catch (error) {
        logger.warn(
          { dir, err: error instanceof Error ? error.message : String(error) },
          'Failed to scan knowledge directory, skipping'
        );
      }
    }

    if (allFiles.length === 0) {
      return { content: '', fileCount: 0, totalSize: 0, files: [], truncated: false };
    }

    return this.formatKnowledgeContent(allFiles);
  }

  /**
   * Recursively scan a directory for text files.
   *
   * @param dir - Directory path to scan
   * @returns List of knowledge files with their content
   */
  async scanDirectory(dir: string): Promise<KnowledgeFile[]> {
    const absoluteDir = path.resolve(dir);
    const files: KnowledgeFile[] = [];

    if (!fs.existsSync(absoluteDir)) {
      logger.warn({ dir: absoluteDir }, 'Knowledge directory does not exist');
      return files;
    }

    const stat = fs.statSync(absoluteDir);
    if (!stat.isDirectory()) {
      logger.warn({ dir: absoluteDir }, 'Knowledge path is not a directory');
      return files;
    }

    await this.scanRecursive(absoluteDir, absoluteDir, files);

    return files;
  }

  /**
   * Recursively scan a directory and collect text files.
   */
  private async scanRecursive(
    currentDir: string,
    rootDir: string,
    files: KnowledgeFile[]
  ): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip known non-useful directories
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await this.scanRecursive(fullPath, rootDir, files);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        // Skip binary files
        if (BINARY_EXTENSIONS.has(ext)) {
          continue;
        }

        // Check file extension filter
        if (ext && !this.options.fileExtensions.includes(ext)) {
          continue;
        }

        try {
          const stat = await fs.promises.stat(fullPath);

          // Skip files exceeding size limit
          if (stat.size > this.options.maxFileSize) {
            logger.debug(
              { file: fullPath, size: stat.size, maxSize: this.options.maxFileSize },
              'Skipping knowledge file (exceeds size limit)'
            );
            continue;
          }

          const content = await fs.promises.readFile(fullPath, 'utf-8');
          const relativePath = path.relative(rootDir, fullPath);

          files.push({
            path: fullPath,
            content,
            size: stat.size,
            relativePath,
          });
        } catch (error) {
          logger.debug(
            { file: fullPath, err: error instanceof Error ? error.message : String(error) },
            'Failed to read knowledge file, skipping'
          );
        }
      }
    }
  }

  /**
   * Format collected knowledge files into a single context string.
   *
   * Each file's content is prefixed with its relative path as a header.
   * Total content is truncated if it exceeds the configured maximum.
   *
   * @param files - List of knowledge files
   * @returns Formatted knowledge content with metadata
   */
  formatKnowledgeContent(files: KnowledgeFile[]): KnowledgeLoadResult {
    const parts: string[] = [];
    let totalSize = 0;
    let truncated = false;

    for (const file of files) {
      const fileHeader = `### 📄 ${file.relativePath}`;
      const fileContent = file.content.trim();
      const fileSection = `${fileHeader}\n\n${fileContent}`;

      // Check if adding this file would exceed total size limit
      if (totalSize + fileSection.length > this.options.maxTotalSize) {
        truncated = true;
        logger.info(
          {
            file: file.relativePath,
            currentSize: totalSize,
            maxSize: this.options.maxTotalSize,
          },
          'Knowledge base content truncated (size limit reached)'
        );
        break;
      }

      parts.push(fileSection);
      totalSize += fileSection.length;
    }

    const content = parts.length > 0
      ? parts.join('\n\n---\n\n')
      : '';

    return {
      content,
      fileCount: parts.length,
      totalSize,
      files: files.slice(0, parts.length).map(f => f.relativePath),
      truncated,
    };
  }
}
