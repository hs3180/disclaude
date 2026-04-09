#!/usr/bin/env tsx
/**
 * schedule/pr-scanner.ts — PR Scanner v2 state management + GitHub Label operations.
 *
 * Manages PR scanning state files (create, read, update) and provides GitHub Label
 * integration for the pr-scanner schedule. Designed for use by the SCHEDULE.md prompt.
 *
 * CLI Actions:
 *   check-capacity    Count reviewing PRs and report availability
 *   list-candidates   List open PRs not yet tracked (requires gh CLI)
 *   create-state      Create a state file for a PR (+ optional label)
 *   mark              Update the state of a tracked PR (+ optional label removal)
 *   add-label         Add a GitHub label to a PR (non-blocking)
 *   remove-label      Remove a GitHub label from a PR (non-blocking)
 *   status            List all tracked PRs grouped by state
 *
 * Environment variables (optional):
 *   PR_SCANNER_STATE_DIR       Directory for state files (default: .temp-chats)
 *   PR_SCANNER_MAX_REVIEWING   Max concurrent reviewing PRs (default: 3)
 *   PR_SCANNER_REPO            GitHub repo (default: hs3180/disclaude)
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error (invalid args, file not found, etc.)
 */

import { readdir, readFile, writeFile, stat, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Types ----

export type PRState = 'reviewing' | 'approved' | 'closed';

export interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null; // Phase 2 will use string | null
}

// ---- Constants ----

export const DEFAULT_MAX_REVIEWING = 3;
export const DEFAULT_STATE_DIR = '.temp-chats';
export const DEFAULT_REPO = 'hs3180/disclaude';
export const EXPIRY_HOURS = 48;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
export const REVIEWING_LABEL = 'pr-scanner:reviewing';

const VALID_STATES: PRState[] = ['reviewing', 'approved', 'closed'];

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function nowISO(): string {
  return new Date().toISOString();
}

function expiryISO(from: Date = new Date()): string {
  const expires = new Date(from.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
  return expires.toISOString();
}

function stateFilePath(dir: string, prNumber: number): string {
  return resolve(dir, `pr-${prNumber}.json`);
}

/**
 * Atomic file write: write to temp file then rename.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/**
 * Validate and parse a state file from JSON string.
 */
export function parseStateFile(json: string, filePath: string): PRStateFile {
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

  if (!isValidPRState(obj.state)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
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

  // chatId can be null or string
  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }

  // disbandRequested must be null in Phase 1
  if (obj.disbandRequested !== null) {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested' (must be null in Phase 1)`);
  }

  return data as PRStateFile;
}

function isValidPRState(value: unknown): value is PRState {
  return typeof value === 'string' && VALID_STATES.includes(value as PRState);
}

/**
 * Read all state files from the state directory.
 */
async function readAllStates(stateDir: string): Promise<PRStateFile[]> {
  const states: PRStateFile[] = [];

  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch {
    return states;
  }

  const jsonFiles = files.filter(f => f.startsWith('pr-') && f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = resolve(stateDir, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      const state = parseStateFile(content, filePath);
      states.push(state);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`WARN: Skipping corrupted state file '${fileName}': ${msg}`);
    }
  }

  return states;
}

/**
 * Parse CLI arguments into a structured object.
 */
export function parseArgs(argv: string[]): {
  action: string;
  pr: number | null;
  state: PRState | null;
  chatId: string | null;
  label: string | null;
} {
  const args = argv.slice(2); // skip node + script
  let action = '';
  let pr: number | null = null;
  let state: PRState | null = null;
  let chatId: string | null = null;
  let label: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--action':
        action = args[++i] ?? '';
        break;
      case '--pr':
        pr = parseInt(args[++i] ?? '', 10);
        if (!Number.isFinite(pr) || pr <= 0) {
          exit(`Invalid --pr value: must be a positive integer`);
        }
        break;
      case '--state':
        state = (args[++i] ?? '') as PRState;
        if (!isValidPRState(state)) {
          exit(`Invalid --state value: must be one of ${VALID_STATES.join(', ')}`);
        }
        break;
      case '--chat-id':
        chatId = args[++i] ?? '';
        if (!chatId) {
          exit(`Invalid --chat-id value: must be a non-empty string`);
        }
        break;
      case '--label':
        label = args[++i] ?? '';
        if (!label) {
          exit(`Invalid --label value: must be a non-empty string`);
        }
        break;
      default:
        if (!action) {
          // Support positional action: npx tsx scanner.ts status
          action = arg;
        } else {
          exit(`Unknown argument: ${arg}`);
        }
        break;
    }
  }

  return { action, pr, state, chatId, label };
}

