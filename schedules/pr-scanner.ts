#!/usr/bin/env tsx
/**
 * schedules/pr-scanner.ts — PR Scanner state management CLI.
 *
 * Provides deterministic logic for tracking PR review state in `.temp-chats/`
 * state files. Designed for Schedule Prompt invocation via `--action` flags.
 *
 * State file schema (§3.1):
 *   .temp-chats/pr-{number}.json
 *   {
 *     "prNumber": number,
 *     "chatId": string | null,
 *     "state": "reviewing" | "approved" | "closed",
 *     "createdAt": string,       // ISO 8601 Z-suffix
 *     "updatedAt": string,       // ISO 8601 Z-suffix
 *     "expiresAt": string,       // createdAt + 48h
 *     "disbandRequested": null   // Phase 2 placeholder
 *   }
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, I/O failure)
 *
 * GitHub Label management:
 *   create-state → add `pr-scanner:reviewing` label (best-effort)
 *   mark (away from reviewing) → remove `pr-scanner:reviewing` label (best-effort)
 *   Label failures are logged but never block the main flow.
 *
 * Related: #2219, #2220, #2210
 */

import { readdir, readFile, writeFile, mkdir, stat, realpath, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UTC_DATETIME_REGEX } from '../skills/chat/schema.js';
import { acquireLock } from '../skills/chat/lock.js';

const execFileAsync = promisify(execFile);

// ---- Types ----

export type PrState = 'reviewing' | 'approved' | 'closed';

export interface PrStateFile {
  prNumber: number;
  chatId: string | null;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null;
}

export interface CapacityInfo {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

export interface GhPrItem {
  number: number;
  title: string;
}

// ---- Constants ----

const STATE_DIR = '.temp-chats';
const STATE_FILE_REGEX = /^pr-(\d+)\.json$/;
const VALID_STATES: readonly PrState[] = ['reviewing', 'approved', 'closed'] as const;
const EXPIRY_HOURS = 48;
const GH_TIMEOUT_MS = 30_000;

/** Maximum concurrent reviewing PRs (configurable via env) */
const DEFAULT_MAX_CONCURRENT = 2;
const REVIEWING_LABEL = 'pr-scanner:reviewing';

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Current UTC timestamp in ISO 8601 Z-suffix format WITHOUT milliseconds.
 *
 * `new Date().toISOString()` returns `"2026-04-23T21:21:10.414Z"` (with ms),
 * but `UTC_DATETIME_REGEX` expects `"2026-04-23T21:21:10Z"` (no ms).
 * Strip the milliseconds portion to ensure consistency with the schema.
 */
function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

function add48h(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  date.setUTCHours(date.getUTCHours() + EXPIRY_HOURS);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isValidState(value: unknown): value is PrState {
  return typeof value === 'string' && (VALID_STATES as readonly string[]).includes(value);
}

/** Parse and validate a PR state file from JSON string */
export function parseStateFile(json: string, filePath: string): PrStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`State file '${filePath}' is not valid JSON`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`State file '${filePath}' is not a valid JSON object`);
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  if (!isValidState(obj.state)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}' (must be one of: ${VALID_STATES.join(', ')})`);
  }

  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
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

  return data as PrStateFile;
}

/** Atomic file write: write to temp file then rename */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Ensure state directory exists */
async function ensureStateDir(): Promise<string> {
  const dir = resolve(STATE_DIR);
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) {
      exit(`State path '${dir}' exists but is not a directory`);
    }
  } catch {
    await mkdir(dir, { recursive: true });
  }
  return realpath(await stat(dir).then(() => dir));
}

