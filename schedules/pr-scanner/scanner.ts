#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner v2: deterministic scanner logic.
 *
 * CLI interface (--action mode):
 *
 *   --action check-capacity
 *     Read state dir, count files with state: "reviewing".
 *     Output: JSON { reviewing, maxConcurrent, available }
 *
 *   --action list-candidates
 *     Run `gh pr list` + filter PRs that already have state files or labels.
 *     Output: JSON array of candidate PR objects
 *
 *   --action create-state --pr <number> [--chat-id <id>]
 *     Write a new state file for the given PR.
 *     Output: JSON state file content
 *
 *   --action mark --pr <number> --state <reviewing|approved|closed>
 *     Update an existing state file's state field.
 *     Output: JSON updated state file content
 *
 *   --action status
 *     List all tracked PRs grouped by state.
 *     Output: human-readable text
 *
 * Environment variables (optional):
 *   PR_SCANNER_STATE_DIR     State directory path (default: .temp-chats)
 *   PR_SCANNER_MAX_REVIEWING Max concurrent reviewing PRs (default: 3)
 *   PR_SCANNER_REPO          GitHub repo in owner/repo format (default: hs3180/disclaude)
 *   PR_SCANNER_SKIP_GH_CHECK Set to '1' to skip gh CLI checks (for testing)
 *   PR_SCANNER_TTL_HOURS     State file expiry in hours (default: 48)
 *
 * Exit codes:
 *   0 — success
 *   1 — error (missing args, invalid input, gh CLI failure)
 */

import { readdir, readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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
  disbandRequested: null; // Phase 2 — always null in Phase 1
}

// ---- Constants ----

const DEFAULT_STATE_DIR = '.temp-chats';
const DEFAULT_MAX_REVIEWING = 3;
const DEFAULT_REPO = 'hs3180/disclaude';
const DEFAULT_TTL_HOURS = 48;
const GH_TIMEOUT_MS = 30_000;

// ---- Helpers ----

function nowISO(): string {
  return new Date().toISOString();
}

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** Parse a positive integer from env, returning default if absent/invalid */
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    exit(`Invalid ${key}='${raw}' — must be a positive integer`);
  }
  return parsed;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/** Valid state values */
const VALID_STATES: readonly PRState[] = ['reviewing', 'approved', 'closed'] as const;

function isValidState(value: string): value is PRState {
  return (VALID_STATES as readonly string[]).includes(value);
}

/** State file name pattern: pr-<number>.json */
const PR_FILE_REGEX = /^pr-(\d+)\.json$/;

/** Parse PR number from state file name */
function parsePrFromFileName(fileName: string): number | null {
  const match = PR_FILE_REGEX.exec(fileName);
  return match ? parseInt(match[1], 10) : null;
}

/** Get state file path for a given PR number */
function stateFilePath(stateDir: string, prNumber: number): string {
  return join(stateDir, `pr-${prNumber}.json`);
}

/** Atomic file write: write to temp file then rename */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Ensure a directory exists */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Parse and validate a state file */
function parseStateFile(json: string, filePath: string): PRStateFile {
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

  if (!isValidState(obj.state as string)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }

  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }

  return data as PRStateFile;
}

/** Read all state files from the state directory */
async function readAllStates(
  stateDir: string,
): Promise<{ files: PRStateFile[]; corrupted: number }> {
  const files: PRStateFile[] = [];
  let corrupted = 0;

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    return { files: [], corrupted: 0 };
  }

  for (const entry of entries) {
    const prNum = parsePrFromFileName(entry);
    if (prNum === null) continue; // skip non-PR files

    const filePath = join(stateDir, entry);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      corrupted++;
      continue;
    }

    try {
      files.push(parseStateFile(content, filePath));
    } catch {
      corrupted++;
    }
  }

  return { files, corrupted };
}

// ---- Action implementations ----

/**
 * check-capacity: count reviewing state files, report capacity
 */
