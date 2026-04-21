#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner deterministic logic.
 *
 * Provides CLI actions for schedule prompts to manage PR scanning state.
 * All state is stored as JSON files in `.temp-chats/`.
 *
 * CLI Interface (--action mode):
 *   check-capacity   Count `state: reviewing` files, report availability
 *   list-candidates  List open PRs not yet tracked (requires gh CLI)
 *   create-state     Create a state file for a PR (+ add reviewing label)
 *   mark             Update the state field of an existing state file (+ label sync)
 *   status           List all tracked PRs grouped by state
 *
 * State file path: `.temp-chats/pr-{number}.json`
 * State file schema (design spec §3.1):
 *   {
 *     "prNumber": number,
 *     "chatId": string,
 *     "state": "reviewing" | "approved" | "closed",
 *     "createdAt": "ISO-8601Z",
 *     "updatedAt": "ISO-8601Z",
 *     "expiresAt": "ISO-8601Z (createdAt + 48h)",
 *     "disbandRequested": null
 *   }
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, I/O failure)
 *
 * @see Issue #2219 — scanner.ts base script skeleton
 * @see Issue #2220 — SCHEDULE.md + GitHub Label integration
 * @see Issue #2210 — PR Scanner v2 parent issue
 */

import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ---- Types ----

export type PRState = 'reviewing' | 'approved' | 'closed';

export interface PRStateFile {
  prNumber: number;
  chatId: string;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null;
}

export interface CheckCapacityResult {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

export interface ListCandidatesResult {
  candidates: Array<{ number: number; title: string }>;
}

export interface StatusGroup {
  reviewing: number[];
  approved: number[];
  closed: number[];
}

// ---- Constants ----

export const STATE_DIR = '.temp-chats';
export const MAX_CONCURRENT = 3;
export const EXPIRY_HOURS = 48;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const VALID_STATES: readonly PRState[] = ['reviewing', 'approved', 'closed'] as const;
export const REVIEWING_LABEL = 'pr-scanner:reviewing';

// ---- Helpers (exported for testing) ----

/** Strip milliseconds from ISO timestamp to produce Z-suffix format without ms */
function stripMs(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/** Get current UTC timestamp in ISO 8601 Z-suffix format (no milliseconds) */
export function nowISO(): string {
  return stripMs(new Date().toISOString());
}

/** Calculate expiresAt = createdAt + EXPIRY_HOURS */
export function calcExpiry(createdAt: string): string {
  const dt = new Date(createdAt);
  dt.setUTCHours(dt.getUTCHours() + EXPIRY_HOURS);
  return stripMs(dt.toISOString());
}

/** Get the state file path for a given PR number */
export function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

/** Validate a PR state value */
export function isValidState(state: string): state is PRState {
  return VALID_STATES.includes(state as PRState);
}

/** Validate a PR number (positive integer) */
export function isValidPRNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Atomic file write: write to temp file then rename */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Ensure the state directory exists */
export async function ensureStateDir(): Promise<string> {
  const dir = resolve(STATE_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---- GitHub Label Management (#2220) ----

const execFileAsync = promisify(execFile);

/**
 * Add the reviewing label to a PR.
 * Label failures are logged but do NOT throw — they must not block the main flow.
 */
export async function addReviewingLabel(
  prNumber: number,
  repo: string = 'hs3180/disclaude',
): Promise<void> {
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', repo,
      '--add-label', REVIEWING_LABEL,
    ], { timeout: 15_000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to add label '${REVIEWING_LABEL}' to PR #${prNumber}: ${msg}`);
  }
}

/**
 * Remove the reviewing label from a PR.
 * Label failures are logged but do NOT throw — they must not block the main flow.
 */
export async function removeReviewingLabel(
  prNumber: number,
  repo: string = 'hs3180/disclaude',
): Promise<void> {
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', repo,
      '--remove-label', REVIEWING_LABEL,
    ], { timeout: 15_000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to remove label '${REVIEWING_LABEL}' from PR #${prNumber}: ${msg}`);
  }
}

// ---- State File Operations (exported for testing) ----

/** Create a new PR state file */
export async function createStateFile(
  prNumber: number,
  chatId: string,
  repo?: string,
): Promise<PRStateFile> {
  if (!isValidPRNumber(prNumber)) {
    throw new Error(`Invalid PR number: ${prNumber} (must be positive integer)`);
  }
  if (!chatId || typeof chatId !== 'string') {
    throw new Error(`Invalid chatId: ${chatId} (must be non-empty string)`);
  }

  const now = nowISO();
  const stateFile: PRStateFile = {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: calcExpiry(now),
    disbandRequested: null,
  };

  const filePath = stateFilePath(prNumber);

  // Check if file already exists
  try {
    await stat(filePath);
    throw new Error(`State file for PR #${prNumber} already exists`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    // File doesn't exist, proceed
  }

  await ensureStateDir();
  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');

  // Add reviewing label (non-blocking, per #2220 spec)
  await addReviewingLabel(prNumber, repo);

  return stateFile;
}

/** Read and parse a PR state file */
export async function readStateFile(prNumber: number): Promise<PRStateFile> {
  const filePath = stateFilePath(prNumber);
  const content = await readFile(filePath, 'utf-8');
  return parseStateFile(content, filePath);
}

/** Parse and validate a state file JSON string */
export function parseStateFile(json: string, filePath: string): PRStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`State file '${filePath}' is not valid JSON`);
  }
  return validateStateFile(data, filePath);
}

/** Validate state file structure */
export function validateStateFile(data: unknown, filePath: string): PRStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`State file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  if (!isValidPRNumber(obj.prNumber)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }
  if (typeof obj.chatId !== 'string' || !obj.chatId) {
    throw new Error(`State file '${filePath}' has invalid or missing 'chatId'`);
  }
  if (!isValidState(obj.state as string)) {
    throw new Error(
      `State file '${filePath}' has invalid 'state': '${obj.state}' (must be reviewing|approved|closed)`,
    );
  }
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'createdAt'`);
  }
  if (typeof obj.updatedAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.updatedAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'updatedAt'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'expiresAt'`);
  }
  if (obj.disbandRequested !== null) {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested' (must be null in Phase 1)`);
  }

  return data as PRStateFile;
}

