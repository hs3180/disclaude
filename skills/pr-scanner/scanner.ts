#!/usr/bin/env tsx
/**
 * skills/pr-scanner/scanner.ts — PR Scanner v2: deterministic state management CLI.
 *
 * Provides CLI actions for tracking PR review state via `.temp-chats/pr-{number}.json` files.
 * Designed for invocation by Schedule Prompt — no GitHub API calls in this module.
 *
 * Usage:
 *   npx tsx scanner.ts --action check-capacity
 *   npx tsx scanner.ts --action list-candidates
 *   npx tsx scanner.ts --action create-state --pr 123 --chatId oc_xxx
 *   npx tsx scanner.ts --action mark --pr 123 --state approved
 *   npx tsx scanner.ts --action status
 *
 * Environment variables:
 *   PR_SCANNER_MAX_CONCURRENT  Max concurrent reviewing PRs (default: 3)
 *   PR_SCANNER_STATE_DIR       State file directory (default: .temp-chats)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, I/O failure)
 */

import { readdir, readFile, writeFile, mkdir, stat, realpath, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  parseStateFile,
  parsePrNumberFromFileName,
  stateFilePath,
  createStateFile,
  isValidState,
  validateStateFileData,
  nowISO,
  type PrStateFile,
  type PrState,
  type CapacityResult,
  STATE_FILE_REGEX,
  DEFAULT_MAX_CONCURRENT,
  ValidationError,
} from './schema.js';

// ---- Helpers ----

/** Atomic file write: write to temp file then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Read all of stdin as a string (works with pipes and subprocess input) */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    // If stdin is a TTY (no pipe), resolve with empty string to avoid hanging
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

/** Parse CLI arguments into a simple key-value map */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

/** Read and parse all valid state files from the state directory */
async function readAllStates(stateDir: string): Promise<PrStateFile[]> {
  const canonicalDir = await realpath(stateDir);
  const files = await readdir(canonicalDir);
  const states: PrStateFile[] = [];

  for (const fileName of files) {
    if (!STATE_FILE_REGEX.test(fileName)) {
      continue;
    }

    const filePath = resolve(canonicalDir, fileName);
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      continue;
    }
    if (dirname(realFilePath) !== canonicalDir) {
      continue;
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    try {
      const state = parseStateFile(content, filePath);
      states.push(state);
    } catch {
      // Skip corrupted files
    }
  }

  return states;
}

// ---- Action Handlers ----

/** check-capacity: count reviewing PRs and report availability */
async function actionCheckCapacity(stateDir: string): Promise<void> {
  const maxConcurrent = getMaxConcurrent();
  const states = await readAllStates(stateDir);
  const reviewing = states.filter((s) => s.state === 'reviewing').length;
  const available = Math.max(0, maxConcurrent - reviewing);

  const result: CapacityResult = { reviewing, maxConcurrent, available };
  console.log(JSON.stringify(result));
}

/** list-candidates: list PRs not yet tracked by state files */
async function actionListCandidates(stateDir: string): Promise<void> {
  // Read existing state files to get tracked PR numbers
  const states = await readAllStates(stateDir);
  const trackedPrNumbers = new Set(states.map((s) => s.prNumber));

  // Read candidate PRs from env var or stdin (JSON array from gh pr list)
  // This decouples us from gh CLI — callers pipe the data
  const envInput = process.env.PR_SCANNER_CANDIDATES;
  const input = envInput ?? await readStdin();

  let candidates: Array<{ number: number; title: string }>;
  try {
    candidates = JSON.parse(input);
    if (!Array.isArray(candidates)) {
      throw new Error('Input must be a JSON array');
    }
  } catch {
    console.error('ERROR: Failed to parse stdin as JSON array');
    process.exit(1);
  }

  // Filter out already-tracked PRs
  const untracked = candidates.filter((c) => !trackedPrNumbers.has(c.number));
  console.log(JSON.stringify(untracked));
}

