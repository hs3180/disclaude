/**
 * Project module — Unified ProjectContext system.
 *
 * Provides per-chatId Agent context switching based on template instantiation.
 *
 * @module project
 * @see Issue #1916
 */

export { ProjectManager } from './project-manager.js';
export type {
  ProjectTemplate,
  ProjectTemplateConfig,
  ProjectContextConfig,
  InstanceInfo,
  CwdProvider,
  Result,
  ProjectData,
} from './types.js';
