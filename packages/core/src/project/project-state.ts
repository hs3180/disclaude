/**
 * Project state file read/write utilities.
 *
 * Provides helpers for reading and writing `.disclaude/project-state.json`
 * in a project's working directory.
 *
 * The state file is a lightweight JSON document that ChatAgent reads/writes
 * via standard file tools. No special persistence API is needed — this module
 * provides convenience functions for programmatic access (e.g., admin commands).
 *
 * @see Issue #3335 (Project state persistence)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProjectState,
  ProjectStateSync,
  ProjectStateIssueEntry,
  ProjectStatePrEntry,
  IssueTriageStatus,
  PrReviewStatus,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Directory name for project state (relative to project working directory) */
export const STATE_DIR_NAME = '.disclaude';

/** File name for project state */
export const STATE_FILE_NAME = 'project-state.json';

/** Current schema version */
export const STATE_VERSION = 1;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Path Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Get the state directory path for a project.
 *
 * @param projectDir - Project working directory
 * @returns Path to `.disclaude/` directory
 */
export function getStateDir(projectDir: string): string {
  return join(projectDir, STATE_DIR_NAME);
}

/**
 * Get the state file path for a project.
 *
 * @param projectDir - Project working directory
 * @returns Path to `.disclaude/project-state.json`
 */
