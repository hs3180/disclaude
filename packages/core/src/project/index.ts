/**
 * Project module — Unified ProjectContext system.
 *
 * Provides per-chatId Agent context switching via template instantiation.
 *
 * @see Issue #1916 - Feature: 统一 ProjectContext 系统
 * @module project
 */

// Types
export type {
  CwdProvider,
  ProjectTemplate,
  ProjectContextConfig,
  InstanceInfo,
  ProjectResult,
  ProjectTemplatesConfig,
  ProjectsPersistData,
} from './types.js';

// Core
export { ProjectManager, type ProjectManagerOptions } from './project-manager.js';
