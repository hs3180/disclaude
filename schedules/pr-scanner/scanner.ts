#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner v2 CLI script.
 *
 * Provides deterministic CLI actions for the PR Scanner schedule prompt.
 * Each action outputs JSON (or human-readable text for `status`) to stdout.
 *
 * State files are stored in `.temp-chats/pr-{number}.json` per the v2 design spec.
 *
 * Usage:
 *   npx tsx scanner.ts --action check-capacity [--max-concurrent N]
 *   npx tsx scanner.ts --action list-candidates [--repo OWNER/REPO]
 *   npx tsx scanner.ts --action create-state --pr NUMBER [--chat-id ID]
 *   npx tsx scanner.ts --action mark --pr NUMBER --state reviewing|approved|closed
 *   npx tsx scanner.ts --action status
 *
 * Exit codes:
 *   0 — success
 *   1 — invalid arguments or fatal error
 */

import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ---- Types ----

export type PRState = 'reviewing' | 'approved' | 'closed';

export interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Phase 2 field — always null in Phase 1 */
  disbandRequested: string | null;
}

export interface CheckCapacityResult {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

export interface PRCandidate {
  number: number;
  title: string;
  author: string;
  labels: string[];
}

// ---- Constants ----

export const STATE_DIR = '.temp-chats';
export const VALID_STATES: readonly PRState[] = ['reviewing', 'approved', 'closed'] as const;
export const DEFAULT_MAX_CONCURRENT = 3;
export const EXPIRY_HOURS = 48;

// ---- Helpers ----

const execFileAsync = promisify(execFile);

/** Get current UTC ISO timestamp */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Calculate expiry timestamp (now + EXPIRY_HOURS) */
export function expiryISO(): string {
  return new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
}

/** Get state file path for a given PR number */
export function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

/** Parse and validate a PR state file from JSON string */
export function parseStateFile(json: string, filePath: string): PRStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`State file '${filePath}' is not valid JSON`);
  }
  return validateStateFile(data, filePath);
}

/** Validate the structure of a parsed state file object */
export function validateStateFile(data: unknown, filePath: string): PRStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`State file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  if (!isValidPRState(obj.state)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}' (must be reviewing|approved|closed)`);
  }

  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }

  if (typeof obj.createdAt !== 'string') {
    throw new Error(`State file '${filePath}' has missing or invalid 'createdAt'`);
  }

  if (typeof obj.updatedAt !== 'string') {
    throw new Error(`State file '${filePath}' has missing or invalid 'updatedAt'`);
  }

  if (typeof obj.expiresAt !== 'string') {
    throw new Error(`State file '${filePath}' has missing or invalid 'expiresAt'`);
  }

  if (obj.disbandRequested !== null && typeof obj.disbandRequested !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested'`);
  }

  return data as PRStateFile;
}

function isValidPRState(value: unknown): value is PRState {
  return typeof value === 'string' && VALID_STATES.includes(value as PRState);
}

/** Atomic file write: write to temp file then rename */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Ensure the state directory exists */
async function ensureStateDir(): Promise<string> {
  const dir = resolve(STATE_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---- Actions ----

/**
 * check-capacity: Count reviewing state files and report capacity.
 */
export async function checkCapacity(maxConcurrent: number = DEFAULT_MAX_CONCURRENT): Promise<CheckCapacityResult> {
  let reviewing = 0;
  try {
    const dir = resolve(STATE_DIR);
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.startsWith('pr-') || !file.endsWith('.json')) continue;
      try {
        const content = await readFile(resolve(dir, file), 'utf-8');
        const state = parseStateFile(content, file);
        if (state.state === 'reviewing') reviewing++;
      } catch {
        // Skip corrupted files
      }
    }
  } catch {
    // Directory doesn't exist — zero reviewing
  }

  return {
    reviewing,
    maxConcurrent,
    available: Math.max(0, maxConcurrent - reviewing),
  };
}

/**
 * list-candidates: List open PRs that don't have state files yet.
 * Uses `gh pr list` to fetch open PRs, then filters out those with existing state files.
 */
export async function listCandidates(repo: string): Promise<PRCandidate[]> {
  // Fetch open PRs via gh CLI
  const { stdout } = await execFileAsync('gh', [
    'pr', 'list',
    '--repo', repo,
    '--state', 'open',
    '--json', 'number,title,author,labels',
  ], { timeout: 30_000 });

  let prs: Array<{ number: number; title: string; author: { login: string }; labels: Array<{ name: string }> }>;
  try {
    prs = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse gh pr list output: ${stdout.substring(0, 200)}`);
  }

  // Filter out PRs that already have state files
  const candidates: PRCandidate[] = [];
  for (const pr of prs) {
    const filePath = stateFilePath(pr.number);
    try {
      await stat(filePath);
      // File exists — skip this PR
      continue;
    } catch {
      // File doesn't exist — this PR is a candidate
    }

    // Also filter out PRs with pr-scanner labels
    const labelNames = (pr.labels || []).map((l: { name: string }) => l.name);
    if (labelNames.some(l => l.startsWith('pr-scanner:'))) continue;

    candidates.push({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login ?? 'unknown',
      labels: labelNames,
    });
  }

  return candidates;
}

/**
 * create-state: Create a new state file for a PR.
 */
export async function createState(prNumber: number, chatId: string | null = null): Promise<PRStateFile> {
  await ensureStateDir();

  const filePath = stateFilePath(prNumber);

  // Check if state file already exists
  try {
    await stat(filePath);
    throw new Error(`State file already exists for PR #${prNumber} (${filePath})`);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string; message?: string };
    if (nodeErr.code !== 'ENOENT') {
      // Re-throw if it's our "already exists" error or a non-ENOENT fs error
      throw err;
    }
    // ENOENT — file doesn't exist, proceed
  }

  const now = nowISO();
  const stateFile: PRStateFile = {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: expiryISO(),
    disbandRequested: null,
  };

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  return stateFile;
}

