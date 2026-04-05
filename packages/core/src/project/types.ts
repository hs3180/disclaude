/**
 * Project Knowledge Base & Instructions types.
 *
 * Implements Issue #1916: Claude Projects-like knowledge management.
 *
 * This module defines types for project-scoped instructions and
 * knowledge base configuration, following the CLAUDE.md + file system
 * approach described in the issue.
 *
 * @module project/types
 */

/**
 * Project configuration.
 *
 * Defines a named project with instructions and knowledge sources.
 * Instructions are loaded from CLAUDE.md (leveraging Claude Code's
 * native mechanism via `settingSources: ['project']`).
 * Knowledge files are injected into the prompt context.
 */
export interface ProjectConfig {
  /** Human-readable project name */
  name?: string;

  /**
   * Path to project instructions file (CLAUDE.md).
   * Relative paths are resolved against the workspace directory.
   * If not set, defaults to `<workspace>/CLAUDE.md`.
   *
   * The instructions file content is loaded and injected into the
   * MessageBuilder prompt as a "Project Instructions" section.
   */
  instructionsPath?: string;

  /**
   * Knowledge base source directories.
   * Files from these directories are read and their contents
   * injected into the prompt context.
   *
   * Relative paths are resolved against the workspace directory.
   *
   * Supported file formats: .md, .txt, .json, .yaml, .yml, .ts, .js, .py
   * Binary files (images, PDFs, etc.) are skipped.
   */
  knowledge?: string[];

  /**
   * Maximum total character length for knowledge base content.
   * Content exceeding this limit is truncated with a warning.
   * Default: 50000 (roughly 12.5K tokens).
   */
  maxKnowledgeLength?: number;
}

/**
 * Projects configuration section for disclaude.config.yaml.
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
  [projectName: string]: ProjectConfig | undefined;
}

/**
 * Loaded knowledge entry from a file.
 */
export interface KnowledgeEntry {
  /** Relative file path (from knowledge source root) */
  relativePath: string;
  /** Absolute file path */
  absolutePath: string;
  /** File content */
  content: string;
  /** File size in characters */
  size: number;
}

/**
 * Loaded project state.
 */
export interface LoadedProject {
  /** Project name */
  name: string;
  /** Resolved instructions content (from CLAUDE.md or instructions_path) */
  instructions: string | null;
  /** Loaded knowledge entries */
  knowledge: KnowledgeEntry[];
  /** Whether knowledge was truncated due to size limit */
  truncated: boolean;
  /** Original character count before truncation */
  originalLength: number;
  /** Total character count after truncation */
  totalLength: number;
}

/**
 * Knowledge file extensions that are safe to read as text.
 * Binary formats are excluded to avoid injecting garbage into prompts.
 */
export const KNOWLEDGE_FILE_EXTENSIONS = new Set([
  '.md', '.markdown',
  '.txt', '.text',
  '.json',
  '.yaml', '.yml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.sh', '.bash', '.zsh',
  '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv',
  '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.sql',
  '.graphql', '.gql',
  '.proto',
  '.env', '.env.local',
  '.dockerfile', '.gitignore', '.editorconfig',
]);

/**
 * Maximum default knowledge base length in characters.
 * ~50K characters ≈ 12.5K tokens, well within Claude's 200K context window.
 */
export const DEFAULT_MAX_KNOWLEDGE_LENGTH = 50000;
