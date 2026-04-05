/**
 * Knowledge base and project configuration types.
 *
 * Implements Issue #1916: Project-scoped knowledge base and instructions
 * similar to Claude Projects.
 *
 * @module knowledge/types
 */

/**
 * Configuration for a single project.
 *
 * A project defines:
 * - instructions_path: Path to a CLAUDE.md or similar file for project-level instructions
 * - knowledge: List of directories containing knowledge files to inject into context
 */
export interface ProjectConfig {
  /** Path to project instructions file (e.g., ./CLAUDE.md) */
  instructions_path?: string;
  /** List of directory paths containing knowledge files */
  knowledge?: string[];
}

/**
 * Projects configuration section.
 *
 * Maps project names to their configurations.
 * The "default" project is used when no project is explicitly selected.
 *
 * @example
 * ```yaml
 * projects:
 *   default:
 *     instructions_path: ./CLAUDE.md
 *     knowledge:
 *       - ./docs/
 *       - ./data/
 *   book-reader:
 *     instructions_path: ./projects/book-reader/CLAUDE.md
 *     knowledge:
 *       - ./data/books/
 * ```
 */
export interface ProjectsConfig {
  [projectName: string]: ProjectConfig;
}

/**
 * Supported knowledge file extensions.
 * Only text-based files are included to avoid injecting binary content.
 */
export const SUPPORTED_KNOWLEDGE_EXTENSIONS = new Set([
  '.md', '.txt', '.markdown',
  '.ts', '.js', '.jsx', '.tsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.toml',
  '.py', '.rb', '.go', '.rs', '.java',
  '.sh', '.bash', '.zsh',
  '.sql', '.graphql',
  '.html', '.htm', '.css', '.scss', '.less',
  '.xml', '.csv',
  '.env', '.gitignore', '.dockerignore',
  '.cfg', '.conf', '.ini',
]);

/** Maximum total character length for knowledge content (200K tokens ≈ ~800K chars) */
export const MAX_KNOWLEDGE_CHARS = 800_000;

/** Default maximum characters per knowledge file */
export const MAX_FILE_CHARS = 100_000;

/**
 * Information about a loaded knowledge file.
 */
export interface KnowledgeFileInfo {
  /** Relative path from the knowledge directory root */
  relativePath: string;
  /** Absolute path to the file */
  absolutePath: string;
  /** File size in bytes */
  size: number;
  /** File extension */
  extension: string;
}

/**
 * Result of loading a project's knowledge base.
 */
export interface KnowledgeLoadResult {
  /** Name of the loaded project */
  projectName: string;
  /** Whether the project was found in config */
  projectFound: boolean;
  /** Loaded project instructions content (from CLAUDE.md or similar) */
  instructions?: string;
  /** Path to the instructions file */
  instructionsPath?: string;
  /** List of loaded knowledge files */
  files: KnowledgeFileInfo[];
  /** Combined knowledge content from all files */
  knowledgeContent: string;
  /** Total character count of knowledge content */
  totalChars: number;
  /** Whether content was truncated due to size limits */
  truncated: boolean;
  /** Errors encountered during loading (non-fatal) */
  errors: string[];
}

/**
 * Project state for a chat session.
 */
export interface ProjectState {
  /** Currently active project name */
  currentProject: string;
  /** Timestamp when the project was last switched */
  switchedAt: number;
}

/**
 * Summary of available projects.
 */
export interface ProjectSummary {
  /** Project name */
  name: string;
  /** Whether this is the default project */
  isDefault: boolean;
  /** Whether instructions file is configured */
  hasInstructions: boolean;
  /** Number of knowledge directories configured */
  knowledgeDirCount: number;
}
