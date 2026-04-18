#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner deterministic CLI tool.
 *
 * Provides state file management for PR tracking. Designed to be called by
 * the Schedule Prompt (pr-scanner.md) with all data passed via CLI args.
 *
 * No external dependencies — uses only Node.js built-ins.
 * No GitHub API calls — fully offline-testable.
 *
 * Usage:
 *   npx tsx scanner.ts --action check-capacity [--max-concurrent N]
 *   npx tsx scanner.ts --action list-candidates --pr-list 1,2,3
 *   npx tsx scanner.ts --action create-state --pr 123 [--chat-id oc_xxx]
 *   npx tsx scanner.ts --action mark --pr 123 --state approved
 *   npx tsx scanner.ts --action status
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, file system failure)
 */

import { readdir, readFile, writeFile, mkdir, stat, realpath, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// ---- Types ----

export type PrState = 'reviewing' | 'approved' | 'closed';

export interface PrStateFile {
  prNumber: number;
  chatId: string | null;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null; // Phase 2: always null
}

interface CheckCapacityResult {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

interface ListCandidatesResult {
  candidates: number[];
  excluded: number[];
}

// ---- Constants ----

export const TEMP_CHATS_DIR = '.temp-chats';
export const PR_FILE_PREFIX = 'pr-';
export const PR_FILE_SUFFIX = '.json';
export const DEFAULT_MAX_CONCURRENT = 5;
export const EXPIRY_HOURS = 48;

export const VALID_STATES: readonly PrState[] = ['reviewing', 'approved', 'closed'] as const;

// ---- Validation helpers ----

export class ScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerError';
  }
}

function isValidPrState(state: string): state is PrState {
  return VALID_STATES.includes(state as PrState);
}

function validatePrNumber(pr: unknown): number {
  if (typeof pr !== 'string') {
    throw new ScannerError('--pr is required and must be a number');
  }
  const num = parseInt(pr, 10);
  if (!Number.isFinite(num) || num <= 0) {
    throw new ScannerError(`Invalid PR number: '${pr}' — must be a positive integer`);
  }
  return num;
}

function validateState(state: unknown): PrState {
  if (typeof state !== 'string') {
    throw new ScannerError('--state is required');
  }
  if (!isValidPrState(state)) {
    throw new ScannerError(`Invalid state: '${state}' — must be one of: ${VALID_STATES.join(', ')}`);
  }
  return state;
}

// ---- File helpers ----

/** Get the path to a PR state file */
export function prFilePath(prNumber: number): string {
  return resolve(TEMP_CHATS_DIR, `${PR_FILE_PREFIX}${prNumber}${PR_FILE_SUFFIX}`);
}

/** Ensure the .temp-chats directory exists */
async function ensureDir(): Promise<string> {
  const dir = resolve(TEMP_CHATS_DIR);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code !== 'EEXIST') throw err;
  }
  return dir;
}

/** Atomic file write: write to temp file then rename */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.${process.pid}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Read and parse a PR state file */
export async function readPrState(filePath: string): Promise<PrStateFile> {
  const content = await readFile(filePath, 'utf-8');
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new ScannerError(`State file '${filePath}' is not valid JSON`);
  }
  return validatePrStateFile(data, filePath);
}

/** Validate a PR state file object */
export function validatePrStateFile(data: unknown, filePath: string): PrStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ScannerError(`State file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || !Number.isFinite(obj.prNumber) || obj.prNumber <= 0) {
    throw new ScannerError(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  if (!isValidPrState(obj.state as string)) {
    throw new ScannerError(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }

  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new ScannerError(`State file '${filePath}' has invalid 'chatId'`);
  }

  if (typeof obj.createdAt !== 'string') {
    throw new ScannerError(`State file '${filePath}' has invalid or missing 'createdAt'`);
  }

  if (typeof obj.updatedAt !== 'string') {
    throw new ScannerError(`State file '${filePath}' has invalid or missing 'updatedAt'`);
  }

  if (typeof obj.expiresAt !== 'string') {
    throw new ScannerError(`State file '${filePath}' has invalid or missing 'expiresAt'`);
  }

  // disbandRequested must be null in Phase 1
  if (obj.disbandRequested !== null) {
    throw new ScannerError(`State file '${filePath}' has invalid 'disbandRequested' — must be null in Phase 1`);
  }

  return data as PrStateFile;
}

/** Create a new PR state file */
function createPrStateFile(prNumber: number, chatId: string | null): PrStateFile {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  return {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: expires,
    disbandRequested: null,
  };
}

// ---- Actions ----

/** check-capacity: count reviewing PRs and report capacity */
async function actionCheckCapacity(maxConcurrent: number): Promise<CheckCapacityResult> {
  const dir = await ensureDir();
  let reviewing = 0;

  try {
    const files = await readdir(dir);
    const prFiles = files.filter(
      (f) => f.startsWith(PR_FILE_PREFIX) && f.endsWith(PR_FILE_SUFFIX),
    );

    for (const file of prFiles) {
      try {
        const state = await readPrState(resolve(dir, file));
        if (state.state === 'reviewing') reviewing++;
      } catch {
        // Skip corrupted files — they don't count toward capacity
      }
    }
  } catch {
    // Directory doesn't exist or not readable — zero reviewing
  }

  const available = Math.max(0, maxConcurrent - reviewing);
  return { reviewing, maxConcurrent, available };
}

/** list-candidates: filter PR list to those without state files */
async function actionListCandidates(prNumbers: number[]): Promise<ListCandidatesResult> {
  const dir = resolve(TEMP_CHATS_DIR);
  const trackedPrs = new Set<number>();

  try {
    const canonicalDir = await realpath(dir);
    const files = await readdir(canonicalDir);
    const prFiles = files.filter(
      (f) => f.startsWith(PR_FILE_PREFIX) && f.endsWith(PR_FILE_SUFFIX),
    );

    for (const file of prFiles) {
      // Extract PR number from filename: pr-{number}.json
      const match = file.match(new RegExp(`^${PR_FILE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)${PR_FILE_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      if (match) {
        trackedPrs.add(parseInt(match[1], 10));
      }
    }
  } catch {
    // Directory doesn't exist — no tracked PRs
  }

  const candidates = prNumbers.filter((pr) => !trackedPrs.has(pr));
  const excluded = prNumbers.filter((pr) => trackedPrs.has(pr));

  return { candidates, excluded };
}

