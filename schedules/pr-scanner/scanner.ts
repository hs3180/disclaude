#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner state management CLI.
 *
 * Provides deterministic state management for the PR Scanner v2 schedule.
 * All state is stored as JSON files in .temp-chats/ directory.
 *
 * Actions:
 *   check-capacity   Count reviewing PRs and report available slots
 *   list-candidates  Filter PR numbers that don't already have state files
 *   create-state     Create a new state file for a PR
 *   mark             Update the state field of an existing state file
 *   status           List all tracked PRs grouped by state
 *
 * Usage:
 *   npx tsx scanner.ts --action check-capacity [--max-concurrent 2]
 *   npx tsx scanner.ts --action list-candidates --prs 1,2,3
 *   npx tsx scanner.ts --action create-state --pr 123
 *   npx tsx scanner.ts --action mark --pr 123 --state approved
 *   npx tsx scanner.ts --action status
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, file I/O failure)
 */

import { readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

// ---- Types ----

/** Allowed state values per design spec §3.1 */
export type PRState = 'reviewing' | 'approved' | 'closed';

/** State file schema per design spec §3.1 */
export interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

/** Check-capacity output */
export interface CapacityReport {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

// ---- Constants ----

export const STATE_DIR = '.temp-chats';
export const DEFAULT_MAX_CONCURRENT = 2;
export const EXPIRY_HOURS = 48;
export const VALID_STATES: PRState[] = ['reviewing', 'approved', 'closed'];

// ---- Helpers ----

/** Get current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Calculate expiry timestamp (48h from now) */
export function expiryISO(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + EXPIRY_HOURS);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Get state file path for a PR number */
export function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

/** Atomic file write: write to temp file then rename */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  try {
    await rename(tmpFile, filePath);
  } catch (err) {
    // Clean up temp file on rename failure
    try { await unlink(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}

/** Parse and validate a state file from JSON string */
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
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }
  if (typeof obj.createdAt !== 'string' || !obj.createdAt) {
    throw new Error(`State file '${filePath}' has missing or invalid 'createdAt'`);
  }
  if (typeof obj.updatedAt !== 'string' || !obj.updatedAt) {
    throw new Error(`State file '${filePath}' has missing or invalid 'updatedAt'`);
  }
  if (typeof obj.expiresAt !== 'string' || !obj.expiresAt) {
    throw new Error(`State file '${filePath}' has missing or invalid 'expiresAt'`);
  }
  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }
  if (obj.disbandRequested != null && typeof obj.disbandRequested !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested'`);
  }

  return data as PRStateFile;
}

function isValidPRState(value: unknown): value is PRState {
  return typeof value === 'string' && VALID_STATES.includes(value as PRState);
}

// ---- Actions ----

/** check-capacity: count reviewing PRs and report available slots */
export async function checkCapacity(maxConcurrent: number): Promise<CapacityReport> {
  const reviewing = await countByState('reviewing');
  const available = Math.max(0, maxConcurrent - reviewing);
  return { reviewing, maxConcurrent, available };
}

/** list-candidates: filter PR numbers that don't already have state files */
export async function listCandidates(prNumbers: number[]): Promise<number[]> {
  const candidates: number[] = [];
  for (const pr of prNumbers) {
    const path = stateFilePath(pr);
    if (!existsSync(path)) {
      candidates.push(pr);
    }
  }
  return candidates;
}

/** create-state: create a new state file for a PR */
export async function createState(prNumber: number): Promise<PRStateFile> {
  const path = stateFilePath(prNumber);
  if (existsSync(path)) {
    throw new Error(`State file for PR #${prNumber} already exists: ${path}`);
  }

  const now = nowISO();
  const stateFile: PRStateFile = {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: expiryISO(),
    disbandRequested: null,
  };

  await atomicWrite(path, JSON.stringify(stateFile, null, 2) + '\n');
  return stateFile;
}

/** mark: update the state field of an existing state file */
export async function markState(prNumber: number, newState: PRState): Promise<PRStateFile> {
  const path = stateFilePath(prNumber);
  if (!existsSync(path)) {
    throw new Error(`State file for PR #${prNumber} not found: ${path}`);
  }

  const content = await readFile(path, 'utf-8');
  const stateFile = parseStateFile(content, path);

  stateFile.state = newState;
  stateFile.updatedAt = nowISO();

  await atomicWrite(path, JSON.stringify(stateFile, null, 2) + '\n');
  return stateFile;
}

/** status: list all tracked PRs grouped by state */
export async function getStatus(): Promise<Record<PRState, PRStateFile[]>> {
  const result: Record<PRState, PRStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  let files: string[];
  try {
    files = await readdir(STATE_DIR);
  } catch {
    // Directory doesn't exist — no tracked PRs
    return result;
  }

  const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = resolve(STATE_DIR, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      const stateFile = parseStateFile(content, filePath);
      result[stateFile.state].push(stateFile);
    } catch {
      // Skip corrupted files
    }
  }

  // Sort each group by prNumber
  for (const key of VALID_STATES) {
    result[key].sort((a, b) => a.prNumber - b.prNumber);
  }

  return result;
}

