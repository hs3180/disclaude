/**
 * Project module — Claude Projects-like knowledge base and instructions.
 *
 * Issue #1916: Implements project-scoped instructions (CLAUDE.md) and
 * knowledge base (local directories) functionality.
 *
 * @module project
 */

export { ProjectManager } from './project-manager.js';
export {
  buildProjectContextSection,
  SUPPORTED_EXTENSIONS,
  DEFAULT_MAX_KNOWLEDGE_CHARS,
} from './context-builder.js';
export type {
  ProjectConfig,
  ProjectsConfig,
  KnowledgeFileEntry,
  ProjectContext,
} from '../config/types.js';