export function getStateFilePath(projectDir: string): string {
  return join(getStateDir(projectDir), STATE_FILE_NAME);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Default State Factory
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Create a default empty project state.
 *
 * @param projectKey - Project identifier (e.g., 'hs3180/disclaude')
 * @returns Initial ProjectState with empty issues/prs
 */
export function createDefaultState(projectKey: string): ProjectState {
  return {
    version: STATE_VERSION,
    projectKey,
    lastActive: new Date().toISOString(),
    sync: {},
    issues: {},
    prs: {},
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Read / Write
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Read project state from disk.
 *
 * Returns `null` if the state file doesn't exist or is corrupted.
 * Corrupted files are handled gracefully — doesn't throw.
 *
 * @param projectDir - Project working directory
 * @returns Parsed ProjectState, or null if not found/invalid
 */
export function readProjectState(projectDir: string): ProjectState | null {
  const filePath = getStateFilePath(projectDir);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as unknown;

    if (!isValidProjectState(data)) {
      return null;
    }

    return data;
  } catch {
    // Corrupted or unreadable file — return null gracefully
    return null;
  }
}

/**
 * Write project state to disk using atomic write-then-rename.
 *
 * Creates `.disclaude/` directory if it doesn't exist.
 * Uses write-then-rename pattern to prevent corruption on crash.
 *
 * @param projectDir - Project working directory
 * @param state - ProjectState to persist
 * @throws If write fails (caller should handle)
 */
export function writeProjectState(projectDir: string, state: ProjectState): void {
  const stateDir = getStateDir(projectDir);
  const filePath = getStateFilePath(projectDir);
  const tmpPath = `${filePath}.tmp`;

  // Ensure .disclaude/ directory exists
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  // Update lastActive timestamp
  state.lastActive = new Date().toISOString();

  // Atomic write: write to .tmp, then rename
  const json = JSON.stringify(state, null, 2);
  writeFileSync(tmpPath, json, 'utf8');

  try {
    renameSync(tmpPath, filePath);
  } catch (renameErr) {
    // Clean up .tmp file if rename fails
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw renameErr;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Mutation Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Update sync timestamps in project state.
 *
 * Reads current state, updates the specified sync field,
 * and writes back to disk.
 *
 * @param projectDir - Project working directory
 * @param field - Sync field to update ('issues' | 'prs')
 * @param projectKey - Project key (used if creating new state)
 * @returns Updated ProjectState, or null on error
 */
export function updateSyncTimestamp(
  projectDir: string,
  field: keyof ProjectStateSync,
  projectKey: string,
): ProjectState | null {
  const state = readProjectState(projectDir) ?? createDefaultState(projectKey);
  state.sync[field] = new Date().toISOString();

  try {
    writeProjectState(projectDir, state);
    return state;
  } catch {
    return null;
  }
}

/**
 * Update or add an issue entry in project state.
 *
 * @param projectDir - Project working directory
 * @param issueNumber - Issue number (as string key)
 * @param entry - Issue entry data
 * @param projectKey - Project key (used if creating new state)
 * @returns Updated ProjectState, or null on error
 */
export function upsertIssue(
  projectDir: string,
  issueNumber: string,
  entry: ProjectStateIssueEntry,
  projectKey: string,
): ProjectState | null {
  const state = readProjectState(projectDir) ?? createDefaultState(projectKey);
  state.issues[issueNumber] = entry;

  try {
    writeProjectState(projectDir, state);
    return state;
  } catch {
    return null;
  }
}

/**
 * Update or add a PR entry in project state.
 *
 * @param projectDir - Project working directory
 * @param prNumber - PR number (as string key)
 * @param entry - PR entry data
 * @param projectKey - Project key (used if creating new state)
 * @returns Updated ProjectState, or null on error
 */
export function upsertPr(
  projectDir: string,
  prNumber: string,
  entry: ProjectStatePrEntry,
  projectKey: string,
): ProjectState | null {
  const state = readProjectState(projectDir) ?? createDefaultState(projectKey);
  state.prs[prNumber] = entry;

  try {
    writeProjectState(projectDir, state);
    return state;
  } catch {
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Valid triage statuses */
const VALID_TRIAGE_STATUSES = new Set<IssueTriageStatus>([
  'untriaged', 'triaged', 'in-progress', 'resolved',
]);

/** Valid PR review statuses */
const VALID_REVIEW_STATUSES = new Set<PrReviewStatus>([
  'pending', 'approved', 'changes-requested', 'merged',
]);

/**
 * Validate a parsed object as ProjectState.
 *
 * Checks structural integrity without throwing.
 * Invalid entries within issues/prs are acceptable — only top-level
 * structure is validated.
 *
 * @param data - Parsed JSON data to validate
 * @returns true if structurally valid ProjectState
 */
export function isValidProjectState(data: unknown): data is ProjectState {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Required fields
  if (typeof obj.version !== 'number') {return false;}
  if (typeof obj.projectKey !== 'string') {return false;}
  if (typeof obj.lastActive !== 'string') {return false;}
  if (typeof obj.sync !== 'object' || obj.sync === null) {return false;}
  if (typeof obj.issues !== 'object' || obj.issues === null) {return false;}
  if (typeof obj.prs !== 'object' || obj.prs === null) {return false;}

  return true;
}

/**
 * Validate an issue entry.
 *
 * @param entry - Object to validate
 * @returns true if valid ProjectStateIssueEntry
 */
export function isValidIssueEntry(entry: unknown): entry is ProjectStateIssueEntry {
  if (typeof entry !== 'object' || entry === null) {return false;}
  const obj = entry as Record<string, unknown>;
  if (typeof obj.title !== 'string') {return false;}
  if (typeof obj.state !== 'string') {return false;}
  if (!VALID_TRIAGE_STATUSES.has(obj.triageStatus as IssueTriageStatus)) {return false;}
  if (!Array.isArray(obj.labels)) {return false;}
  return true;
}

/**
 * Validate a PR entry.
 *
 * @param entry - Object to validate
 * @returns true if valid ProjectStatePrEntry
 */
export function isValidPrEntry(entry: unknown): entry is ProjectStatePrEntry {
  if (typeof entry !== 'object' || entry === null) {return false;}
  const obj = entry as Record<string, unknown>;
  if (typeof obj.title !== 'string') {return false;}
  if (!VALID_REVIEW_STATUSES.has(obj.reviewStatus as PrReviewStatus)) {return false;}
  return true;
}