/** Count state files with a given state */
async function countByState(state: PRState): Promise<number> {
  let files: string[];
  try {
    files = await readdir(STATE_DIR);
  } catch {
    return 0;
  }

  let count = 0;
  const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = resolve(STATE_DIR, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      const stateFile = parseStateFile(content, filePath);
      if (stateFile.state === state) count++;
    } catch {
      // Skip corrupted files
    }
  }

  return count;
}

// ---- CLI ----

function printUsage(): never {
  console.error(`Usage: scanner.ts --action <action> [options]

Actions:
  check-capacity   Count reviewing PRs and report available slots
  list-candidates  Filter PR numbers without existing state files
  create-state     Create a new state file for a PR
  mark             Update the state field of an existing state file
  status           List all tracked PRs grouped by state

Options:
  --action <action>       Action to perform (required)
  --pr <number>           PR number (required for create-state, mark)
  --state <state>         New state: reviewing|approved|closed (required for mark)
  --prs <numbers>         Comma-separated PR numbers (required for list-candidates)
  --max-concurrent <n>    Max concurrent reviews (default: ${DEFAULT_MAX_CONCURRENT})`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].substring(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action;

  if (!action) {
    printUsage();
  }

  switch (action) {
    case 'check-capacity': {
      const maxConcurrent = args['max-concurrent']
        ? parseInt(args['max-concurrent'], 10)
        : DEFAULT_MAX_CONCURRENT;
      if (!Number.isFinite(maxConcurrent) || maxConcurrent < 0) {
        console.error('ERROR: --max-concurrent must be a non-negative integer');
        process.exit(1);
      }
      const report = await checkCapacity(maxConcurrent);
      console.log(JSON.stringify(report));
      break;
    }

    case 'list-candidates': {
      if (!args.prs) {
        console.error('ERROR: --prs is required for list-candidates (comma-separated PR numbers)');
        process.exit(1);
      }
      const prNumbers = args.prs.split(',').map((s) => {
        const n = parseInt(s.trim(), 10);
        if (!Number.isFinite(n) || n <= 0) {
          console.error(`ERROR: Invalid PR number '${s.trim()}'`);
          process.exit(1);
        }
        return n;
      });
      const candidates = await listCandidates(prNumbers);
      console.log(JSON.stringify(candidates));
      break;
    }

    case 'create-state': {
      if (!args.pr) {
        console.error('ERROR: --pr is required for create-state');
        process.exit(1);
      }
      const prNumber = parseInt(args.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error('ERROR: --pr must be a positive integer');
        process.exit(1);
      }
      try {
        const stateFile = await createState(prNumber);
        console.log(JSON.stringify(stateFile));
      } catch (err) {
        console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
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
      if (!isValidPRState(args.state)) {
        console.error(`ERROR: --state must be one of: ${VALID_STATES.join(', ')}`);
        process.exit(1);
      }
      const prNumber = parseInt(args.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error('ERROR: --pr must be a positive integer');
        process.exit(1);
      }
      try {
        const stateFile = await markState(prNumber, args.state as PRState);
        console.log(JSON.stringify(stateFile));
      } catch (err) {
        console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const grouped = await getStatus();
      // Human-readable output
      const lines: string[] = [];
      for (const state of VALID_STATES) {
        const items = grouped[state];
        if (items.length === 0) {
          lines.push(`${state}: (none)`);
        } else {
          lines.push(`${state}: ${items.map((f) => `#${f.prNumber}`).join(', ')}`);
        }
      }
      console.log(lines.join('\n'));
      break;
    }

    default:
      console.error(`ERROR: Unknown action '${action}'`);
      printUsage();
  }
}

// Only run main when executed directly (not imported for testing)
const isDirectRun = process.argv[1]?.includes('scanner.ts');
if (isDirectRun) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
