/**
 * Project state persistence and management.
 *
 * Implements lightweight file-based project state persistence for
 * project-bound agents. State is stored as JSON files in each project's
 * working directory, managed via standard file tools.
 *
 * Design principle: State as files. The ChatAgent reads/writes state via
 * standard file tools (Read/Write). No special persistence API needed.
 *
 * @see Issue #3335 (Phase 5: Project state persistence and admin commands)
 * @see Issue #3329 (RFC: NonUserMessage — System-Driven Task Pipeline)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectResult } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// State Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Triage status for an issue within a project.
 */
export type IssueTriageStatus = 'untriaged' | 'triaged' | 'in-progress' | 'resolved';

/**
 * Issue state tracked within a project.
 */
export interface ProjectIssueState {
  /** Issue title */
  title: string;
  /** Issue state (open/closed) */
  state: string;
  /** Triage status */
  triageStatus: IssueTriageStatus;
  /** Labels on the issue */
  labels: string[];
}

/**
 * PR review status within a project.
 */
export type PrReviewStatus = 'pending' | 'approved' | 'changes-requested' | 'merged' | 'closed';

/**
 * PR state tracked within a project.
 */
export interface ProjectPrState {
  /** PR title */
  title: string;
  /** Associated issue number */
  issueNumber?: number;
  /** Review status */
  reviewStatus: PrReviewStatus;
}

/**
 * Sync timestamps for project state.
 */
export interface ProjectSyncState {
  /** Last sync timestamp for issues */
  issues?: string;
  /** Last sync timestamp for PRs */
  prs?: string;
}

/**
 * Full project state schema.
 *
 * Stored at `{project}/.disclaude/project-state.json`.
 *
 * Uses write-then-rename pattern for atomic writes.
 * Last-write-wins for conflict resolution (acceptable for single-agent-per-project model).
 */
export interface ProjectState {
  /** Schema version for future migrations */
  version: 1;

  /** Project key (e.g. "hs3180/disclaude") */
  projectKey: string;

  /** Last activity timestamp (ISO 8601) */
  lastActive: string;

  /** Sync timestamps for various data sources */
  sync: ProjectSyncState;

  /** Tracked issues keyed by issue number */
  issues: Record<string, ProjectIssueState>;

  /** Tracked PRs keyed by PR number */
  prs: Record<string, ProjectPrState>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// State File Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Default filename for project state */
export const PROJECT_STATE_FILENAME = 'project-state.json';

/**
 * Resolve the path to the project state file.
 *
 * @param projectDir - The project's working directory
 * @returns Path to project-state.json
 */
export function resolveStatePath(projectDir: string): string {
  return join(projectDir, '.disclaude', PROJECT_STATE_FILENAME);
}

/**
 * Create an empty project state with defaults.
 *
 * @param projectKey - The project key (e.g. "owner/repo")
 * @returns A new ProjectState with empty collections
 */
export function createEmptyState(projectKey: string): ProjectState {
  return {
    version: 1,
    projectKey,
    lastActive: new Date().toISOString(),
    sync: {},
    issues: {},
    prs: {},
  };
}

/**
 * Read project state from disk.
 *
 * Returns a default empty state if the file doesn't exist.
 * Returns an error if the file exists but cannot be parsed.
 *
 * @param projectDir - The project's working directory
 * @returns ProjectResult with ProjectState on success
 */
export function readProjectState(projectDir: string): ProjectResult<ProjectState> {
  const statePath = resolveStatePath(projectDir);

  if (!existsSync(statePath)) {
    // No state file — return empty state (first access for this project)
    return { ok: true, data: createEmptyState('') };
  }

  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (!isValidProjectState(parsed)) {
      return { ok: false, error: 'project-state.json 格式无效' };
    }

    return { ok: true, data: parsed };
  } catch (err) {
    return {
      ok: false,
      error: `读取 project-state.json 失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Write project state to disk using atomic write-then-rename pattern.
 *
 * Creates the `.disclaude/` directory if it doesn't exist.
 *
 * @param projectDir - The project's working directory
 * @param state - The project state to persist
 * @returns ProjectResult indicating success or failure
 */
export function writeProjectState(projectDir: string, state: ProjectState): ProjectResult<void> {
  const statePath = resolveStatePath(projectDir);
  const stateDir = join(projectDir, '.disclaude');
  const tmpPath = `${statePath  }.tmp`;

  try {
    // Ensure .disclaude/ directory exists
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    // Update lastActive timestamp
    state.lastActive = new Date().toISOString();

    const json = JSON.stringify(state, null, 2);
    writeFileSync(tmpPath, json, 'utf8');

    // Atomic rename
    try {
      renameSync(tmpPath, statePath);
    } catch (renameErr) {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
      return {
        ok: false,
        error: `持久化写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
      };
    }

