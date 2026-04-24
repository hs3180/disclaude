#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner CLI Script.
 *
 * Issue #2219: Provides deterministic logic for PR scanner schedule.
 * Operates on state files in `.temp-chats/pr-{number}.json`.
 *
 * CLI Interface (`--action` mode):
 *   --action check-capacity              Count reviewing PRs and report availability
 *   --action list-candidates             List open PRs not yet tracked
 *   --action create-state --pr <number>  Create a new state file for a PR
 *   --action mark --pr <number> --state <s>  Update state field of a PR
 *   --action status                      List all tracked PRs grouped by state
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (missing args, invalid input)
 */

import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

// ---- Types ----

export type PRState = 'reviewing' | 'approved' | 'closed';

export interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

// ---- Constants ----

export const DEFAULT_STATE_DIR = '.temp-chats';
export const VALID_STATES: PRState[] = ['reviewing', 'approved', 'closed'];
export const MAX_CONCURRENT = 3;
export const EXPIRY_HOURS = 48;

/**
 * Resolve the state directory.
 * Priority: PR_STATE_DIR env var > default `.temp-chats` relative to project root.
 */
export function getStateDir(): string {
  const envDir = process.env.PR_STATE_DIR;
  if (envDir) {
    return resolve(envDir);
  }
  return resolve(PROJECT_ROOT, DEFAULT_STATE_DIR);
}

// ---- Validation ----

export class ScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerError';
  }
}

function validatePRNumber(pr: unknown): number {
  const num = Number(pr);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new ScannerError(`Invalid PR number: '${pr}' — must be a positive integer`);
  }
  return num;
}

function validateState(state: unknown): PRState {
  if (typeof state !== 'string' || !VALID_STATES.includes(state as PRState)) {
    throw new ScannerError(`Invalid state: '${state}' — must be one of: ${VALID_STATES.join(', ')}`);
  }
  return state as PRState;
}