/** create-state: create a new PR state file */
async function actionCreateState(prNumber: number, chatId: string | null): Promise<PrStateFile> {
  await ensureDir();
  const filePath = prFilePath(prNumber);

  // Check if file already exists
  try {
    await stat(filePath);
    throw new ScannerError(`State file for PR #${prNumber} already exists at '${filePath}'`);
  } catch (err: unknown) {
    if (err instanceof ScannerError) throw err;
    // File doesn't exist — proceed
  }

  const stateFile = createPrStateFile(prNumber, chatId);
  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  return stateFile;
}

/** mark: update the state of an existing PR state file */
async function actionMark(prNumber: number, newState: PrState): Promise<PrStateFile> {
  const filePath = prFilePath(prNumber);

  // Read existing state
  let existing: PrStateFile;
  try {
    existing = await readPrState(filePath);
  } catch (err: unknown) {
    if (err instanceof ScannerError) throw err;
    throw new ScannerError(`No state file found for PR #${prNumber} at '${filePath}'`);
  }

  const updated: PrStateFile = {
    ...existing,
    state: newState,
    updatedAt: new Date().toISOString(),
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  return updated;
}

/** status: list all tracked PRs grouped by state */
async function actionStatus(): Promise<Record<PrState, PrStateFile[]>> {
  const result: Record<PrState, PrStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  const dir = resolve(TEMP_CHATS_DIR);

  try {
    const canonicalDir = await realpath(dir);
    const files = await readdir(canonicalDir);
    const prFiles = files.filter(
      (f) => f.startsWith(PR_FILE_PREFIX) && f.endsWith(PR_FILE_SUFFIX),
    );

    for (const file of prFiles) {
      try {
        const state = await readPrState(resolve(canonicalDir, file));
        if (isValidPrState(state.state)) {
          result[state.state].push(state);
        }
      } catch {
        // Skip corrupted files
      }
    }
  } catch {
    // Directory doesn't exist — return empty result
  }

  // Sort each group by prNumber
  for (const key of VALID_STATES) {
    result[key].sort((a, b) => a.prNumber - b.prNumber);
  }

  return result;
}

// ---- CLI argument parsing ----

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
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

function formatStatusText(grouped: Record<PrState, PrStateFile[]>): string {
  const lines: string[] = ['PR Scanner Status:', '=================='];

  for (const state of VALID_STATES) {
    const items = grouped[state];
    lines.push('');
    lines.push(`[${state}] (${items.length})`);
    if (items.length === 0) {
      lines.push('  (none)');
    } else {
      for (const pr of items) {
        const age = formatAge(pr.updatedAt);
        const chatInfo = pr.chatId ? ` chat=${pr.chatId}` : '';
        lines.push(`  #${pr.prNumber}${chatInfo} (updated ${age})`);
      }
    }
  }

  return lines.join('\n');
}

function formatAge(isoTimestamp: string): string {
  try {
    const then = new Date(isoTimestamp).getTime();
    const diffMs = Date.now() - then;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ago`;
  } catch {
    return isoTimestamp;
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const action = args.action;
  if (!action) {
    throw new ScannerError('--action is required (check-capacity|list-candidates|create-state|mark|status)');
  }

  switch (action) {
    case 'check-capacity': {
      const maxConcurrent = args['max-concurrent']
        ? parseInt(args['max-concurrent'], 10)
        : DEFAULT_MAX_CONCURRENT;

      if (!Number.isFinite(maxConcurrent) || maxConcurrent <= 0) {
        throw new ScannerError('--max-concurrent must be a positive integer');
      }

      const result = await actionCheckCapacity(maxConcurrent);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'list-candidates': {
      if (!args['pr-list']) {
        throw new ScannerError('--pr-list is required (comma-separated PR numbers)');
      }
      const prNumbers = args['pr-list']
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => {
          const n = parseInt(s, 10);
          if (!Number.isFinite(n) || n <= 0) {
            throw new ScannerError(`Invalid PR number in --pr-list: '${s}'`);
          }
          return n;
        });

      const result = await actionListCandidates(prNumbers);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'create-state': {
      const prNumber = validatePrNumber(args.pr);
      const chatId = args['chat-id'] || null;
      const result = await actionCreateState(prNumber, chatId);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'mark': {
      const prNumber = validatePrNumber(args.pr);
      const state = validateState(args.state);
      const result = await actionMark(prNumber, state);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'status': {
      const grouped = await actionStatus();
      console.log(formatStatusText(grouped));
      break;
    }

    default:
      throw new ScannerError(`Unknown action: '${action}' — must be one of: check-capacity, list-candidates, create-state, mark, status`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${msg}`);
  process.exit(1);
});
