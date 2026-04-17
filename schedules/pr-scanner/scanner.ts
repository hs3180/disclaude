#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner state management CLI.
 *
 * Provides deterministic logic for Schedule Prompt to manage PR review state.
 * State files are stored in `.temp-chats/` as JSON files.
 *
 * Usage:
 *   npx tsx scanner.ts --action check-capacity
 *   npx tsx scanner.ts --action list-candidates
 *   npx tsx scanner.ts --action create-state --pr 123 --chatId oc_xxx
 *   npx tsx scanner.ts --action mark --pr 123 --state approved
 *   npx tsx scanner.ts --action status
 *
 * Environment variables (optional):
 *   PR_SCANNER_MAX_REVIEWING  Max concurrent reviewing PRs (default: 3)
 *   PR_SCANNER_DIR            State file directory (default: .temp-chats)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid arguments, I/O failure)
 */

import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

// ---- Types ----

/** PR scanner state values — strictly follows design spec §3.1 */
export type PrState = 'reviewing' | 'approved' | 'closed';

/** State file schema — strictly follows design spec §3.1 */
export interface PrStateFile {
  prNumber: number;
  chatId: string | null;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Phase 2 field — always null in Phase 1 */
  disbandRequested: null;
}

/** check-capacity output */
export interface CapacityResult {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

/** list-candidates output item */
export interface CandidatePr {
  number: number;
  title: string;
  author: string;
  hasStateFile: boolean;
  hasLabel: boolean;
}

// ---- Constants ----

export const DEFAULT_MAX_REVIEWING = 3;
export const DEFAULT_STATE_DIR = '.temp-chats';
export const EXPIRY_HOURS = 48;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const VALID_STATES: readonly PrState[] = ['reviewing', 'approved', 'closed'] as const;

/** Resolve state directory — reads env var at call time for testability */
export function getStateDir(): string {
  return process.env.PR_SCANNER_DIR || DEFAULT_STATE_DIR;
}

// ---- Helpers ----

/** Get current UTC timestamp in ISO 8601 Z-suffix format (no milliseconds) */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Compute expiry time (createdAt + EXPIRY_HOURS) */
export function computeExpiry(createdAt: string): string {
  const created = new Date(createdAt);
  const expires = new Date(created.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
  return expires.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Validate a PR number is a positive integer */
export function validatePrNumber(raw: string): number {
  const num = parseInt(raw, 10);
  if (!Number.isFinite(num) || num <= 0 || raw !== String(num)) {
    throw new Error(`Invalid PR number: '${raw}' (must be a positive integer)`);
  }
  return num;
}

/** Validate a state value */
export function validateState(raw: string): PrState {
  if (!VALID_STATES.includes(raw as PrState)) {
    throw new Error(`Invalid state: '${raw}' (must be one of: ${VALID_STATES.join(', ')})`);
  }
  return raw as PrState;
}

/** Get state file path for a PR number */
export function stateFilePath(prNumber: number, stateDir?: string): string {
  const dir = stateDir ?? getStateDir();
  return resolve(dir, `pr-${prNumber}.json`);
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

/** Ensure state directory exists */
export async function ensureStateDir(stateDir?: string): Promise<string> {
  const dir = stateDir ?? getStateDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---- Core Logic ----

/**
 * Parse and validate a state file from JSON string.
 * Throws on invalid schema.
 */
export function parseStateFile(json: string, filePath: string): PrStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`State file '${filePath}' is not valid JSON`);
  }
  return validateStateFileData(data, filePath);
}

/** Validate the structure of a parsed state file object */
export function validateStateFileData(data: unknown, filePath: string): PrStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`State file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || !Number.isFinite(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId' (must be string or null)`);
  }

  if (!VALID_STATES.includes(obj.state as PrState)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}' (must be: ${VALID_STATES.join(', ')})`);
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

/** Create a new state file for a PR */
export function createStateFile(prNumber: number, chatId: string | null): PrStateFile {
  const now = nowISO();
  return {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: computeExpiry(now),
    disbandRequested: null,
  };
}