/** Read all valid state files from the state directory */
export async function readAllStates(): Promise<PrStateFile[]> {
  const dir = resolve(STATE_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const results: PrStateFile[] = [];
  for (const fileName of files) {
    const match = STATE_FILE_REGEX.exec(fileName);
    if (!match) continue;

    const filePath = resolve(dir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      console.error(`WARN: Could not read state file '${filePath}', skipping`);
      continue;
    }

    try {
      results.push(parseStateFile(content, filePath));
    } catch (err) {
      console.error(`WARN: Skipping corrupted state file '${filePath}': ${err instanceof Error ? err.message : err}`);
    }
  }
  return results;
}

/** Run gh pr list and return parsed JSON */
async function ghPrList(repo: string): Promise<GhPrItem[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'gh',
      ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,title'],
      { timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh pr list failed: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('gh pr list returned invalid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('gh pr list returned non-array JSON');
  }

  return parsed as GhPrItem[];
}

/**
 * Add a GitHub label to a PR (best-effort).
 * Failures are logged to stderr but never throw or block the caller.
 */
async function ghAddLabel(repo: string, prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync(
      'gh',
      ['pr', 'edit', String(prNumber), '--repo', repo, '--add-label', label],
      { timeout: GH_TIMEOUT_MS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to add label '${label}' to PR #${prNumber}: ${msg}`);
  }
}

/**
 * Remove a GitHub label from a PR (best-effort).
 * Failures are logged to stderr but never throw or block the caller.
 */
async function ghRemoveLabel(repo: string, prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync(
      'gh',
      ['pr', 'edit', String(prNumber), '--repo', repo, '--remove-label', label],
      { timeout: GH_TIMEOUT_MS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to remove label '${label}' from PR #${prNumber}: ${msg}`);
  }
}

// ---- Actions ----

/** check-capacity: count reviewing state files */
async function actionCheckCapacity(): Promise<void> {
  const states = await readAllStates();
  const reviewing = states.filter((s) => s.state === 'reviewing').length;
  const maxConcurrent = parseInt(process.env.PR_SCANNER_MAX_CONCURRENT ?? String(DEFAULT_MAX_CONCURRENT), 10);
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 0) {
    exit(`Invalid PR_SCANNER_MAX_CONCURRENT value`);
  }

  const result: CapacityInfo = {
    reviewing,
    maxConcurrent,
    available: Math.max(0, maxConcurrent - reviewing),
  };
  console.log(JSON.stringify(result, null, 2));
}

/** list-candidates: list open PRs not yet tracked */
async function actionListCandidates(): Promise<void> {
  const repo = process.env.PR_SCANNER_REPO;
  if (!repo) {
    exit('PR_SCANNER_REPO environment variable is required for list-candidates');
  }

  const prs = await ghPrList(repo);
  const states = await readAllStates();
  const trackedNumbers = new Set(states.map((s) => s.prNumber));

  const candidates = prs.filter((pr) => !trackedNumbers.has(pr.number));
  console.log(JSON.stringify(candidates, null, 2));
}

/** create-state: create a new state file for a PR */
async function actionCreateState(prNumber: number): Promise<void> {
  await ensureStateDir();
  const filePath = stateFilePath(prNumber);

  // Check if state file already exists
  try {
    await stat(filePath);
    exit(`State file for PR #${prNumber} already exists at '${filePath}'`);
  } catch {
    // File doesn't exist, proceed
  }

  const now = nowISO();
  const stateFile: PrStateFile = {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: add48h(now),
    disbandRequested: null,
  };

  const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);
  try {
    // Re-check under lock
    try {
      await stat(filePath);
      exit(`State file for PR #${prNumber} was created concurrently at '${filePath}'`);
    } catch {
      // Still doesn't exist
    }
    await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
    console.log(JSON.stringify(stateFile, null, 2));

    // Best-effort: add reviewing label on GitHub
    const repo = process.env.PR_SCANNER_REPO;
    if (repo) {
      await ghAddLabel(repo, prNumber, REVIEWING_LABEL);
    }
  } finally {
    await lock.release();
  }
}

/** mark: update state field in a state file */
async function actionMark(prNumber: number, newState: PrState): Promise<void> {
  const filePath = stateFilePath(prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    exit(`State file for PR #${prNumber} not found at '${filePath}'`);
  }

  let stateFile: PrStateFile;
  try {
    stateFile = parseStateFile(content, filePath);
  } catch (err) {
    exit(`Corrupted state file '${filePath}': ${err instanceof Error ? err.message : err}`);
  }

  if (stateFile.state === newState) {
    console.log(JSON.stringify(stateFile, null, 2));
    return;
  }

  stateFile.state = newState;
  stateFile.updatedAt = nowISO();

  const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);
  try {
    // Re-read under lock to avoid lost updates
    let currentContent: string;
    try {
      currentContent = await readFile(filePath, 'utf-8');
    } catch {
      exit(`State file disappeared during mark: '${filePath}'`);
    }

    const currentState = parseStateFile(currentContent, filePath);
    const previousState = currentState.state;
    currentState.state = newState;
    currentState.updatedAt = nowISO();

    await atomicWrite(filePath, JSON.stringify(currentState, null, 2) + '\n');
    console.log(JSON.stringify(currentState, null, 2));

    // Best-effort: remove reviewing label when leaving reviewing state
    if (previousState === 'reviewing' && newState !== 'reviewing') {
      const repo = process.env.PR_SCANNER_REPO;
      if (repo) {
        await ghRemoveLabel(repo, prNumber, REVIEWING_LABEL);
      }
    }
  } finally {
    await lock.release();
  }
}

/** status: list all tracked PRs grouped by state */
async function actionStatus(): Promise<void> {
  const states = await readAllStates();

  if (states.length === 0) {
    console.log('No tracked PRs found.');
    return;
  }

  const grouped: Record<string, PrStateFile[]> = {};
  for (const state of VALID_STATES) {
    grouped[state] = [];
  }

  for (const s of states) {
    grouped[s.state].push(s);
  }

  for (const state of VALID_STATES) {
    const items = grouped[state];
    if (items.length === 0) continue;

    console.log(`\n## ${state.toUpperCase()} (${items.length})`);
    for (const item of items) {
      console.log(`  PR #${item.prNumber} | updated: ${item.updatedAt} | expires: ${item.expiresAt}`);
    }
  }

  console.log(`\nTotal: ${states.length} tracked PR(s)`);
}

// ---- CLI argument parsing ----

function parseArgs(args: string[]): { action: string; pr?: number; state?: string } {
  let action = '';
  let pr: number | undefined;
  let state: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--action':
        action = args[++i];
        break;
      case '--pr':
        pr = parseInt(args[++i], 10);
        if (!Number.isFinite(pr) || pr <= 0) {
          exit(`Invalid --pr value: '${args[i]}' (must be positive integer)`);
        }
        break;
      case '--state':
        state = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`Usage: pr-scanner.ts --action <action> [--pr <number>] [--state <state>]

Actions:
  check-capacity   Count reviewing state files, output JSON
  list-candidates  List open PRs not yet tracked (requires PR_SCANNER_REPO env)
  create-state     Create state file for a PR (requires --pr)
                   Also adds 'pr-scanner:reviewing' GitHub label (best-effort)
  mark             Update state field (requires --pr and --state)
                   Removes 'pr-scanner:reviewing' label when leaving reviewing (best-effort)
  status           List all tracked PRs grouped by state

Options:
  --pr <number>    PR number (required for create-state, mark)
  --state <state>  New state: reviewing, approved, closed (required for mark)

Environment:
  PR_SCANNER_MAX_CONCURRENT  Max concurrent reviewing PRs (default: 2)
  PR_SCANNER_REPO            GitHub repo for list-candidates and label ops (e.g. owner/repo)`);
        process.exit(0);
        break;
      default:
        exit(`Unknown argument: '${arg}'. Use --help for usage.`);
    }
  }

  return { action, pr, state };
}

// ---- Main ----

async function main() {
  const { action, pr, state } = parseArgs(process.argv.slice(2));

  if (!action) {
    exit('Missing required --action flag. Use --help for usage.');
  }

  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity();
      break;
    case 'list-candidates':
      await actionListCandidates();
      break;
    case 'create-state':
      if (!pr) exit('--pr is required for create-state action');
      await actionCreateState(pr);
      break;
    case 'mark':
      if (!pr) exit('--pr is required for mark action');
      if (!state) exit('--state is required for mark action');
      if (!isValidState(state)) exit(`Invalid state '${state}'. Must be one of: ${VALID_STATES.join(', ')}`);
      await actionMark(pr, state);
      break;
    case 'status':
      await actionStatus();
      break;
    default:
      exit(`Unknown action '${action}'. Valid actions: check-capacity, list-candidates, create-state, mark, status`);
  }
}

// Only run main() when executed as a script, not when imported for testing
const isMainModule =
  process.argv[1] &&
  (process.argv[1].includes('pr-scanner.ts') || process.argv[1].includes('pr-scanner.js'));

if (isMainModule) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
