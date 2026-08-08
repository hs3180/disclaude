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
export type ProjectResult<T> = { ok: true; data: T } | { ok: false; error: string };

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
// CwdResolution
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Why the effective cwd differs from the bound target.
 *
 * - `unbound`: chat has no project binding → SDK uses the workspace dir.
 * - `bound`:   chat is bound to an existing directory → agent runs there.
 * - `bound-missing`: chat is bound but the directory does not exist → the
 *   agent silently falls back to the workspace (Issue #4448).
 */
export type CwdResolutionReason = 'unbound' | 'bound' | 'bound-missing';

/**
 * Structured result of resolving the effective cwd for a chat session.
 *
 * Returned by `ProjectManager.resolveCwd()`. `CwdProvider` only yields the cwd
 * (or `undefined`), so a bound-but-missing directory is indistinguishable from
 * "unbound" — the silent fallback to workspace went unnoticed (#4448).
 * `resolveCwd` returns the bound target, the effective cwd, and the reason, so
 * callers (e.g. `/project info`) can surface the mismatch instead of hiding it.
 *
 * @see ProjectManager.resolveCwd
 */
export interface CwdResolution {
  /** The cwd the agent will actually run in. `undefined` → SDK falls back to workspace. */
  effectiveCwd: string | undefined;
  /** The bound target working directory, or `undefined` when unbound. */
  boundWorkingDir: string | undefined;
  /** Why `effectiveCwd` differs from `boundWorkingDir`. */
  reason: CwdResolutionReason;
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