/** Read all state files from the state directory */
async function readAllStateFiles(stateDir: string): Promise<PrStateFile[]> {
  const results: PrStateFile[] = [];
  try {
    const files = await readdir(stateDir);
    const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      try {
        const content = await readFile(resolve(stateDir, fileName), 'utf-8');
        results.push(parseStateFile(content, fileName));
      } catch {
        // Skip corrupted files
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return results;
}

// ---- Action Handlers ----

/** check-capacity: count reviewing PRs */
export async function actionCheckCapacity(stateDir?: string): Promise<void> {
  const dir = stateDir ?? getStateDir();
  const maxConcurrent = parseInt(
    process.env.PR_SCANNER_MAX_REVIEWING || String(DEFAULT_MAX_REVIEWING),
    10,
  );

  const states = await readAllStateFiles(dir);
  const reviewing = states.filter((s) => s.state === 'reviewing').length;

  const result: CapacityResult = {
    reviewing,
    maxConcurrent,
    available: Math.max(0, maxConcurrent - reviewing),
  };
  console.log(JSON.stringify(result, null, 2));
}

/** list-candidates: list PRs that don't have state files */
export async function actionListCandidates(stateDir?: string): Promise<void> {
  // This action requires `gh` CLI to fetch PRs from GitHub.
  // It calls `gh pr list` and filters out PRs that already have state files.
  // For offline testing, this action is tested with mocked gh output.

  const dir = stateDir ?? getStateDir();

  const existingPrNumbers = new Set<number>();
  try {
    const files = await readdir(dir);
    const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      const match = fileName.match(/^pr-(\d+)\.json$/);
      if (match) existingPrNumbers.add(parseInt(match[1], 10));
    }
  } catch {
    // Directory doesn't exist — no existing state files
  }

  // Use gh CLI to list open PRs
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  let ghOutput: string;
  try {
    const result = await execFileAsync('gh', [
      'pr', 'list',
      '--state', 'open',
      '--json', 'number,title,author,labels',
      '--limit', '50',
    ], { timeout: 30000 });
    ghOutput = result.stdout;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list PRs via gh CLI: ${errorMsg}`);
  }

  let prs: Array<{ number: number; title: string; author: { login: string }; labels: Array<{ name: string }> }>;
  try {
    prs = JSON.parse(ghOutput);
  } catch {
    throw new Error(`Failed to parse gh pr list output: ${ghOutput.substring(0, 200)}`);
  }

  const REVIEWING_LABEL = 'pr-scanner:reviewing';
  const PROCESSED_LABEL = 'pr-scanner:processed';

  const candidates: CandidatePr[] = prs
    .filter((pr) => {
      const hasStateFile = existingPrNumbers.has(pr.number);
      const hasLabel = (pr.labels || []).some(
        (l) => l.name === REVIEWING_LABEL || l.name === PROCESSED_LABEL,
      );
      return !hasStateFile && !hasLabel;
    })
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login ?? 'unknown',
      hasStateFile: false,
      hasLabel: false,
    }));

  console.log(JSON.stringify(candidates, null, 2));
}

/** create-state: create a new state file for a PR */
export async function actionCreateState(prNumber: number, chatId: string | null, stateDir?: string): Promise<void> {
  const dir = await ensureStateDir(stateDir);
  const filePath = stateFilePath(prNumber, dir);

  // Check if state file already exists (idempotent)
  try {
    const existing = await readFile(filePath, 'utf-8');
    const state = parseStateFile(existing, filePath);
    console.log(JSON.stringify(state, null, 2));
    return;
  } catch {
    // File doesn't exist — proceed to create
  }

  const stateFile = createStateFile(prNumber, chatId);
  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  console.log(JSON.stringify(stateFile, null, 2));
}

/** mark: update state field of an existing state file */
export async function actionMark(prNumber: number, newState: PrState, stateDir?: string): Promise<void> {
  const dir = stateDir ?? getStateDir();
  const filePath = stateFilePath(prNumber, dir);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`State file not found for PR #${prNumber} (expected: ${filePath})`);
  }

  const stateFile = parseStateFile(content, filePath);
  stateFile.state = newState;
  stateFile.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  console.log(JSON.stringify(stateFile, null, 2));
}

/** status: list all tracked PRs, grouped by state */
export async function actionStatus(stateDir?: string): Promise<void> {
  const dir = stateDir ?? getStateDir();
  const grouped: Record<PrState, PrStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };
  const corrupted: string[] = [];

  try {
    const files = await readdir(dir);
    const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      const filePath = resolve(dir, fileName);
      try {
        const content = await readFile(filePath, 'utf-8');
        const state = parseStateFile(content, filePath);
        grouped[state.state].push(state);
      } catch {
        corrupted.push(fileName);
      }
    }
  } catch {
    // Directory doesn't exist
  }

  // Output human-readable text
  const lines: string[] = [];

  for (const state of VALID_STATES) {
    const items = grouped[state];
    if (items.length === 0) continue;
    lines.push(`[${state}] (${items.length})`);
    for (const item of items) {
      lines.push(`  PR #${item.prNumber} — chatId: ${item.chatId ?? 'N/A'} — updated: ${item.updatedAt}`);
    }
  }

  if (corrupted.length > 0) {
    lines.push(`[corrupted] (${corrupted.length})`);
    for (const f of corrupted) {
      lines.push(`  ${f}`);
    }
  }

  if (lines.length === 0) {
    lines.push('No tracked PRs.');
  }

  console.log(lines.join('\n'));
}

