#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner v2 state management CLI.
 *
 * Provides deterministic actions for managing PR scanner state files
 * in `.temp-chats/`. Designed to be called from schedule prompts.
 *
 * Usage:
 *   npx tsx scanner.ts --action <action> [options]
 *
 * Actions:
 *   check-capacity   Count reviewing states, output capacity JSON
 *   list-candidates  List PRs without state files (requires gh CLI)
 *   create-state     Create a new state file for a PR (+ add reviewing label)
 *   mark             Update the state field of an existing state file (+ label mgmt)
 *   status           List all tracked PRs grouped by state
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error or fatal failure
 */

import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base directory for state files. Can be overridden via env for testing. */
const STATE_DIR = process.env.PR_SCANNER_STATE_DIR ?? resolve(process.cwd(), '.temp-chats');

/** Default max concurrent reviewing PRs. */
const DEFAULT_MAX_CONCURRENT = 3;

/** Lifetime of a reviewing state before expiry (48 hours in ms). */
const EXPIRES_MS = 48 * 60 * 60 * 1000;

/** GitHub repository for `gh` CLI commands. */
const REPO = process.env.PR_SCANNER_REPO ?? 'hs3180/disclaude';

/** GitHub label for tracking reviewing state. */
const REVIEWING_LABEL = 'pr-scanner:reviewing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed state values per design spec §3.1. */
type PRState = 'reviewing' | 'approved' | 'closed';

/** State file schema per design spec §3.1. */
interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function exitError(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** Atomic write: write to temp file then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Get state file path for a PR number. */
function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

/** Parse a state file, returning null on any error. */
async function readStateFile(filePath: string): Promise<PRStateFile | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Basic validation: must have required fields
    if (
      typeof parsed.prNumber === 'number' &&
      typeof parsed.state === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.updatedAt === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return parsed as PRStateFile;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ensure the state directory exists. */
async function ensureStateDir(): Promise<void> {
  try {
    await stat(STATE_DIR);
  } catch {
    await mkdir(STATE_DIR, { recursive: true });
  }
}

/** List all state files in the state directory. */
async function listStateFiles(): Promise<string[]> {
  try {
    const files = await readdir(STATE_DIR);
    return files
      .filter((f) => /^pr-\d+\.json$/.test(f))
      .map((f) => resolve(STATE_DIR, f));
  } catch {
    return [];
  }
}

/** Read all valid state files. */
async function readAllStates(): Promise<PRStateFile[]> {
  const files = await listStateFiles();
  const states: PRStateFile[] = [];
  for (const f of files) {
    const state = await readStateFile(f);
    if (state) states.push(state);
  }
  return states;
}

// ---------------------------------------------------------------------------
// GitHub Label Operations (Issue #2220)
// ---------------------------------------------------------------------------

/**
 * Add a GitHub label to a PR. Non-blocking: logs errors but does not throw.
 */
async function addLabel(prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', REPO,
      '--add-label', label,
    ], { timeout: 15000 });
    console.error(`[label] Added '${label}' to PR #${prNumber}`);
  } catch (err) {
    // Non-blocking: label failure should not block the main flow
    console.error(`[label:warn] Failed to add '${label}' to PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Remove a GitHub label from a PR. Non-blocking: logs errors but does not throw.
 */
async function removeLabel(prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', REPO,
      '--remove-label', label,
    ], { timeout: 15000 });
    console.error(`[label] Removed '${label}' from PR #${prNumber}`);
  } catch (err) {
    // Non-blocking: label failure should not block the main flow
    console.error(`[label:warn] Failed to remove '${label}' from PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** check-capacity: Count reviewing states and output capacity JSON. */
async function actionCheckCapacity(): Promise<void> {
  const maxConcurrent = parseInt(process.env.PR_SCANNER_MAX_CONCURRENT ?? String(DEFAULT_MAX_CONCURRENT), 10);
  const states = await readAllStates();
  const reviewing = states.filter((s) => s.state === 'reviewing').length;
  const available = Math.max(0, maxConcurrent - reviewing);

  const result = { reviewing, maxConcurrent, available };
  console.log(JSON.stringify(result, null, 2));
}

/** list-candidates: List open PRs that don't have state files. */
async function actionListCandidates(): Promise<void> {
  // Get existing state file PR numbers
  const existingStates = await readAllStates();
  const trackedNumbers = new Set(existingStates.map((s) => s.prNumber));

  // Use gh CLI to list open PRs
  let stdout: string;
  try {
    const result = await execFileAsync('gh', [
      'pr', 'list',
      '--repo', REPO,
      '--state', 'open',
      '--json', 'number,title',
    ], { timeout: 30000 });
    stdout = result.stdout;
  } catch (err) {
    exitError(`Failed to list PRs: ${err instanceof Error ? err.message : err}`);
  }

  let prs: Array<{ number: number; title: string }>;
  try {
    prs = JSON.parse(stdout!);
  } catch {
    exitError('Failed to parse gh pr list output');
  }

  // Filter out already tracked PRs
  const candidates = prs.filter((pr) => !trackedNumbers.has(pr.number));

  console.log(JSON.stringify(candidates, null, 2));
}

/** create-state: Create a new state file for a PR and add reviewing label. */
async function actionCreateState(prNumber: number): Promise<void> {
  const filePath = stateFilePath(prNumber);

  // Check if file already exists (idempotent)
  const existing = await readStateFile(filePath);
  if (existing) {
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  await ensureStateDir();

  const now = nowISO();
  const expiresAt = new Date(Date.now() + EXPIRES_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const stateFile: PRStateFile = {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    disbandRequested: null,
  };

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');

  // Issue #2220: Add reviewing label (non-blocking)
  await addLabel(prNumber, REVIEWING_LABEL);

  console.log(JSON.stringify(stateFile, null, 2));
}

/** mark: Update the state field of an existing state file and manage labels. */
async function actionMark(prNumber: number, newState: PRState): Promise<void> {
  const filePath = stateFilePath(prNumber);

  const existing = await readStateFile(filePath);
  if (!existing) {
    exitError(`No state file found for PR #${prNumber}. Run create-state first.`);
  }

  const oldState = existing.state;
  existing.state = newState;
  existing.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(existing, null, 2) + '\n');

  // Issue #2220: Manage labels when transitioning away from reviewing
  if (oldState === 'reviewing' && newState !== 'reviewing') {
    // Remove reviewing label when leaving reviewing state
    await removeLabel(prNumber, REVIEWING_LABEL);
  }

  console.log(JSON.stringify(existing, null, 2));
}

