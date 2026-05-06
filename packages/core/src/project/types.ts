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
 * Templates are auto-discovered from `{packageDir}/templates/` by default.
 * Config entries can override metadata (displayName/description) or declare
 * virtual templates not present on disk.
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
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 */
export interface ProjectManagerOptions {
  /** Workspace root directory (parent of `projects/` instances dir) */
  workspaceDir: string;

  /** Package directory (contains `templates/` with built-in CLAUDE.md files) */
  packageDir: string;

  /**
   * Template configuration overrides from disclaude.config.yaml.
   *
   * When provided, these entries override/extend auto-discovered templates.
   * When omitted, templates are auto-discovered from `{packageDir}/templates/`.
   */
  templatesConfig?: ProjectTemplatesConfig;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Project Config (Phase 2 — Issue #3332)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Static project configuration for NonUserMessage routing.
 *
 * Defines a binding between a project key and a chatId, allowing
 * system-driven messages (scheduled tasks, A2A events) to be routed
 * to a specific ChatAgent with a specific working directory.
 *
 * Loaded from `disclaude.config.yaml` under `projects:` key.
 * This is separate from dynamically created instances — project configs
 * are static, admin-defined bindings.
 *
 * @see Issue #3332 (Phase 2 — Project-scoped ChatAgent with chatId binding)
 */
export interface ProjectConfig {
  /** Project key (e.g., 'hs3180/disclaude') — unique identifier for routing */
  key: string;

  /** Project working directory (Agent discovers CLAUDE.md here) */
  workingDir: string;

  /**
   * Bound chat ID — agent replies go here.
   * This is a real chat (e.g., a Feishu group for project maintenance).
   */
  chatId: string;

  /** Default model tier for scheduled tasks (optional) */
  modelTier?: 'low' | 'default' | 'high';

  /** Agent idle timeout in milliseconds (optional, default: 30min) */
  idleTimeoutMs?: number;
}

/**
 * YAML format for the `projects:` section in disclaude.config.yaml.
 *
 * Each entry maps to a ProjectConfig. The `workingDir` can be relative
 * to the disclaude workspace root.
 *
 * @example
 * ```yaml
 * projects:
 *   - key: "hs3180/disclaude"
 *     workingDir: "."
 *     chatId: "oc_3d14c151cc209fd7ac1176a2b7ecbc30"
 *     modelTier: "low"
 * ```
 */
export interface ProjectConfigYaml {
  /** Project key */
  key: string;

  /** Working directory (relative to workspace root or absolute) */
  workingDir: string;

  /** Bound chat ID */
  chatId: string;

  /** Model tier override */
  modelTier?: 'low' | 'default' | 'high';

  /** Idle timeout in milliseconds */
  idleTimeoutMs?: number;
}