function parsePRStateFile(json: string, filePath: string): PRStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ScannerError(`State file '${filePath}' is not valid JSON`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ScannerError(`State file '${filePath}' is not a valid JSON object`);
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new ScannerError(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  if (!VALID_STATES.includes(obj.state as PRState)) {
    throw new ScannerError(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }

  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new ScannerError(`State file '${filePath}' has invalid 'chatId'`);
  }

  if (typeof obj.createdAt !== 'string') {
    throw new ScannerError(`State file '${filePath}' has missing or invalid 'createdAt'`);
  }

  if (typeof obj.updatedAt !== 'string') {
    throw new ScannerError(`State file '${filePath}' has missing or invalid 'updatedAt'`);
  }

  if (typeof obj.expiresAt !== 'string') {
    throw new ScannerError(`State file '${filePath}' has missing or invalid 'expiresAt'`);
  }

  if (obj.disbandRequested !== null && typeof obj.disbandRequested !== 'string') {
    throw new ScannerError(`State file '${filePath}' has invalid 'disbandRequested'`);
  }

  return data as PRStateFile;
}

// ---- Helpers ----

function nowISO(): string {
  return new Date().toISOString();
}

function stateFilePath(prNumber: number): string {
  return resolve(getStateDir(), `pr-${prNumber}.json`);
}

async function ensureStateDir(): Promise<void> {
  await mkdir(getStateDir(), { recursive: true });
}

/** Atomic write: write to temp file then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Read and parse a state file. Returns null if not found. */
async function readStateFile(prNumber: number): Promise<PRStateFile | null> {
  const filePath = stateFilePath(prNumber);
  try {
    const content = await readFile(filePath, 'utf-8');
    return parsePRStateFile(content, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** Read all state files from the state directory. */
async function readAllStateFiles(): Promise<PRStateFile[]> {
  const results: PRStateFile[] = [];
  const stateDir = getStateDir();
  try {
    const files = await readdir(stateDir);
    const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      const filePath = resolve(stateDir, fileName);
      try {
        const content = await readFile(filePath, 'utf-8');
        results.push(parsePRStateFile(content, filePath));
      } catch {
        // Skip corrupted files — they are logged during readStateFile
        console.error(`WARN: Skipping corrupted state file: ${filePath}`);
      }
    }
  } catch {
    // Directory doesn't exist — return empty
  }
  return results;
}

// ---- Actions ----

interface CapacityReport {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

async function actionCheckCapacity(): Promise<void> {
  const allStates = await readAllStateFiles();
  const reviewing = allStates.filter((s) => s.state === 'reviewing').length;
  const available = Math.max(0, MAX_CONCURRENT - reviewing);

  const report: CapacityReport = {
    reviewing,
    maxConcurrent: MAX_CONCURRENT,
    available,
  };

  console.log(JSON.stringify(report, null, 2));
}

async function actionListCandidates(): Promise<void> {
  // Get open PRs via gh CLI
  let ghOutput: string;
  try {
    const result = await execFileAsync(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'number,title,labels'],
      { maxBuffer: 1024 * 1024, timeout: 30_000 },
    );
    ghOutput = result.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ScannerError(`Failed to list open PRs: ${msg}`);
  }

  let prs: Array<{ number: number; title: string; labels?: Array<{ name: string }> }>;
  try {
    prs = JSON.parse(ghOutput);
  } catch {
    throw new ScannerError('Failed to parse gh pr list output');
  }

  // Get existing state files to filter out already-tracked PRs
  const allStates = await readAllStateFiles();
  const trackedPRs = new Set(allStates.map((s) => s.prNumber));

  // Filter out PRs with pr-scanner:processed or pr-scanner:pending labels
  const filtered = prs.filter((pr) => {
    if (trackedPRs.has(pr.number)) return false;
    const labelNames = (pr.labels ?? []).map((l) => l.name);
    if (labelNames.includes('pr-scanner:processed') || labelNames.includes('pr-scanner:pending')) {
      return false;
    }
    return true;
  });

  const candidates = filtered.map((pr) => ({
    number: pr.number,
    title: pr.title,
  }));

  console.log(JSON.stringify(candidates, null, 2));
}

async function actionCreateState(prNumber: number): Promise<void> {
  await ensureStateDir();

  // Check if state file already exists
  const existing = await readStateFile(prNumber);
  if (existing) {
    throw new ScannerError(`State file for PR #${prNumber} already exists (state: ${existing.state})`);
  }

  const now = nowISO();
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  const stateFile: PRStateFile = {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt,
    disbandRequested: null,
  };

  const filePath = stateFilePath(prNumber);
  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');

  console.log(JSON.stringify(stateFile, null, 2));
}

async function actionMark(prNumber: number, newState: PRState): Promise<void> {
  const existing = await readStateFile(prNumber);
  if (!existing) {
    throw new ScannerError(`No state file found for PR #${prNumber}`);
  }

  const updated: PRStateFile = {
    ...existing,
    state: newState,
    updatedAt: nowISO(),
  };

  const filePath = stateFilePath(prNumber);
  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');

  console.log(JSON.stringify(updated, null, 2));
}

async function actionStatus(): Promise<void> {
  const allStates = await readAllStateFiles();

  if (allStates.length === 0) {
    console.log('No tracked PRs.');
    return;
  }

  // Group by state
  const grouped: Record<PRState, PRStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  for (const state of allStates) {
    grouped[state.state].push(state);
  }

  const lines: string[] = [];
  for (const state of VALID_STATES) {
    const items = grouped[state];
    if (items.length > 0) {
      lines.push(`[${state}] (${items.length}):`);
      for (const item of items) {
        const age = formatAge(item.updatedAt);
        lines.push(`  PR #${item.prNumber} — updated ${age}`);
      }
    }
  }

  console.log(lines.join('\n'));
}

function formatAge(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// ---- CLI Entry Point ----

function parseArgs(args: string[]): {
  action: string;
  pr?: number;
  state?: PRState;
} {
  const actionIdx = args.indexOf('--action');
  if (actionIdx === -1 || actionIdx >= args.length - 1) {
    throw new ScannerError('Missing required argument: --action <action>');
  }
  const action = args[actionIdx + 1];

  let pr: number | undefined;
  const prIdx = args.indexOf('--pr');
  if (prIdx !== -1 && prIdx < args.length - 1) {
    pr = validatePRNumber(args[prIdx + 1]);
  }

  let state: PRState | undefined;
  const stateIdx = args.indexOf('--state');
  if (stateIdx !== -1 && stateIdx < args.length - 1) {
    state = validateState(args[stateIdx + 1]);
  }

  return { action, pr, state };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  switch (parsed.action) {
    case 'check-capacity':
      await actionCheckCapacity();
      break;

    case 'list-candidates':
      await actionListCandidates();
      break;

    case 'create-state':
      if (!parsed.pr) {
        throw new ScannerError('Missing required argument: --pr <number> for create-state');
      }
      await actionCreateState(parsed.pr);
      break;

    case 'mark':
      if (!parsed.pr) {
        throw new ScannerError('Missing required argument: --pr <number> for mark');
      }
      if (!parsed.state) {
        throw new ScannerError('Missing required argument: --state <state> for mark');
      }
      await actionMark(parsed.pr, parsed.state);
      break;

    case 'status':
      await actionStatus();
      break;

    default:
      throw new ScannerError(
        `Unknown action: '${parsed.action}' — valid actions: check-capacity, list-candidates, create-state, mark, status`,
      );
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
