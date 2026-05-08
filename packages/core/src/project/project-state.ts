/**
 * Project state persistence — per-project operational state file.
 *
 * Each project maintains state in its directory via a JSON file.
 * The ChatAgent reads/writes this via standard file tools (Read/Write).
 * No special persistence API needed — "State as files".
 *
 * File location: `{project.workingDir}/.disclaude/project-state.json`
 *
 * @see Issue #3335 (Project state persistence and admin commands)
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectResult } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Type Definitions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Issue triage entry in project state.
 */
export interface IssueStateEntry {
  /** Issue title */
  title: string;
  /** Issue state (open/closed) */
  state: string;
  /** Triage status */
  triageStatus?: string;
  /** Labels */
  labels?: string[];
}

/**
 * PR tracking entry in project state.
 */
export interface PrStateEntry {
  /** PR title */
  title: string;
  /** Associated issue number */
  issueNumber?: number;
  /** Review status */
  reviewStatus?: string;
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
 * Project state file schema.
 *
 * Stored at `{project.workingDir}/.disclaude/project-state.json`.
 * Designed to be human-readable, agent-native, and debuggable.
 *
 * Design principle: State as files. The ChatAgent reads/writes this
 * via standard file tools (Read/Write). No special persistence API needed.
 */
export interface ProjectState {
  /** Schema version */
  version: number;
  /** Project key (e.g. "hs3180/disclaude") */
  projectKey: string;
  /** Last active timestamp (ISO 8601) */
  lastActive: string;
  /** Sync timestamps */
  sync?: ProjectSyncState;
  /** Tracked issues (key = issue number as string) */
  issues?: Record<string, IssueStateEntry>;
  /** Tracked PRs (key = PR number as string) */
  prs?: Record<string, PrStateEntry>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Current schema version */
const STATE_VERSION = 1;

/** Default sync timestamps */
const EMPTY_SYNC: ProjectSyncState = {};

/** Default issues map */
const EMPTY_ISSUES: Record<string, IssueStateEntry> = {};

/** Default PRs map */
const EMPTY_PRS: Record<string, PrStateEntry> = {};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectStateStore
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages per-project state persistence.
 *
 * Each project has its own state file at `{workingDir}/.disclaude/project-state.json`.
 * Uses atomic write-then-rename pattern to prevent corruption.
 *
 * Lifecycle:
 * 1. Construct with project's working directory
 * 2. Call `load()` to read existing state (or get default state)
 * 3. Use `get()`, `update()` to read/write state
 * 4. Each mutation auto-persists to disk
 *
 * Conflict resolution: Last-write-wins (acceptable for single-agent-per-project model).
 */
export class ProjectStateStore {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly stateTmpPath: string;
  private state: ProjectState | null = null;

  /**
   * @param _workingDir - Project's working directory (reserved for future use)
   * @param projectKey - Project key (e.g. "hs3180/disclaude")
   */
  constructor(
    _workingDir: string,
    private readonly projectKey: string,
  ) {
    this.dataDir = join(_workingDir, '.disclaude');
    this.statePath = join(this.dataDir, 'project-state.json');
    this.stateTmpPath = join(this.dataDir, 'project-state.json.tmp');
  }

  /**
   * Load state from disk, or create default if not found.
   *
   * Corrupted files are handled gracefully — returns default state.
   */
  load(): ProjectResult<ProjectState> {
    if (!existsSync(this.statePath)) {
      // First run — return default state
      this.state = this.createDefaultState();
      return { ok: true, data: this.state };
    }

    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validateSchema(data)) {
        this.state = this.createDefaultState();
        return { ok: true, data: this.state };
      }

      this.state = data as ProjectState;
      return { ok: true, data: this.state };
    } catch (err) {
      this.state = this.createDefaultState();
      return {
        ok: false,
        error: `读取 project-state.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get current state (loads from disk if not yet loaded).
   */
  get(): ProjectResult<ProjectState> {
    if (this.state) {
      return { ok: true, data: this.state };
    }
    return this.load();
  }

  /**
   * Update state and persist to disk.
   *
   * Uses atomic write-then-rename pattern.
   * Updates `lastActive` timestamp automatically.
   *
   * @param updater - Function that receives current state and returns updated state
   */
  update(updater: (state: ProjectState) => ProjectState): ProjectResult<ProjectState> {
    const currentResult = this.get();
    if (!currentResult.ok) {
      return currentResult;
    }

    const updated = updater(currentResult.data);
    updated.lastActive = new Date().toISOString();

    const persistResult = this.writeToDisk(updated);
    if (!persistResult.ok) {
      return { ok: false, error: persistResult.error };
    }

    this.state = updated;
    return { ok: true, data: updated };
  }

  /**
   * Update the last active timestamp and persist.
   */
  touch(): ProjectResult<ProjectState> {
    return this.update((state) => state);
  }

  /**
   * Get the state file path (for debugging/testing).
   */
  getStatePath(): string {
    return this.statePath;
  }

  // ───────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────

  /**
   * Create default state for a new project.
   */
  private createDefaultState(): ProjectState {
    return {
      version: STATE_VERSION,
      projectKey: this.projectKey,
      lastActive: new Date().toISOString(),
      sync: { ...EMPTY_SYNC },
      issues: { ...EMPTY_ISSUES },
      prs: { ...EMPTY_PRS },
    };
  }

  /**
   * Validate top-level schema of state data.
   */
  private validateSchema(data: unknown): data is ProjectState {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (typeof obj.version !== 'number') {return false;}
    if (typeof obj.projectKey !== 'string') {return false;}
    if (typeof obj.lastActive !== 'string') {return false;}
    return true;
  }

  /**
   * Write state to disk using atomic write-then-rename pattern.
   */
  private writeToDisk(state: ProjectState): ProjectResult<void> {
    try {
      // Ensure .disclaude/ directory exists
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const json = JSON.stringify(state, null, 2);
      writeFileSync(this.stateTmpPath, json, 'utf8');

      try {
        renameSync(this.stateTmpPath, this.statePath);
      } catch (renameErr) {
        // Clean up .tmp file if rename fails
        try {
          unlinkSync(this.stateTmpPath);
        } catch {
          // Ignore cleanup failure
        }
        return {
          ok: false,
          error: `状态写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `状态持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
