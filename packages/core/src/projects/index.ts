/**
 * Projects module - Claude Projects-like knowledge base and management.
 *
 * Issue #1916: Implements project-scoped knowledge base functionality
 * that allows configuring knowledge directories per project and
 * auto-injecting their content into agent prompts.
 *
 * @module projects
 */

export {
  KnowledgeBaseLoader,
} from './knowledge-base-loader.js';

export {
  ProjectManager,
} from './project-manager.js';

export type {
  ProjectConfig,
  ProjectsConfig,
  KnowledgeFile,
  KnowledgeBaseLoaderOptions,
  KnowledgeLoadResult,
  ProjectInfo,
} from './types.js';

export {
  DEFAULT_KNOWLEDGE_LOADER_OPTIONS,
} from './types.js';