/** status: List all tracked PRs grouped by state (human-readable). */
async function actionStatus(): Promise<void> {
  const states = await readAllStates();

  if (states.length === 0) {
    console.log('No tracked PRs.');
    return;
  }

  const grouped: Record<PRState, PRStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  for (const s of states) {
    if (grouped[s.state]) {
      grouped[s.state].push(s);
    }
  }

  const stateIcons: Record<PRState, string> = {
    reviewing: '🔍',
    approved: '✅',
    closed: '🔴',
  };

  const stateOrder: PRState[] = ['reviewing', 'approved', 'closed'];

  for (const state of stateOrder) {
    const items = grouped[state];
    if (items.length === 0) continue;

    console.log(`\n${stateIcons[state]} ${state.toUpperCase()} (${items.length})`);
    console.log('-'.repeat(40));
    for (const item of items) {
      const chatInfo = item.chatId ? `chat=${item.chatId}` : 'no chat';
      console.log(`  PR #${item.prNumber} | ${chatInfo} | updated=${item.updatedAt}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): {
  action: string;
  pr?: number;
  state?: string;
} {
  const result: { action: string; pr?: number; state?: string } = { action: '' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--action':
        result.action = args[++i];
        break;
      case '--pr':
        result.pr = parseInt(args[++i], 10);
        break;
      case '--state':
        result.state = args[++i];
        break;
      default:
        // Ignore unknown args
        break;
    }
  }

  return result;
}

function printUsage(): void {
  console.log(`Usage: scanner.ts --action <action> [options]

Actions:
  check-capacity              Count reviewing states, output capacity JSON
  list-candidates             List PRs without state files (requires gh CLI)
  create-state --pr <number>  Create a new state file for a PR (+ add reviewing label)
  mark --pr <number> --state <state>  Update state (reviewing|approved|closed) (+ label mgmt)
  status                      List all tracked PRs grouped by state

Options:
  --action <action>   Action to perform (required)
  --pr <number>       PR number (for create-state, mark)
  --state <state>     New state value (for mark)

Environment variables:
  PR_SCANNER_STATE_DIR       Directory for state files (default: .temp-chats/)
  PR_SCANNER_MAX_CONCURRENT  Max concurrent reviewing PRs (default: 3)
  PR_SCANNER_REPO            GitHub repo for gh CLI (default: hs3180/disclaude)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { action, pr, state } = parseArgs(process.argv.slice(2));

  if (!action) {
    printUsage();
    process.exit(1);
  }

  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity();
      break;

    case 'list-candidates':
      await actionListCandidates();
      break;

    case 'create-state':
      if (!pr) exitError('--pr <number> is required for create-state');
      await actionCreateState(pr);
      break;

    case 'mark':
      if (!pr) exitError('--pr <number> is required for mark');
      if (!state) exitError('--state <reviewing|approved|closed> is required for mark');
      if (!['reviewing', 'approved', 'closed'].includes(state)) {
        exitError(`Invalid state '${state}'. Must be one of: reviewing, approved, closed`);
      }
      await actionMark(pr, state as PRState);
      break;

    case 'status':
      await actionStatus();
      break;

    default:
      exitError(`Unknown action '${action}'. Run without args for usage.`);
  }
}

main().catch((err) => {
  exitError(err instanceof Error ? err.message : String(err));
});
