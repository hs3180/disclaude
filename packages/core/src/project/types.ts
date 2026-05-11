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
 * - others: bound working directory via `/project use`
 */
export interface ProjectContextConfig {
  /** Project name (workingDir path for bound projects, 'default' for unbound) */
  name: string;

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
// Constructor Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a ProjectManager instance.
 *
 * @see Issue #3519 (simplified /project command)
 */
export interface ProjectManagerOptions {
  /** Workspace root directory (default working directory when no binding exists) */
  workspaceDir: string;
}