    return { ok: true, data: undefined };
  } catch (err) {
    return {
      ok: false,
      error: `持久化失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Update a specific part of the project state.
 *
 * Reads current state, applies the updater function, and writes back.
 * If no state file exists, creates a new one with the given projectKey.
 *
 * @param projectDir - The project's working directory
 * @param projectKey - The project key for creating new state
 * @param updater - Function to modify the state
 * @returns ProjectResult with the updated state
 */
export function updateProjectState(
  projectDir: string,
  projectKey: string,
  updater: (state: ProjectState) => void,
): ProjectResult<ProjectState> {
  // Read existing or create new
  const readResult = readProjectState(projectDir);
  if (!readResult.ok) {
    return readResult;
  }

  const state = readResult.data;
  if (!state.projectKey) {
    state.projectKey = projectKey;
  }

  // Apply updates
  updater(state);

  // Write back
  const writeResult = writeProjectState(projectDir, state);
  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error };
  }

  return { ok: true, data: state };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Validate that a parsed object conforms to ProjectState schema.
 *
 * Performs structural checks but does not deep-validate every field.
 * Designed to be defensive against corrupted files.
 *
 * @param data - Parsed JSON data to validate
 * @returns true if structurally valid
 */
export function isValidProjectState(data: unknown): data is ProjectState {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;

  // Version must be 1
  if (obj.version !== 1) {
    return false;
  }

  // projectKey must be a string
  if (typeof obj.projectKey !== 'string') {
    return false;
  }

  // lastActive must be a string
  if (typeof obj.lastActive !== 'string') {
    return false;
  }

  // sync must be an object or undefined
  if (obj.sync !== undefined && (typeof obj.sync !== 'object' || obj.sync === null)) {
    return false;
  }

  // issues must be an object or undefined
  if (obj.issues !== undefined && (typeof obj.issues !== 'object' || obj.issues === null || Array.isArray(obj.issues))) {
    return false;
  }

  // prs must be an object or undefined
  if (obj.prs !== undefined && (typeof obj.prs !== 'object' || obj.prs === null || Array.isArray(obj.prs))) {
    return false;
  }

  return true;
}

/**
 * Generate a human-readable summary of the project state.
 *
 * Used by the `/project status` command.
 *
 * @param state - The project state to summarize
 * @returns Markdown-formatted summary string
 */
export function formatStateSummary(state: ProjectState): string {
  const issueCount = Object.keys(state.issues).length;
  const prCount = Object.keys(state.prs).length;

  const lines: string[] = [
    `📁 **项目**: ${state.projectKey || '(未设置)'}`,
    `🕐 **最后活跃**: ${state.lastActive}`,
    `📋 **Issues**: ${issueCount} 个已跟踪`,
    `🔀 **PRs**: ${prCount} 个已跟踪`,
  ];

  if (state.sync.issues) {
    lines.push(`📡 **Issues 同步**: ${state.sync.issues}`);
  }
  if (state.sync.prs) {
    lines.push(`📡 **PRs 同步**: ${state.sync.prs}`);
  }

  return lines.join('\n');
}
