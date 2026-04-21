#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner v2 deterministic CLI tool.
 *
 * Provides actions for schedule prompts to manage PR scanning state.
 * All state is stored in `.temp-chats/pr-{number}.json` files.
 *
 * Actions:
 *   check-capacity   Count reviewing state files, report availability
 *   list-candidates  Discover untracked open PRs via `gh pr list`
 *   create-state     Write initial state file for a PR
 *   mark             Update a PR's state field
 *   status           List all tracked PRs grouped by state
 *
 * State file schema (design spec §3.1):
 *   {
 *     "prNumber": number,
 *     "chatId": string | null,
 *     "state": "reviewing" | "approved" | "closed",
 *     "createdAt": string,       // ISO 8601 Z-suffix
 *     "updatedAt": string,       // ISO 8601 Z-suffix
 *     "expiresAt": string,       // createdAt + 48h
 *     "disbandRequested": null   // Phase 2 field, always null in Phase 1
 *   }
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid arguments, I/O failure)
 *
 * @see Issue #2219 — scanner.ts basic skeleton
 * @see Issue #2210 — PR Scanner v2 parent issue
 */

import { readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

/** Default state directory (relative to CWD). Overridden via STATE_DIR env. */
const DEFAULT_STATE_DIR = '.temp-chats';

/** Maximum concurrent reviewing PRs. Overridden via MAX_CONCURRENT env. */
const DEFAULT_MAX_CONCURRENT = 3;

/** Expiry duration in hours (createdAt + 48h). */
const EXPIRY_HOURS = 48;

/** Valid state transitions. */
const VALID_STATES = ['reviewing', 'approved', 'closed'] as const;
type PRState = (typeof VALID_STATES)[number];

/** UTC ISO 8601 Z-suffix regex for timestamp validation (with optional milliseconds). */
const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// ---- Types ----

interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null;
}