async function actionCheckCapacity(stateDir: string, maxReviewing: number): Promise<void> {
  await ensureDir(stateDir);
  const { files } = await readAllStates(stateDir);
  const reviewing = files.filter((f) => f.state === 'reviewing').length;
  const available = Math.max(0, maxReviewing - reviewing);

  const result = { reviewing, maxConcurrent: maxReviewing, available };
  console.log(JSON.stringify(result, null, 2));
}

/**
 * list-candidates: run gh pr list and filter out PRs already tracked
 */
async function actionListCandidates(
  stateDir: string,
  repo: string,
  skipGhCheck: boolean,
): Promise<void> {
  await ensureDir(stateDir);

  // Read existing state files to get tracked PR numbers
  const { files } = await readAllStates(stateDir);
  const trackedNumbers = new Set(files.map((f) => f.prNumber));

  // Check gh CLI availability
  if (!skipGhCheck) {
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: gh CLI not found in PATH');
    }
  }

  // Fetch open PRs
  let stdout: string;
  try {
    const result = await execFileAsync(
      'gh',
      [
        'pr', 'list',
        '--repo', repo,
        '--state', 'open',
        '--json', 'number,title,author,headRefName,baseRefName,mergeable,additions,deletions,changedFiles,labels,updatedAt',
        '--limit', '100',
      ],
      { timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    exit(`gh pr list failed: ${execErr.stderr ?? execErr.message ?? 'unknown error'}`);
  }

  let prs: Array<Record<string, unknown>>;
  try {
    prs = JSON.parse(stdout);
  } catch {
    exit('Failed to parse gh pr list output as JSON');
  }

  if (!Array.isArray(prs)) {
    exit('Unexpected gh pr list output: expected array');
  }

  // Filter: exclude PRs with existing state files or pr-scanner:reviewing label
  const candidates = prs.filter((pr) => {
    const number = pr.number as number;
    if (trackedNumbers.has(number)) return false;

    // Check for pr-scanner:reviewing label
    const labels = pr.labels as Array<Record<string, string>> | undefined;
    if (Array.isArray(labels)) {
      const hasLabel = labels.some(
        (l) => l.name === 'pr-scanner:reviewing',
      );
      if (hasLabel) return false;
    }

    return true;
  });

  console.log(JSON.stringify(candidates, null, 2));
}

/**
 * create-state: create a new state file for a PR
 */
async function actionCreateState(
  stateDir: string,
  prNumber: number,
  chatId: string | null,
  ttlHours: number,
): Promise<void> {
  await ensureDir(stateDir);

  const filePath = stateFilePath(stateDir, prNumber);

  // Check if state file already exists
  try {
    await stat(filePath);
    exit(`State file already exists for PR #${prNumber} at ${filePath}`);
  } catch {
    // File doesn't exist — proceed
  }

  const now = nowISO();
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  const stateFile: PRStateFile = {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    disbandRequested: null,
  };

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  console.log(JSON.stringify(stateFile, null, 2));
}

/**
 * mark: update state of an existing state file
 */
async function actionMark(
  stateDir: string,
  prNumber: number,
  newState: PRState,
): Promise<void> {
  const filePath = stateFilePath(stateDir, prNumber);

  // Read existing state file
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    exit(`No state file found for PR #${prNumber} at ${filePath}`);
  }

  const existing = parseStateFile(content, filePath);

  if (existing.state === newState) {
    console.log(JSON.stringify({ ...existing, message: `PR #${prNumber} already in state '${newState}'` }, null, 2));
    return;
  }

  const oldState = existing.state;
  const updated: PRStateFile = {
    ...existing,
    state: newState,
    updatedAt: nowISO(),
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  console.log(JSON.stringify({ ...updated, _transition: `${oldState} → ${newState}` }, null, 2));
}

/**
 * status: list all tracked PRs grouped by state
 */
async function actionStatus(stateDir: string): Promise<void> {
  await ensureDir(stateDir);
  const { files, corrupted } = await readAllStates(stateDir);

  if (files.length === 0 && corrupted === 0) {
    console.log('No PRs currently tracked.');
    return;
  }

  // Group by state
  const grouped: Record<string, PRStateFile[]> = {};
  for (const f of files) {
    if (!grouped[f.state]) grouped[f.state] = [];
    grouped[f.state].push(f);
  }

  // Print in fixed order
  const stateOrder: PRState[] = ['reviewing', 'approved', 'closed'];
  for (const state of stateOrder) {
    const items = grouped[state] ?? [];
    if (items.length === 0) continue;
    const label = state.toUpperCase();
    console.log(`\n${label} (${items.length})`);
    console.log('-'.repeat(label.length + 4));
    for (const item of items) {
      const age = formatAge(item.updatedAt);
      console.log(`  #${item.prNumber} — ${state} — updated ${age}`);
    }
  }

  if (corrupted > 0) {
    console.log(`\n⚠ ${corrupted} corrupted file(s) skipped`);
  }
}

/** Format an ISO timestamp as a human-readable age string */
function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

// ---- CLI argument parsing ----

function parseArgs(argv: string[]): {
  action: string;
  pr: number | null;
  state: string | null;
  chatId: string | null;
} {
  const args = argv.slice(2); // skip node + script path
  let action = '';
  let pr: number | null = null;
  let state: string | null = null;
  let chatId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--action':
        action = args[++i] ?? '';
        break;
      case '--pr':
        pr = parseInt(args[++i] ?? '', 10);
        break;
      case '--state':
        state = args[++i] ?? null;
        break;
      case '--chat-id':
        chatId = args[++i] ?? null;
        break;
      default:
        // Ignore unknown args for forward compatibility
        break;
    }
  }

  return { action, pr, state, chatId };
}

