/**
 * Project Context types.
 *
 * Defines the data model for the unified ProjectContext system,
 * which provides per-chatId Agent context switching via template instantiation.
 *
 * @see Issue #1916 - Feature: 统一 ProjectContext 系统
 * @module project/types
 */

/**
 * A callback that returns the working directory for a given chatId.
 *
 * Used by Pilot to dynamically query the current project's cwd
 * without directly depending on ProjectManager.
 */
export type CwdProvider = (chatId: string) => string | undefined;

/**
 * Project template — a blueprint for creating project instances.
 *
 * Template CLAUDE.md source: {packageDir}/templates/{name}/CLAUDE.md
 * Instance workingDir: {workspace}/projects/{name}/
 *
 * Only templates listed in projectTemplates config are available.
 */
export interface ProjectTemplate {
  /** Template name (unique identifier) */
  name: string;

  /** Display name for UI */
  displayName?: string;

  /** Description for UI */
  description?: string;
}

/**
 * Unified project configuration (instance).
 *
 * Instance sources:
 * 1. default: Implicitly built-in, workingDir = workspace root
 * 2. Others: Instantiated from projectTemplates, user-specified name
 *
 * CLAUDE.md is only copied from template to workingDir at instantiation time.
 * chatId → name binding is managed by chatProjectMap, not stored on the instance.
 */
export interface ProjectContextConfig {
  /** Instance name (user-specified, globally unique) */
  name: string;

  /** Source template name (set at instantiation time) */
  templateName?: string;

  /** Working directory for this instance */
  workingDir: string;
}

/**
 * Instance details (returned by listInstances).
 *
 * Extends ProjectContextConfig with binding relationships and metadata.
 * Does not include "default" (implicit, not listed).
 */
export interface InstanceInfo {
  /** Instance name */
  name: string;

  /** Source template name */
  templateName: string;

  /** All chatIds bound to this instance (supports sharing) */
  chatIds: string[];

  /** Working directory */
  workingDir: string;

  /** Creation time (ISO string) */
  createdAt: string;
}

/**
 * Result type for operations that can fail.
 */
export type ProjectResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Configuration for project templates, stored in DisclaudeConfig.
 *
 * Maps template names to their display metadata.
 * The actual CLAUDE.md files live in {packageDir}/templates/{name}/CLAUDE.md.
 */
export interface ProjectTemplatesConfig {
  [templateName: string]: {
    displayName?: string;
    description?: string;
  };
}

/**
 * Persistence format for projects.json.
 *
 * Stored at {workspace}/.disclaude/projects.json
 */
export interface ProjectsPersistData {
  /** Map of instance name → instance data */
  projects: Record<string, {
    templateName: string;
    workingDir: string;
    createdAt: string;
  }>;
  /** Map of chatId → instance name binding */
  chatProjectMap: Record<string, string>;
}
