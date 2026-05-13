/**
 * Type definitions for the ProjectManager module.
 *
 * Simplified per-chatId working directory binding (Issue #3519).
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #1916 (parent — unified ProjectContext system)
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
// Project Context
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Active project configuration for an Agent session.
 *
 * Returned by `getActive(chatId)` and used to determine Agent cwd.
 *
 * Source:
 * - default: implicitly built-in, workingDir = workspace root
 * - others: bound working directory via `/project use`
 */
export interface ProjectContextConfig {
  /** Project name (basename of workingDir for bound projects, 'default' for unbound) */
  name: string;

  /** Instance working directory (Agent discovers CLAUDE.md here) */
  workingDir: string;
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
// Project State Types (Issue #3335)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Triage status for an issue in project state.
 */
export type IssueTriageStatus = 'untriaged' | 'triaged' | 'in-progress' | 'resolved';

/**
 * Issue entry in project state.
 *
 * Tracks issue metadata for project-bound agents performing triage and maintenance.
 */
export interface ProjectStateIssueEntry {
  /** Issue title */
  title: string;
  /** Issue state: 'open' | 'closed' */
  state: string;
  /** Triage status */
  triageStatus: IssueTriageStatus;
  /** Issue labels */
  labels: string[];
}

/**
 * PR review status in project state.
 */
export type PrReviewStatus = 'pending' | 'approved' | 'changes-requested' | 'merged';

/**
 * PR entry in project state.
 *
 * Tracks PR metadata for project-bound agents performing review triage.
 */
export interface ProjectStatePrEntry {
  /** PR title */
  title: string;
  /** Associated issue number (if any) */
  issueNumber?: number;
  /** Review status */
  reviewStatus: PrReviewStatus;
}

/**
 * Sync timestamps for project state.
 *
 * Records when the project agent last synced various data sources.
 */
export interface ProjectStateSync {
  /** Last GitHub issues sync (ISO 8601) */
  issues?: string;
  /** Last GitHub PRs sync (ISO 8601) */
  prs?: string;
}

/**
 * Project state file schema.
 *
 * Stored at `{project}/.disclaude/project-state.json`.
 * Read and written by ChatAgent via standard file tools.
 *
 * Design principle: State as files. The agent reads/writes this via
 * Read/Write tools — no special persistence API needed.
 *
 * @see Issue #3335 (Project state persistence)
 */
export interface ProjectState {
  /** Schema version (for future migrations) */
  version: number;
  /** Project key (e.g., 'hs3180/disclaude') */
  projectKey: string;
  /** Last activity timestamp (ISO 8601) */
  lastActive: string;
  /** Sync timestamps for various data sources */
  sync: ProjectStateSync;
  /** Tracked issues, keyed by issue number (string) */
  issues: Record<string, ProjectStateIssueEntry>;
  /** Tracked PRs, keyed by PR number (string) */
  prs: Record<string, ProjectStatePrEntry>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Template & Instance Types (Issue #1916)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Project template — blueprint for creating project instances.
 *
 * Templates define available project types. Their CLAUDE.md files are stored
 * at `{packageDir}/templates/{name}/CLAUDE.md` and copied to instances on creation.
 *
 * Only templates listed in `projectTemplates` config are available.
 */
export interface ProjectTemplate {
  /** Template name (matches directory name under templates/) */
  name: string;
  /** Display name for UI */
  displayName?: string;
  /** Description of the template */
  description?: string;
}

/**
 * Instance info — metadata about a created project instance.
 *
 * Returned by `listInstances()`. Includes binding information and creation metadata.
 * Does not include the default project (which is implicit).
 */
export interface InstanceInfo {
  /** Instance name (user-specified, globally unique) */
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
 * Persisted instance data (internal, stored in projects.json).
 */
export interface PersistedInstance {
  /** Source template name */
  templateName: string;
  /** Instance working directory */
  workingDir: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
}

/**
 * Persistence schema for `.disclaude/projects.json`.
 *
 * Stores instances and chatId → instance name bindings.
 */
export interface ProjectsPersistData {
  version: number;
  instances: Record<string, PersistedInstance>;
  chatProjectMap: Record<string, string>;
}

/**
 * Template configuration entry in disclaude.config.yaml.
 *
 * @see DisclaudeConfig.projectTemplates
 */
export interface ProjectTemplateConfig {
  displayName?: string;
  description?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a ProjectManager instance.
 *
 * @see Issue #3519 (simplified /project command)
 * @see Issue #1916 (template/instance model)
 */
export interface ProjectManagerOptions {
  /** Workspace root directory (default working directory when no binding exists) */
  workspaceDir: string;
  /** Package directory containing built-in templates (optional) */
  packageDir?: string;
  /** Template configuration from disclaude.config.yaml (optional) */
  projectTemplates?: Record<string, ProjectTemplateConfig>;
}