interface CheckCapacityResult {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

interface CandidatePR {
  number: number;
  title: string;
  author: string;
  labels: string[];
  headRefName: string;
}

// ---- Helpers ----

/** Get current UTC timestamp in ISO 8601 Z-suffix format. */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Calculate expiry timestamp (createdAt + EXPIRY_HOURS). */
export function calcExpiry(createdAt: string): string {
  const d = new Date(createdAt);
  d.setUTCHours(d.getUTCHours() + EXPIRY_HOURS);
  return d.toISOString();
}

/** Validate a PR state value. */
export function isValidState(state: string): state is PRState {
  return (VALID_STATES as readonly string[]).includes(state);
}

/** Validate UTC ISO 8601 Z-suffix timestamp format. */
export function isValidTimestamp(ts: string): boolean {
  return UTC_DATETIME_REGEX.test(ts);
}

/** Get the state directory path. */
export function getStateDir(): string {
  return process.env.STATE_DIR ?? DEFAULT_STATE_DIR;
}

/** Get max concurrent reviewing PRs. */
export function getMaxConcurrent(): number {
  const env = process.env.MAX_CONCURRENT;
  if (env) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_CONCURRENT;
}

/** Get the state file path for a given PR number. */
export function getStateFilePath(prNumber: number): string {
  return resolve(getStateDir(), `pr-${prNumber}.json`);
}

/**
 * Atomic file write: write to temp file then rename.
 * Prevents partial writes on crash.
 */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Ensure the state directory exists. */
async function ensureStateDir(): Promise<string> {
  const dir = resolve(getStateDir());
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Create a new state file object (in-memory). */
export function createPRState(prNumber: number, chatId: string | null = null): PRStateFile {
  const createdAt = nowISO();
  return {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt,
    updatedAt: createdAt,
    expiresAt: calcExpiry(createdAt),
    disbandRequested: null,
  };
}

/** Parse and validate a state file from JSON string. */
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
  if (!isValidState(obj.state as string)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }
  if (typeof obj.createdAt !== 'string' || !isValidTimestamp(obj.createdAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'createdAt'`);
  }
  if (typeof obj.updatedAt !== 'string' || !isValidTimestamp(obj.updatedAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'updatedAt'`);
  }
  if (typeof obj.expiresAt !== 'string' || !isValidTimestamp(obj.expiresAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'expiresAt'`);
  }

  return data as PRStateFile;
}

// ---- Actions ----

/**
 * check-capacity: Read `.temp-chats/` and count reviewing state files.
 * Output: JSON with reviewing count, maxConcurrent, and available slots.
 */
export async function checkCapacity(): Promise<void> {
  const stateDir = resolve(getStateDir());
  const maxConcurrent = getMaxConcurrent();

  let reviewing = 0;
  try {
    const files = await readdir(stateDir);
    const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      const filePath = resolve(stateDir, fileName);
      try {
        const content = await readFile(filePath, 'utf-8');
        const state = parseStateFile(content, filePath);
        if (state.state === 'reviewing') reviewing++;
      } catch {
        // Skip corrupted files
        console.error(`WARN: Skipping corrupted file: ${filePath}`);
      }
    }
  } catch {
    // Directory doesn't exist yet — no reviewing PRs
  }

  const result: CheckCapacityResult = {
    reviewing,
    maxConcurrent,
    available: Math.max(0, maxConcurrent - reviewing),
  };
  console.log(JSON.stringify(result, null, 2));
}

/**
 * list-candidates: Run `gh pr list` and filter out PRs that already have
 * state files. Output: JSON array of candidate PRs.
 */
export async function listCandidates(): Promise<void> {
  const repo = process.env.GH_REPO ?? 'hs3180/disclaude';
  const stateDir = resolve(getStateDir());

  // Collect already-tracked PR numbers
  const trackedPRs = new Set<number>();
  try {
    const files = await readdir(stateDir);
    for (const fileName of files) {
      const match = fileName.match(/^pr-(\d+)\.json$/);
      if (match) trackedPRs.add(parseInt(match[1], 10));
    }
  } catch {
    // Directory doesn't exist — no tracked PRs
  }

  // Call gh pr list
  let stdout: string;
  try {
    const result = await execFileAsync(
      'gh',
      [
        'pr', 'list',
        '--repo', repo,
        '--state', 'open',
        '--json', 'number,title,author,labels,headRefName',
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    console.error(`ERROR: Failed to run gh pr list: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  let prs: CandidatePR[];
  try {
    prs = JSON.parse(stdout);
  } catch {
    console.error('ERROR: Failed to parse gh pr list output');
    process.exit(1);
  }

  // Filter out already-tracked PRs and PRs with pr-scanner:reviewing label
  const candidates = prs.filter((pr) => {
    if (trackedPRs.has(pr.number)) return false;
    const labelNames = Array.isArray(pr.labels)
      ? pr.labels.map((l: unknown) => typeof l === 'object' && l !== null && 'name' in l ? (l as { name: string }).name : String(l))
      : [];
    if (labelNames.includes('pr-scanner:reviewing')) return false;
    return true;
  });

  console.log(JSON.stringify(candidates, null, 2));
}

/**
 * create-state: Write initial state file for a PR.
 * Output: JSON of the created state file.
 */
export async function createState(prNumber: number, chatId: string | null = null): Promise<void> {
  await ensureStateDir();
  const filePath = getStateFilePath(prNumber);

  // Check idempotency: if state file already exists, return it
  try {
    const existing = await readFile(filePath, 'utf-8');
    const state = parseStateFile(existing, filePath);
    console.log(JSON.stringify(state, null, 2));
    return;
  } catch {
    // File doesn't exist — proceed to create
  }

  const state = createPRState(prNumber, chatId);
  await atomicWrite(filePath, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify(state, null, 2));
}

/**
 * mark: Update a PR's state field.
 * Output: JSON of the updated state file.
 */
export async function markState(prNumber: number, newState: PRState): Promise<void> {
  const filePath = getStateFilePath(prNumber);

  // Read current state
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    console.error(`ERROR: State file not found for PR #${prNumber}: ${filePath}`);
    process.exit(1);
  }

  const state = parseStateFile(content, filePath);
  state.state = newState;
  state.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify(state, null, 2));
}

/**
 * status: List all tracked PRs grouped by state.
 * Output: Human-readable text.
 */
export async function status(): Promise<void> {
  const stateDir = resolve(getStateDir());

  const byState: Record<string, PRStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  try {
    const files = await readdir(stateDir);
    const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      const filePath = resolve(stateDir, fileName);
      try {
        const content = await readFile(filePath, 'utf-8');
        const state = parseStateFile(content, filePath);
        if (byState[state.state]) {
          byState[state.state].push(state);
        }
      } catch {
        console.error(`WARN: Skipping corrupted file: ${filePath}`);
      }
    }
  } catch {
    // Directory doesn't exist
  }

