/**
 * Type definitions for the ProjectManager module.
 *
 * Implements the unified ProjectContext system — per-chatId Agent context switching
 * based on template instantiation.
 *
 * @see docs/proposals/unified-project-context.md §2 Data Model
 * @see Issue #1916 (parent), Issue #2223 (this file)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for ProjectManager operations.
 *
 * Success: `{ ok: true, data: T }` — operation completed successfully.
 * Failure: `{ ok: false, error: string }` — validation or runtime error.
 *
 * Callers should check `ok` before accessing `data`.
 * Error messages are human-readable (Chinese) for direct user display.
 */
export type ProjectResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Template Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Project template — defines a blueprint for creating project instances.
 *
 * Template CLAUDE.md source: `{packageDir}/templates/{name}/CLAUDE.md`
 * Instance workingDir: `{workspace}/projects/{name}/`
 *
 * Templates are auto-discovered from `{packageDir}/templates/` directories.
 * Config `projectTemplates` can optionally override metadata (displayName, description)
 * or declare additional templates not present on the filesystem.
 * The "default" project is always implicitly available (no template needed).
 */
export interface ProjectTemplate {
  /** Template name (unique identifier, e.g. "research", "book-reader") */
  name: string;

  /** Human-readable display name (e.g. "研究模式") */
  displayName?: string;

  /** Template description for /project list display */
  description?: string;
}

/**
 * Configuration format for projectTemplates in disclaude.config.yaml.
 *
 * Key = template name, Value = optional display metadata.
 *
 * Templates are primarily auto-discovered from `{packageDir}/templates/`.
 * This config serves as an **optional override**: it can customize metadata
 * for discovered templates or declare additional templates not on the filesystem.
 *
 * ```yaml
 * projectTemplates:
 *   research:
 *     displayName: "研究模式"
 *     description: "专注研究的独立空间"
 * ```
 */
export type ProjectTemplatesConfig = Record<
  string,
  {
    displayName?: string;
    description?: string;
  }
>;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Instance Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Active project configuration for an Agent session.
 *
 * Returned by `getActive(chatId)` and used to determine Agent cwd.
 *
 * Source:
 * - default: implicitly built-in, workingDir = workspace root
 * - others: instantiated from template, user-specified name
 *
 * Note: CLAUDE.md is only copied from template at instantiation time.
 * chatId → name binding is managed by `chatProjectMap`, not stored on the instance.
 */
export interface ProjectContextConfig {
  /** Instance name (user-specified at creation, globally unique) */
  name: string;

  /** Source template name (set at instantiation time, undefined for "default") */
  templateName?: string;

  /** Instance working directory (Agent discovers CLAUDE.md here) */
  workingDir: string;
}

/**
 * Instance details for `listInstances()` return value.
 *
 * Differs from `ProjectContextConfig`: includes binding relationships and metadata.
 * Does NOT include "default" (implicit built-in, not shown in list).
 */
export interface InstanceInfo {
  /** Instance name */
  name: string;

  /** Source template name */
  templateName: string;

  /** All chatIds bound to this instance (supports sharing) */
  chatIds: string[];

  /** Instance working directory */
  workingDir: string;

  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CwdProvider
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Callback for dynamically querying the current project's working directory.
 *
 * Injected into ChatAgent to resolve cwd at `startAgentLoop()` time.
 * Returns `undefined` for "default" project → SDK falls back to `getWorkspaceDir()`.
 *
 * @param chatId - The chat session identifier
 * @returns The project's working directory, or undefined for default
 */
export type CwdProvider = (chatId: string) => string | undefined;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Single instance entry in the persistence file.
 *
 * Stored in `{workspace}/.disclaude/projects.json`.
 */
export interface PersistedInstance {
  /** Instance name */
  name: string;

  /** Source template name */
  templateName: string;

  /** Instance working directory */
  workingDir: string;

  /** ISO 8601 creation timestamp */
  createdAt: string;
}

/**
 * Full schema for `{workspace}/.disclaude/projects.json`.
 *
 * Uses write-then-rename pattern (write `.tmp` first, then atomic `rename`)
 * to prevent corruption on crash/interruption.
 *
 * Persisted on every mutation: create, use, reset.
 */
export interface ProjectsPersistData {
  /** Map of instance name → persisted instance data */
  instances: Record<string, PersistedInstance>;

  /** Map of chatId → instance name (binding relationships) */
  chatProjectMap: Record<string, string>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a ProjectManager instance.
 *
 * Templates are auto-discovered from `{packageDir}/templates/`.
 * `templatesConfig` is optional and serves as an override/extension mechanism.
 *
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2286 (auto-discovery from package directory)
 */
export interface ProjectManagerOptions {
  /** Workspace root directory (parent of `projects/` instances dir) */
  workspaceDir: string;

  /** Package directory (contains `templates/` with built-in CLAUDE.md files) */
  packageDir: string;

  /** Optional template configuration override from disclaude.config.yaml */
  templatesConfig?: ProjectTemplatesConfig;
}