/** Update the state of a PR state file */
export async function markState(
  prNumber: number,
  newState: PRState,
  repo?: string,
): Promise<PRStateFile> {
  if (!isValidPRNumber(prNumber)) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  if (!isValidState(newState)) {
    throw new Error(`Invalid state: ${newState}`);
  }

  const filePath = stateFilePath(prNumber);
  const current = await readStateFile(prNumber);

  const updated: PRStateFile = {
    ...current,
    state: newState,
    updatedAt: nowISO(),
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');

  // Sync label: remove reviewing label when leaving reviewing state
  if (current.state === 'reviewing' && newState !== 'reviewing') {
    await removeReviewingLabel(prNumber, repo);
  }

  return updated;
}

/** List all state files, grouped by state */
export async function getAllStates(): Promise<StatusGroup> {
  const result: StatusGroup = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  const dir = resolve(STATE_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // Directory doesn't exist, return empty
    return result;
  }

  const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = resolve(dir, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      const stateFile = parseStateFile(content, filePath);
      result[stateFile.state].push(stateFile.prNumber);
    } catch {
      // Skip corrupted files
      console.error(`WARN: Skipping corrupted state file: ${filePath}`);
    }
  }

  return result;
}

/** Count PRs currently in reviewing state */
export async function countReviewing(): Promise<CheckCapacityResult> {
  const all = await getAllStates();
  return {
    reviewing: all.reviewing.length,
    maxConcurrent: MAX_CONCURRENT,
    available: Math.max(0, MAX_CONCURRENT - all.reviewing.length),
  };
}

// ---- CLI Actions ----

