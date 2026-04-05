/**
 * Project Knowledge Base & Instructions module.
 *
 * Issue #1916: Claude Projects-like knowledge management.
 *
 * This module provides:
 * - Project configuration types
 * - Knowledge base file loader
 * - Project state manager (per-chat project selection)
 * - Prompt section formatting
 *
 * @module project
 */

// Types
export type {
  ProjectConfig,
  ProjectsConfig,
  KnowledgeEntry,
  LoadedProject,
} from './types.js';

export {
  KNOWLEDGE_FILE_EXTENSIONS,
  DEFAULT_MAX_KNOWLEDGE_LENGTH,
} from './types.js';

// Knowledge loader
export {
  isSupportedKnowledgeFile,
  loadKnowledgeEntries,
  loadInstructions,
  loadProject,
  formatProjectAsPromptSection,
} from './knowledge-loader.js';

// Project manager
export { ProjectManager } from './project-manager.js';
