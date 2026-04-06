/**
 * Project Context types.
 *
 * Defines the data model for the unified ProjectContext system,
 * which provides per-chatId Agent context switching based on template instantiation.
 *
 * @module project/types
 * @see Issue #1916
 */

/**
 * Project template definition (runtime).
 *
 * Templates are blueprints for creating project instances.
 * The CLAUDE.md source file is located at: {packageDir}/templates/{name}/CLAUDE.md
 */
export interface ProjectTemplate {
  /** Template name (unique identifier) */
  name: string;
  /** Display name for UI */
  displayName?: string;
  /** Description */
  description?: string;
}

/**
 * Project template configuration (from config file).
 *
 * In disclaude.config.yaml:
 * ```yaml
 * projectTemplates:
 *   research:
 *     displayName: "研究模式"
 *     description: "专注研究的独立空间"
 * ```
 */
export interface ProjectTemplateConfig {
  displayName?: string;
  description?: string;
}

/**
 * Unified project configuration (instance).
 *
 * Represents a project instance that an Agent can be bound to.
 * - default: implicit built-in, workingDir = workspace root
 * - others: instantiated from templates, user-specified name
 *
 * CLAUDE.md is only copied during template instantiation. No other injection mechanism exists.
 */
export interface ProjectContextConfig {
  /** Instance name (user-specified, globally unique) */
  name: string;
  /** Source template name (set during instantiation) */
  templateName?: string;
  /** Instance working directory */
  workingDir: string;
}

/**
 * Instance details (for listInstances return value).
 *
 * Unlike ProjectContextConfig, includes binding relationships and metadata.
 * Does not include "default" (implicit built-in, not shown in listing).
 */
export interface InstanceInfo {
  /** Instance name */
  name: string;
  /** Source template name */
  templateName: string;
  /** All chatIds bound to this instance */
  chatIds: string[];
  /** Instance working directory */
  workingDir: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
}

/**
 * CwdProvider callback type.
 *
 * Used by Pilot to dynamically query the current project's working directory.
 * Returns undefined for default project (falls through to getWorkspaceDir()).
 */
export type CwdProvider = (chatId: string) => string | undefined;

/**
 * Result type for operations that can fail.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Persisted project data structure (stored in projects.json).
 */
export interface ProjectData {
  /** Map of instance name → instance config */
  projects: Record<string, {
    templateName: string;
    createdAt: string;
  }>;
  /** Map of chatId → instance name binding */
  chatProjectMap: Record<string, string>;
}
