#!/usr/bin/env tsx
/**
 * skills/pr-scanner/scanner.ts — PR Scanner v2 CLI tool for state management.
 *
 * Provides deterministic state management operations for PR review tracking.
 * State files are stored in `.temp-chats/pr-{number}.json` as single source of truth.
 *
 * This script is designed to be called by schedule prompts (not standalone scheduling).
 * It performs no GitHub API calls — all operations are local filesystem-based.
 *
 * CLI Actions:
 *   check-capacity           Count reviewing PRs and report capacity
 *   list-candidates          List PR state files, optionally filter by state
 *   create-state --pr <N>    Create a new state file for PR #N
 *   mark --pr <N> --state <S> Update a PR's state (validates transitions)
 *   status                   Print human-readable summary of all tracked PRs
 *
 * Environment variables:
 *   PR_SCANNER_MAX_CONCURRENT  Max concurrent reviewing PRs (default: 3)
 *   PR_SCANNER_STATE_DIR       Override state directory (default: .temp-chats)
 *   PR_SCANNER_EXPIRY_HOURS    Hours until state file expires (default: 48)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, I/O failure)
 */

import { readdir, readFile, writeFile, mkdir, stat, realpath, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  parsePrStateFile,
  parsePrNumberFromFilename,
  validatePrNumber,
  validateState,
  validateTransition,
  nowISO,
  PR_STATE_DIR,
  PR_STATE_FILE_REGEX,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_EXPIRY_HOURS,
  type PrState,
  type PrStateFile,
  ValidationError,
} from './schema.js';

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** Atomic file write: write to temp file then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Resolve the state directory path. */
function getStateDir(): string {
  return resolve(process.env.PR_SCANNER_STATE_DIR ?? PR_STATE_DIR);
}

/** Ensure state directory exists. */
async function ensureStateDir(): Promise<string> {
  const dir = getStateDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code !== 'EEXIST') {
      exit(`Failed to create state directory '${dir}': ${nodeErr.code ?? err}`);
    }
  }
  return dir;
}

/** Read all PR state files from the state directory. */
async function readAllStateFiles(dir: string): Promise<PrStateFile[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const states: PrStateFile[] = [];
  for (const filename of files) {
    if (!PR_STATE_FILE_REGEX.test(filename)) continue;

    const filePath = resolve(dir, filename);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      console.error(`WARN: Could not read state file: ${filePath}`);
      continue;
    }

    try {
      const state = parsePrStateFile(content, filePath);
      states.push(state);
    } catch (err) {
      console.error(`WARN: Skipping corrupted state file: ${filePath} (${err instanceof Error ? err.message : err})`);
    }
  }
  return states;
}

/** Get state file path for a specific PR number. */
function getStateFilePath(dir: string, prNumber: number): string {
  return resolve(dir, `pr-${prNumber}.json`);
}

// ---- Actions ----

/** check-capacity: Report how many reviewing slots are available. */
async function actionCheckCapacity(): Promise<void> {
  const maxConcurrent = parseInt(process.env.PR_SCANNER_MAX_CONCURRENT ?? String(DEFAULT_MAX_CONCURRENT), 10);
  if (!Number.isFinite(maxConcurrent) || maxConcurrent <= 0) {
    exit(`Invalid PR_SCANNER_MAX_CONCURRENT: must be a positive integer`);
  }

  const dir = getStateDir();
  const states = await readAllStateFiles(dir);
  const reviewing = states.filter((s) => s.state === 'reviewing').length;
  const available = Math.max(0, maxConcurrent - reviewing);

  const result = { reviewing, maxConcurrent, available };
  console.log(JSON.stringify(result, null, 2));
}

/** list-candidates: List PR state files, optionally filtered by state. */
async function actionListCandidates(args: { state?: string }): Promise<void> {
  const dir = getStateDir();
  const states = await readAllStateFiles(dir);

  let filtered = states;
  if (args.state) {
    const targetState = validateState(args.state);
    filtered = states.filter((s) => s.state === targetState);
  }

  // Sort by PR number ascending
  filtered.sort((a, b) => a.prNumber - b.prNumber);
  console.log(JSON.stringify(filtered, null, 2));
}

/** create-state: Create a new state file for a PR. */
async function actionCreateState(prNumber: number): Promise<void> {
  const dir = await ensureStateDir();
  const filePath = getStateFilePath(dir, prNumber);

  // Check if file already exists
  try {
    await stat(filePath);
    exit(`State file for PR #${prNumber} already exists: ${filePath}`);
  } catch {
    // File doesn't exist — proceed
  }

  const expiryHours = parseInt(process.env.PR_SCANNER_EXPIRY_HOURS ?? String(DEFAULT_EXPIRY_HOURS), 10);
  if (!Number.isFinite(expiryHours) || expiryHours <= 0) {
    exit(`Invalid PR_SCANNER_EXPIRY_HOURS: must be a positive integer`);
  }

  const now = nowISO();
  const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();

  const stateFile: PrStateFile = {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    disbandRequested: null,
  };

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  console.log(JSON.stringify(stateFile, null, 2));
}