/** create-state: create a new state file for a PR */
async function actionCreateState(stateDir: string, prNumber: number, chatId: string): Promise<void> {
  const filePath = stateFilePath(stateDir, prNumber);

  // Check if state file already exists
  try {
    await stat(filePath);
    console.error(`ERROR: State file for PR #${prNumber} already exists`);
    process.exit(1);
  } catch {
    // File doesn't exist — proceed
  }

  const stateFile = createStateFile(prNumber, chatId, 'reviewing');
  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  console.log(JSON.stringify(stateFile));
}

/** mark: update the state of an existing PR */
async function actionMark(stateDir: string, prNumber: number, newState: PrState): Promise<void> {
  if (!isValidState(newState)) {
    console.error(`ERROR: Invalid state '${newState}'. Must be one of: reviewing, approved, closed`);
    process.exit(1);
  }

  const filePath = stateFilePath(stateDir, prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    console.error(`ERROR: State file for PR #${prNumber} not found`);
    process.exit(1);
  }

  let stateFile: PrStateFile;
  try {
    stateFile = parseStateFile(content, filePath);
  } catch (err) {
    console.error(`ERROR: Corrupted state file: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const updated: PrStateFile = {
    ...stateFile,
    state: newState,
    updatedAt: nowISO(),
  };

  // Validate the updated file
  validateStateFileData(updated, filePath);

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  console.log(JSON.stringify(updated));
}

/** status: display human-readable summary of all tracked PRs */
async function actionStatus(stateDir: string): Promise<void> {
  const states = await readAllStates(stateDir);

  if (states.length === 0) {
    console.log('No tracked PRs.');
    return;
  }

  // Group by state
  const grouped: Record<string, PrStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  for (const s of states) {
    grouped[s.state].push(s);
  }

  const now = nowISO();
  const total = states.length;
  const maxConcurrent = getMaxConcurrent();

  console.log(`PR Scanner Status: ${total} tracked PR(s), max ${maxConcurrent} concurrent`);
  console.log('');

  for (const [state, prs] of Object.entries(grouped)) {
    if (prs.length === 0) {
      continue;
    }
    console.log(`[${state.toUpperCase()}] (${prs.length})`);
    for (const pr of prs) {
      const expiresAt = pr.expiresAt;
      const isExpired = expiresAt < now;
      const expiryTag = isExpired ? ' (EXPIRED)' : '';
      console.log(`  PR #${pr.prNumber} — updated ${pr.updatedAt}${expiryTag}`);
    }
    console.log('');
  }
}

// ---- Utilities ----

function getMaxConcurrent(): number {
  const env = process.env.PR_SCANNER_MAX_CONCURRENT;
  if (env) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_CONCURRENT;
}

function getStateDir(): string {
  return process.env.PR_SCANNER_STATE_DIR ?? '.temp-chats';
}

async function ensureStateDir(stateDir: string): Promise<string> {
  const resolved = resolve(stateDir);
  try {
    await mkdir(resolved, { recursive: true });
  } catch {
    // Directory may already exist
  }
  return resolved;
}

// ---- Main ----

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action;

  if (!action) {
    console.error('ERROR: --action is required. Valid actions: check-capacity, list-candidates, create-state, mark, status');
    process.exit(1);
  }

  const stateDir = await ensureStateDir(getStateDir());

  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity(stateDir);
      break;

    case 'list-candidates':
      await actionListCandidates(stateDir);
      break;

    case 'create-state': {
      const prStr = args.pr;
      const chatId = args.chatId;
      if (!prStr || !chatId) {
        console.error('ERROR: --pr and --chatId are required for create-state');
        process.exit(1);
      }
      const prNumber = parseInt(prStr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid --pr value '${prStr}', must be a positive integer`);
        process.exit(1);
      }
      await actionCreateState(stateDir, prNumber, chatId);
      break;
    }

    case 'mark': {
      const prStr = args.pr;
      const newState = args.state;
      if (!prStr || !newState) {
        console.error('ERROR: --pr and --state are required for mark');
        process.exit(1);
      }
      const prNumber = parseInt(prStr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid --pr value '${prStr}', must be a positive integer`);
        process.exit(1);
      }
      await actionMark(stateDir, prNumber, newState as PrState);
      break;
    }

    case 'status':
      await actionStatus(stateDir);
      break;

    default:
      console.error(`ERROR: Unknown action '${action}'. Valid actions: check-capacity, list-candidates, create-state, mark, status`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