/** List candidate PRs (open PRs not yet tracked) */
export async function listCandidates(
  repo: string = 'hs3180/disclaude',
): Promise<ListCandidatesResult> {
  // Get open PRs from GitHub
  let ghOutput: string;
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'list',
      '--repo', repo,
      '--state', 'open',
      '--json', 'number,title',
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    ghOutput = stdout;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list PRs from GitHub: ${errMsg}`);
  }

  let prs: Array<{ number: number; title: string }>;
  try {
    prs = JSON.parse(ghOutput);
  } catch {
    throw new Error(`Failed to parse gh pr list output: ${ghOutput.substring(0, 200)}`);
  }

  if (!Array.isArray(prs)) {
    throw new Error(`Unexpected gh pr list output format`);
  }

  // Filter out PRs that already have state files
  const candidates: Array<{ number: number; title: string }> = [];
  for (const pr of prs) {
    const filePath = stateFilePath(pr.number);
    try {
      await stat(filePath);
      // File exists, skip this PR
    } catch {
      // File doesn't exist, this PR is a candidate
      candidates.push(pr);
    }
  }

  return { candidates };
}

/** Format status as human-readable text */
export function formatStatus(groups: StatusGroup): string {
  const lines: string[] = ['PR Scanner Status:', ''];

  const formatGroup = (label: string, prs: number[]): string => {
    if (prs.length === 0) return `  ${label}: (none)`;
    return `  ${label}: ${prs.sort((a, b) => a - b).join(', ')}`;
  };

  lines.push(formatGroup('Reviewing', groups.reviewing));
  lines.push(formatGroup('Approved', groups.approved));
  lines.push(formatGroup('Closed', groups.closed));
  lines.push('');
  lines.push(`  Total: ${groups.reviewing.length + groups.approved.length + groups.closed.length} tracked PR(s)`);

  return lines.join('\n');
}

// ---- CLI Entry Point ----

function exitWithError(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function printUsage(): never {
  console.log(`Usage: scanner.ts --action <action> [options]

Actions:
  check-capacity           Count reviewing PRs, report availability
  list-candidates          List open PRs not yet tracked
  create-state             Create state file for a PR (+ add reviewing label)
    --pr <number>            PR number (required)
    --chat-id <string>       Chat ID (required)
  mark                     Update state of a PR (+ sync label)
    --pr <number>            PR number (required)
    --state <state>          New state: reviewing|approved|closed (required)
  status                   List all tracked PRs grouped by state

Options:
  --repo <repo>            GitHub repo (default: hs3180/disclaude)

Environment:
  MAX_CONCURRENT           Max concurrent reviewing PRs (default: 3)
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse arguments
  let action = '';
  let prNumber: number | undefined;
  let chatId = '';
  let newState: string = '';
  let repo = 'hs3180/disclaude';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--action':
        action = args[++i] ?? '';
        break;
      case '--pr': {
        const val = args[++i];
        prNumber = parseInt(val ?? '', 10);
        break;
      }
      case '--chat-id':
        chatId = args[++i] ?? '';
        break;
      case '--state':
        newState = args[++i] ?? '';
        break;
      case '--repo':
        repo = args[++i] ?? '';
        break;
      case '--help':
      case '-h':
        printUsage();
        break;
    }
  }

  if (!action) {
    exitWithError('Missing required argument: --action <action>. Use --help for usage.');
  }

  switch (action) {
    case 'check-capacity': {
      const result = await countReviewing();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'list-candidates': {
      const result = await listCandidates(repo);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'create-state': {
      if (!prNumber || !Number.isFinite(prNumber)) {
        exitWithError('Missing or invalid --pr <number> for create-state');
      }
      if (!chatId) {
        exitWithError('Missing --chat-id <string> for create-state');
      }
      const result = await createStateFile(prNumber, chatId, repo);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'mark': {
      if (!prNumber || !Number.isFinite(prNumber)) {
        exitWithError('Missing or invalid --pr <number> for mark');
      }
      if (!newState || !isValidState(newState)) {
        exitWithError(`Missing or invalid --state for mark (must be: ${VALID_STATES.join('|')})`);
      }
      const result = await markState(prNumber, newState as PRState, repo);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'status': {
      const groups = await getAllStates();
      console.log(formatStatus(groups));
      break;
    }

    default:
      exitWithError(`Unknown action: '${action}'. Valid actions: check-capacity, list-candidates, create-state, mark, status`);
  }
}

// Only run CLI when executed directly (not when imported by tests)
const isDirectRun = (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.url.replace('file://', ''))
);

if (isDirectRun) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
