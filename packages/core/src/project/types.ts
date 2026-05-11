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
// Project Configuration (Issue #3332)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Pre-configured project definition loaded from disclaude.config.yaml.
 *
 * Each project defines a binding between a project key, a working directory,
 * and a designated chatId where the project-bound agent operates.
 *
 * @see Issue #3332 (Project-scoped ChatAgent with chatId binding)
 */
export interface ProjectConfig {
  /** Unique project key (e.g., 'hs3180/disclaude') */
  key: string;
  /** Project root directory (relative paths resolved against workspaceDir) */
  workingDir: string;
  /** Bound chat — agent output goes here */
  chatId: string;
  /** Model tier for the project-bound agent (default: uses global default) */
  modelTier?: 'high' | 'low' | 'multimodal';
  /** Agent idle timeout in milliseconds (default: 30min = 1800000) */
  idleTimeoutMs?: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a ProjectManager instance.
 *
 * @see Issue #3519 (simplified /project command)
 * @see Issue #3332 (project configs from config file)
 */
export interface ProjectManagerOptions {
  /** Workspace root directory (default working directory when no binding exists) */
  workspaceDir: string;
  /**
   * Pre-configured project definitions loaded from disclaude.config.yaml.
   *
   * When provided, ProjectManager auto-binds each project's chatId to its
   * workingDir at construction time. These bindings coexist with user-initiated
   * bindings from the `/project use` command.
   *
   * @see Issue #3332
   */
  projects?: ProjectConfig[];
}