function printUsage(): never {
  console.error(`Usage: scanner.ts --action <action> [options]

Actions:
  check-capacity              Count reviewing PRs, report capacity
  list-candidates             List PR candidates via gh CLI
  create-state --pr <N>       Create state file for PR #N
  mark --pr <N> --state <S>   Update state for PR #N
  status                      List all tracked PRs

Options:
  --pr <number>       PR number (required for create-state, mark)
  --state <state>     New state: reviewing | approved | closed (for mark)
  --chat-id <id>      Chat ID (optional, for create-state)`);
  process.exit(1);
}

// ---- Main ----

async function main() {
  const { action, pr, state, chatId } = parseArgs(process.argv);

  const stateDir = resolve(envStr('PR_SCANNER_STATE_DIR', DEFAULT_STATE_DIR));
  const maxReviewing = envInt('PR_SCANNER_MAX_REVIEWING', DEFAULT_MAX_REVIEWING);
  const repo = envStr('PR_SCANNER_REPO', DEFAULT_REPO);
  const ttlHours = envInt('PR_SCANNER_TTL_HOURS', DEFAULT_TTL_HOURS);
  const skipGhCheck = process.env.PR_SCANNER_SKIP_GH_CHECK === '1';

  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity(stateDir, maxReviewing);
      break;

    case 'list-candidates':
      await actionListCandidates(stateDir, repo, skipGhCheck);
      break;

    case 'create-state': {
      if (pr === null || !Number.isFinite(pr) || pr <= 0) {
        exit('Invalid or missing --pr <number>');
      }
      await actionCreateState(stateDir, pr, chatId, ttlHours);
      break;
    }

    case 'mark': {
      if (pr === null || !Number.isFinite(pr) || pr <= 0) {
        exit('Invalid or missing --pr <number>');
      }
      if (!state || !isValidState(state)) {
        exit(`Invalid or missing --state <reviewing|approved|closed>, got '${state}'`);
      }
      await actionMark(stateDir, pr, state);
      break;
    }

    case 'status':
      await actionStatus(stateDir);
      break;

    default:
      printUsage();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