// ---- CLI Entry Point ----

function exitWithUsage(msg?: string): never {
  const usage = [
    'Usage: npx tsx scanner.ts --action <action> [options]',
    '',
    'Actions:',
    '  check-capacity              Count reviewing PRs vs max capacity',
    '  list-candidates             List open PRs without state files',
    '  create-state --pr <N> [--chatId <id>]  Create state file for PR',
    '  mark --pr <N> --state <s>   Update PR state (reviewing|approved|closed)',
    '  status                      List all tracked PRs by state',
    '',
    'Options:',
    '  --pr <number>     PR number (positive integer)',
    '  --chatId <id>     Chat ID for discussion group',
    '  --state <s>       New state (reviewing|approved|closed)',
    '  --dir <path>      State file directory (default: .temp-chats)',
  ];
  if (msg) {
    console.error(`ERROR: ${msg}`);
  }
  console.error(usage.join('\n'));
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Find --action
  const actionIdx = args.indexOf('--action');
  if (actionIdx === -1 || actionIdx + 1 >= args.length) {
    exitWithUsage('Missing --action argument');
  }
  const action = args[actionIdx + 1];

  // Parse --dir override
  const dirIdx = args.indexOf('--dir');
  if (dirIdx !== -1 && dirIdx + 1 < args.length) {
    process.env.PR_SCANNER_DIR = args[dirIdx + 1];
  }

  // Parse --pr
  let prNumber: number | undefined;
  const prIdx = args.indexOf('--pr');
  if (prIdx !== -1 && prIdx + 1 < args.length) {
    prNumber = validatePrNumber(args[prIdx + 1]);
  }

  // Parse --chatId
  let chatId: string | null = null;
  const chatIdIdx = args.indexOf('--chatId');
  if (chatIdIdx !== -1 && chatIdIdx + 1 < args.length) {
    chatId = args[chatIdIdx + 1];
  }

  // Parse --state
  let newState: PrState | undefined;
  const stateIdx = args.indexOf('--state');
  if (stateIdx !== -1 && stateIdx + 1 < args.length) {
    newState = validateState(args[stateIdx + 1]);
  }

  // Route to action handler
  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity();
      break;

    case 'list-candidates':
      await actionListCandidates();
      break;

    case 'create-state':
      if (prNumber === undefined) exitWithUsage('--pr is required for create-state');
      await actionCreateState(prNumber, chatId);
      break;

    case 'mark':
      if (prNumber === undefined) exitWithUsage('--pr is required for mark');
      if (newState === undefined) exitWithUsage('--state is required for mark');
      await actionMark(prNumber, newState);
      break;

    case 'status':
      await actionStatus();
      break;

    default:
      exitWithUsage(`Unknown action: '${action}'`);
  }
}

// Only run main() when executed directly (not when imported by tests)
const isMainModule = process.argv[1]?.replace(/\.ts$/, '')?.endsWith('scanner');
if (isMainModule) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