  const total = Object.values(byState).flat().length;
  console.log(`PR Scanner Status (${total} tracked PRs)\n`);

  for (const [state, prs] of Object.entries(byState)) {
    if (prs.length === 0) {
      console.log(`  ${state}: (none)`);
    } else {
      console.log(`  ${state}:`);
      for (const pr of prs) {
        const chatIdStr = pr.chatId ?? 'no chat';
        const age = formatAge(pr.createdAt);
        const expires = formatAge(pr.expiresAt);
        console.log(`    #${pr.prNumber} — ${chatIdStr} — age: ${age}, expires in: ${expires}`);
      }
    }
  }
}

/** Format a timestamp as a human-readable age string. */
function formatAge(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = Math.abs(now - then);
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

/** Delete a state file (used in tests for cleanup). */
export async function deleteStateFile(prNumber: number): Promise<void> {
  const filePath = getStateFilePath(prNumber);
  try {
    await unlink(filePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

// ---- CLI ----

function printHelp(): void {
  console.log(`PR Scanner v2 — Deterministic CLI tool

Usage: npx tsx scanner.ts --action <action> [options]

Actions:
  check-capacity              Count reviewing PRs, report available slots
  list-candidates             Discover untracked open PRs
  create-state                Create initial state file for a PR
  mark                        Update a PR's state field
  status                      List all tracked PRs grouped by state

Options:
  --action <action>           Action to perform (required)
  --pr <number>               PR number (required for create-state, mark)
  --chat-id <id>              Chat ID for create-state (optional)
  --state <state>             New state for mark (reviewing|approved|closed)
  -h, --help                  Show this help message

Environment:
  STATE_DIR                   State directory (default: .temp-chats)
  GH_REPO                     GitHub repo for list-candidates (default: hs3180/disclaude)
  MAX_CONCURRENT              Max concurrent reviewing PRs (default: 3)
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action' && args[i + 1]) {
      parsed.action = args[++i];
    } else if (args[i] === '--pr' && args[i + 1]) {
      parsed.pr = args[++i];
    } else if (args[i] === '--state' && args[i + 1]) {
      parsed.state = args[++i];
    } else if (args[i] === '--chat-id' && args[i + 1]) {
      parsed.chatId = args[++i];
    } else if (args[i] === '-h' || args[i] === '--help') {
      parsed.help = 'true';
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.action) {
    console.error('ERROR: --action is required. Use --help for usage.');
    process.exit(1);
  }

  switch (args.action) {
    case 'check-capacity':
      await checkCapacity();
      break;

    case 'list-candidates':
      await listCandidates();
      break;

    case 'create-state': {
      if (!args.pr) {
        console.error('ERROR: --pr is required for create-state');
        process.exit(1);
      }
      const prNumber = parseInt(args.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid PR number: ${args.pr}`);
        process.exit(1);
      }
      await createState(prNumber, args.chatId ?? null);
      break;
    }

    case 'mark': {
      if (!args.pr) {
        console.error('ERROR: --pr is required for mark');
        process.exit(1);
      }
      if (!args.state) {
        console.error('ERROR: --state is required for mark');
        process.exit(1);
      }
      if (!isValidState(args.state)) {
        console.error(`ERROR: Invalid state '${args.state}'. Must be one of: ${VALID_STATES.join(', ')}`);
        process.exit(1);
      }
      const prNumber = parseInt(args.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid PR number: ${args.pr}`);
        process.exit(1);
      }
      await markState(prNumber, args.state);
      break;
    }

    case 'status':
      await status();
      break;

    default:
      console.error(`ERROR: Unknown action '${args.action}'. Use --help for usage.`);
      process.exit(1);
  }
}

// Only run main when executed directly (not imported)
const isDirectRun = process.argv[1]?.includes('scanner.ts');
if (isDirectRun) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