// ---- GitHub Label Actions ----

/**
 * Add a GitHub label to a PR. Non-blocking: logs warning on failure.
 */
async function actionAddLabel(repo: string, prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', repo,
      '--add-label', label,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });

    console.log(JSON.stringify({ ok: true, prNumber, label, action: 'added' }));
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    console.error(`WARN: Failed to add label '${label}' to PR #${prNumber}: ${execErr.stderr ?? execErr.message ?? 'unknown error'}`);
    console.log(JSON.stringify({ ok: false, prNumber, label, action: 'added', error: execErr.stderr ?? execErr.message ?? 'unknown error' }));
    // Non-blocking: do not exit with error code
  }
}

/**
 * Remove a GitHub label from a PR. Non-blocking: logs warning on failure.
 */
async function actionRemoveLabel(repo: string, prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', repo,
      '--remove-label', label,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });

    console.log(JSON.stringify({ ok: true, prNumber, label, action: 'removed' }));
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    console.error(`WARN: Failed to remove label '${label}' from PR #${prNumber}: ${execErr.stderr ?? execErr.message ?? 'unknown error'}`);
    console.log(JSON.stringify({ ok: false, prNumber, label, action: 'removed', error: execErr.stderr ?? execErr.message ?? 'unknown error' }));
    // Non-blocking: do not exit with error code
  }
}

// ---- State Actions ----

/**
 * check-capacity: Count reviewing PRs and report availability.
 */
async function actionCheckCapacity(stateDir: string, maxReviewing: number): Promise<void> {
  const states = await readAllStates(stateDir);
  const reviewing = states.filter(s => s.state === 'reviewing').length;
  const available = Math.max(0, maxReviewing - reviewing);

  console.log(JSON.stringify({
    reviewing,
    maxConcurrent: maxReviewing,
    available,
  }));
}

/**
 * list-candidates: List open PRs not yet tracked (requires gh CLI).
 */
async function actionListCandidates(stateDir: string, repo: string): Promise<void> {
  // Get existing tracked PR numbers
  const states = await readAllStates(stateDir);
  const trackedNumbers = new Set(states.map(s => s.prNumber));

  // Get open PRs via gh CLI
  let stdout: string;
  try {
    const result = await execFileAsync('gh', [
      'pr', 'list', '--repo', repo, '--state', 'open',
      '--json', 'number,title,author,labels,updatedAt',
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    stdout = result.stdout;
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    exit(`gh pr list failed: ${execErr.stderr ?? execErr.message ?? 'unknown error'}`);
  }

  let prs: Array<{ number: number; title: string; author: string; labels: Array<{ name: string }>; updatedAt: string }>;
  try {
    prs = JSON.parse(stdout);
  } catch {
    exit('Failed to parse gh pr list output');
  }

  // Filter: exclude already tracked PRs and PRs with pr-scanner:processed label
  const candidates = prs.filter(pr => {
    if (trackedNumbers.has(pr.number)) return false;
    const hasProcessedLabel = pr.labels?.some(l => l.name === 'pr-scanner:processed');
    if (hasProcessedLabel) return false;
    return true;
  });

  // Sort by updatedAt ascending (oldest first = most stale)
  candidates.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

  console.log(JSON.stringify(candidates.map(pr => ({
    number: pr.number,
    title: pr.title,
    author: pr.author,
    labels: pr.labels?.map(l => l.name) ?? [],
    updatedAt: pr.updatedAt,
  }))));
}

/**
 * create-state: Create a state file for a given PR.
 * Optionally adds the reviewing label to the PR.
 */
async function actionCreateState(
  stateDir: string,
  prNumber: number,
  chatId: string | null,
  repo: string,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });

  const filePath = stateFilePath(stateDir, prNumber);

  // Check if file already exists
  try {
    await stat(filePath);
    exit(`State file for PR #${prNumber} already exists: ${filePath}`);
  } catch {
    // File doesn't exist — proceed
  }

  const now = new Date();
  const stateFile: PRStateFile = {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    expiresAt: expiryISO(now),
    disbandRequested: null,
  };

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2));

  console.log(JSON.stringify(stateFile, null, 2));

  // Add reviewing label (non-blocking)
  await actionAddLabel(repo, prNumber, REVIEWING_LABEL);
}

