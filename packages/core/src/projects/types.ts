/**
 * Project knowledge base and management types.
 *
 * Issue #1916: Implements Claude Projects-like knowledge base
 * and project instruction functionality.
 *
 * @module projects/types
 */

/**
 * Configuration for a single project.
 */
export interface ProjectConfig {
  /** Path to project instructions file (e.g., CLAUDE.md) */
  instructionsPath?: string;
  /** List of directory paths to scan for knowledge files */
  knowledge?: string[];
}

/**
 * Projects configuration section in disclaude.config.yaml.
 *
 * Example:
 * ```yaml
 * projects:
 *   default:
 *     instructions_path: ./CLAUDE.md
 *     knowledge:
 *       - ./docs/
 *       - ./data/
 *   book-reader:
 *     knowledge:
 *       - ./data/books/
 * ```
 */
export interface ProjectsConfig {
  /** Project configurations keyed by project name */
  [projectName: string]: ProjectConfig | undefined;
}

/**
 * A loaded knowledge file with its content.
 */
export interface KnowledgeFile {
  /** Absolute file path */
  path: string;
  /** File content as string */
  content: string;
  /** File size in bytes */
  size: number;
  /** Relative path from knowledge root directory */
  relativePath: string;
}

/**
 * Options for the knowledge base loader.
 */
export interface KnowledgeBaseLoaderOptions {
  /** Maximum file size in bytes (default: 100KB) */
  maxFileSize?: number;
  /** Maximum total content size in characters (default: 100K) */
  maxTotalSize?: number;
  /** Allowed file extensions (default: common text formats) */
  fileExtensions?: string[];
}

/**
 * Default options for the knowledge base loader.
 */
export const DEFAULT_KNOWLEDGE_LOADER_OPTIONS: Required<KnowledgeBaseLoaderOptions> = {
  maxFileSize: 100 * 1024,      // 100KB
  maxTotalSize: 100 * 1000,     // 100K characters
  fileExtensions: ['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.ts', '.js', '.py', '.go', '.rs'],
};

/**
 * Result of loading a project's knowledge base.
 */
export interface KnowledgeLoadResult {
  /** Formatted knowledge content for injection into prompt */
  content: string;
  /** Number of files loaded */
  fileCount: number;
  /** Total content size in characters */
  totalSize: number;
  /** List of loaded file paths */
  files: string[];
  /** Whether the content was truncated due to size limits */
  truncated: boolean;
}

/**
 * Information about a project for display purposes.
 */
export interface ProjectInfo {
  /** Project name */
  name: string;
  /** Whether this is the default project */
  isDefault: boolean;
  /** Number of knowledge directories configured */
  knowledgeDirCount: number;
  /** Whether instructions path is configured */
  hasInstructions: boolean;
}