/** mark: Update a PR's state (validates transitions). */
async function actionMark(prNumber: number, newState: PrState): Promise<void> {
  const dir = getStateDir();
  const filePath = getStateFilePath(dir, prNumber);

  // Read existing state
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    exit(`State file for PR #${prNumber} not found: ${filePath}`);
  }

  let stateFile: PrStateFile;
  try {
    stateFile = parsePrStateFile(content, filePath);
  } catch (err) {
    exit(`Corrupted state file for PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
  }

  // Validate transition
  if (stateFile.state === newState) {
    // Idempotent: same state is ok
    console.log(JSON.stringify(stateFile, null, 2));
    return;
  }

  try {
    validateTransition(stateFile.state, newState);
  } catch (err) {
    exit(err instanceof Error ? err.message : String(err));
  }

  // Update state
  const updated: PrStateFile = {
    ...stateFile,
    state: newState,
    updatedAt: nowISO(),
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  console.log(JSON.stringify(updated, null, 2));
}

/** status: Print human-readable summary of all tracked PRs. */
async function actionStatus(): Promise<void> {
  const dir = getStateDir();

  // Check if directory exists
  try {
    await stat(dir);
  } catch {
    console.log('No tracked PRs (state directory does not exist)');
    return;
  }

  const states = await readAllStateFiles(dir);
  if (states.length === 0) {
    console.log('No tracked PRs');
    return;
  }

  // Group by state
  const grouped: Record<PrState, PrStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  for (const s of states) {
    grouped[s.state].push(s);
  }

  const now = new Date();
  const lines: string[] = ['=== PR Scanner Status ===', ''];

  for (const [state, files] of Object.entries(grouped) as [PrState, PrStateFile[]][]) {
    if (files.length === 0) continue;

    const icon = state === 'reviewing' ? '🔍' : state === 'approved' ? '✅' : '❌';
    lines.push(`${icon} ${state} (${files.length}):`);

    for (const f of files) {
      const created = new Date(f.createdAt);
      const age = Math.round((now.getTime() - created.getTime()) / (1000 * 60));
      const expired = f.expiresAt < nowISO();
      const expiryMarker = expired ? ' ⚠️ EXPIRED' : '';
      lines.push(`  PR #${f.prNumber} — age: ${age}m, expires: ${f.expiresAt}${expiryMarker}`);
    }
    lines.push('');
  }

  lines.push(`Total: ${states.length} tracked PR(s)`);
  console.log(lines.join('\n'));
}

// ---- CLI Entry Point ----

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    options: {
      action: { type: 'string' },
      pr: { type: 'string' },
      state: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`Usage: scanner.ts --action <action> [--pr <number>] [--state <state>]

Actions:
  check-capacity           Report reviewing capacity (JSON)
  list-candidates          List PR state files (JSON)
  create-state             Create state file for a PR (--pr required)
  mark                     Update PR state (--pr and --state required)
  status                   Human-readable summary of tracked PRs

Options:
  --action <action>        Action to perform
  --pr <number>            PR number (required for create-state, mark)
  --state <state>          Target state: reviewing, approved, closed
  --help                   Show this help message

Environment:
  PR_SCANNER_MAX_CONCURRENT  Max reviewing PRs (default: 3)
  PR_SCANNER_STATE_DIR       State directory (default: .temp-chats)
  PR_SCANNER_EXPIRY_HOURS    Expiry hours (default: 48)`);
    process.exit(0);
  }

  const action = values.action;
  if (!action) {
    exit('Missing required --action flag. Use --help for usage.');
  }

  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity();
      break;

    case 'list-candidates':
      await actionListCandidates({ state: values.state });
      break;

    case 'create-state': {
      if (!values.pr) exit('--pr is required for create-state action');
      const prNumber = validatePrNumber(values.pr);
      await actionCreateState(prNumber);
      break;
    }

    case 'mark': {
      if (!values.pr) exit('--pr is required for mark action');
      if (!values.state) exit('--state is required for mark action');
      const prNumber = validatePrNumber(values.pr);
      const state = validateState(values.state);
      await actionMark(prNumber, state);
      break;
    }

    case 'status':
      await actionStatus();
      break;

    default:
      exit(`Unknown action: '${action}'. Valid actions: check-capacity, list-candidates, create-state, mark, status`);
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