/**
 * mark: Update the state of a tracked PR.
 * Automatically removes reviewing label when transitioning away from reviewing.
 */
async function actionMark(
  stateDir: string,
  prNumber: number,
  newState: PRState,
  repo: string,
): Promise<void> {
  const filePath = stateFilePath(stateDir, prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    exit(`State file for PR #${prNumber} not found: ${filePath}`);
  }

  const stateFile = parseStateFile(content, filePath);

  const oldState = stateFile.state;
  stateFile.state = newState;
  stateFile.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2));

  console.log(JSON.stringify(stateFile, null, 2));

  // Remove reviewing label when leaving reviewing state (non-blocking)
  if (oldState === 'reviewing' && newState !== 'reviewing') {
    await actionRemoveLabel(repo, prNumber, REVIEWING_LABEL);
  }
}

/**
 * status: List all tracked PRs grouped by state.
 */
async function actionStatus(stateDir: string): Promise<void> {
  const states = await readAllStates(stateDir);

  if (states.length === 0) {
    console.log('No tracked PRs.');
    return;
  }

  // Group by state
  const grouped: Record<string, PRStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  for (const s of states) {
    if (!grouped[s.state]) grouped[s.state] = [];
    grouped[s.state].push(s);
  }

  // Sort each group by updatedAt (most recent first)
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  console.log(`=== PR Scanner Status ===`);
  console.log(`Total tracked: ${states.length}`);
  console.log('');

  for (const stateName of ['reviewing', 'approved', 'closed']) {
    const items = grouped[stateName] ?? [];
    const icon = stateName === 'reviewing' ? '🔍' : stateName === 'approved' ? '✅' : '❌';
    console.log(`${icon} ${stateName} (${items.length}):`);
    if (items.length === 0) {
      console.log(`  (none)`);
    } else {
      for (const item of items) {
        const age = formatAge(item.updatedAt);
        console.log(`  PR #${item.prNumber} — updated ${age}`);
      }
    }
    console.log('');
  }
}

function formatAge(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// ---- Main ----

async function main(): Promise<void> {
  const { action, pr, state, chatId, label } = parseArgs(process.argv);

  // Resolve configuration from environment
  const maxReviewing = parseInt(process.env.PR_SCANNER_MAX_REVIEWING ?? '', 10) || DEFAULT_MAX_REVIEWING;
  const stateDir = resolve(process.env.PR_SCANNER_STATE_DIR ?? DEFAULT_STATE_DIR);
  const repo = process.env.PR_SCANNER_REPO ?? DEFAULT_REPO;

  // Ensure state directory exists (for actions that need it)
  switch (action) {
    case 'check-capacity':
    case 'list-candidates':
    case 'create-state':
    case 'mark':
    case 'status':
      await mkdir(stateDir, { recursive: true });
      break;
  }

  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity(stateDir, maxReviewing);
      break;

    case 'list-candidates':
      await actionListCandidates(stateDir, repo);
      break;

    case 'create-state':
      if (pr === null) exit('--pr is required for create-state action');
      await actionCreateState(stateDir, pr, chatId, repo);
      break;

    case 'mark':
      if (pr === null) exit('--pr is required for mark action');
      if (state === null) exit('--state is required for mark action');
      await actionMark(stateDir, pr, state, repo);
      break;

    case 'add-label':
      if (pr === null) exit('--pr is required for add-label action');
      if (label === null) exit('--label is required for add-label action');
      await actionAddLabel(repo, pr, label);
      break;

    case 'remove-label':
      if (pr === null) exit('--pr is required for remove-label action');
      if (label === null) exit('--label is required for remove-label action');
      await actionRemoveLabel(repo, pr, label);
      break;

    case 'status':
      await actionStatus(stateDir);
      break;

    case '':
      exit('No action specified. Usage: scanner.ts <action> [--pr <number>] [--state <state>] [--chat-id <id>] [--label <label>]');

    default:
      exit(`Unknown action: '${action}'. Valid actions: check-capacity, list-candidates, create-state, mark, add-label, remove-label, status`);
  }
}

// Run if executed directly (not imported)
const isDirectRun = process.argv[1]?.endsWith('pr-scanner.ts') ||
  process.argv[1]?.endsWith('pr-scanner.js');
if (isDirectRun) {
  main().catch(err => {
    console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