/**
 * mark: Update the state field of an existing state file.
 */
export async function markState(prNumber: number, newState: PRState): Promise<PRStateFile> {
  const filePath = stateFilePath(prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      throw new Error(`No state file found for PR #${prNumber} (${filePath})`);
    }
    throw err;
  }

  const stateFile = parseStateFile(content, filePath);
  stateFile.state = newState;
  stateFile.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  return stateFile;
}

/**
 * status: List all tracked PRs grouped by state (human-readable output).
 */
export async function status(): Promise<string> {
  const grouped: Record<PRState, PRStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  let totalFiles = 0;

  try {
    const dir = resolve(STATE_DIR);
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.startsWith('pr-') || !file.endsWith('.json')) continue;
      totalFiles++;
      try {
        const content = await readFile(resolve(dir, file), 'utf-8');
        const state = parseStateFile(content, file);
        grouped[state.state].push(state);
      } catch {
        // Skip corrupted files but count them
      }
    }
  } catch {
    // Directory doesn't exist
    return 'No tracked PRs found (.temp-chats/ directory does not exist)\n';
  }

  if (totalFiles === 0) {
    return 'No tracked PRs found\n';
  }

  const lines: string[] = [];
  lines.push(`PR Scanner Status (${totalFiles} state files)\n`);

  for (const state of VALID_STATES) {
    const items = grouped[state];
    if (items.length === 0) continue;
    const icon = state === 'reviewing' ? '🔍' : state === 'approved' ? '✅' : '🏁';
    lines.push(`${icon} ${state} (${items.length}):`);
    for (const item of items) {
      lines.push(`  PR #${item.prNumber} — updated ${item.updatedAt}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---- CLI ----

function printUsage(): never {
  console.error(`Usage: scanner.ts --action <action> [options]

Actions:
  check-capacity [--max-concurrent N]  Count reviewing PRs, report capacity
  list-candidates [--repo OWNER/REPO]   List open PRs without state files
  create-state --pr NUMBER [--chat-id ID]  Create state file for a PR
  mark --pr NUMBER --state reviewing|approved|closed  Update PR state
  status                                Show all tracked PRs grouped by state

Options:
  --max-concurrent N   Max concurrent reviewing PRs (default: ${DEFAULT_MAX_CONCURRENT})
  --repo OWNER/REPO    GitHub repository (default: hs3180/disclaude)
  --pr NUMBER          PR number
  --state STATE        New state (reviewing|approved|closed)
  --chat-id ID         Optional chat ID for create-state`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse --action
  const actionIdx = args.indexOf('--action');
  if (actionIdx === -1 || actionIdx + 1 >= args.length) {
    printUsage();
  }
  const action = args[actionIdx + 1];

  // Parse optional args
  const maxConcurrentIdx = args.indexOf('--max-concurrent');
  const maxConcurrent = maxConcurrentIdx !== -1 && maxConcurrentIdx + 1 < args.length
    ? parseInt(args[maxConcurrentIdx + 1], 10)
    : DEFAULT_MAX_CONCURRENT;

  const repoIdx = args.indexOf('--repo');
  const repo = repoIdx !== -1 && repoIdx + 1 < args.length
    ? args[repoIdx + 1]
    : 'hs3180/disclaude';

  const prIdx = args.indexOf('--pr');
  const prNumber = prIdx !== -1 && prIdx + 1 < args.length
    ? parseInt(args[prIdx + 1], 10)
    : null;

  const stateIdx = args.indexOf('--state');
  const stateValue = stateIdx !== -1 && stateIdx + 1 < args.length
    ? args[stateIdx + 1]
    : null;

  const chatIdIdx = args.indexOf('--chat-id');
  const chatId = chatIdIdx !== -1 && chatIdIdx + 1 < args.length
    ? args[chatIdIdx + 1]
    : null;

  try {
    switch (action) {
      case 'check-capacity': {
        if (!Number.isFinite(maxConcurrent) || maxConcurrent <= 0) {
          console.error('ERROR: --max-concurrent must be a positive integer');
          process.exit(1);
        }
        const result = await checkCapacity(maxConcurrent);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'list-candidates': {
        const candidates = await listCandidates(repo);
        console.log(JSON.stringify(candidates, null, 2));
        break;
      }

      case 'create-state': {
        if (prNumber === null || !Number.isFinite(prNumber) || prNumber <= 0) {
          console.error('ERROR: --pr must be a positive integer');
          process.exit(1);
        }
        const result = await createState(prNumber, chatId);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'mark': {
        if (prNumber === null || !Number.isFinite(prNumber) || prNumber <= 0) {
          console.error('ERROR: --pr must be a positive integer');
          process.exit(1);
        }
        if (!stateValue || !isValidPRState(stateValue)) {
          console.error(`ERROR: --state must be one of: ${VALID_STATES.join(', ')}`);
          process.exit(1);
        }
        const result = await markState(prNumber, stateValue);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'status': {
        const output = await status();
        console.log(output);
        break;
      }

      default:
        console.error(`ERROR: Unknown action '${action}'`);
        printUsage();
    }
  } catch (err: unknown) {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// Only run main() when executed directly via CLI (not when imported for testing)
if (process.argv[1]?.includes('scanner.ts')) {
  main();
}
