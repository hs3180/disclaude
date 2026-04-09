#!/usr/bin/env tsx
/**
 * schedule/pr-scanner-lifecycle.ts — Discussion group lifecycle management.
 *
 * Manages expired PR discussion groups: detects expired entries,
 * tracks disband requests (with 24h cooldown), and provides cleanup.
 *
 * CLI actions:
 *   check-expired  — scan .temp-chats/ for expired PRs needing disband
 *   mark-disband   — set disbandRequested timestamp for a PR
 *
 * Environment variables (optional):
 *   PR_SCANNER_STATE_DIR      State directory (default: .temp-chats)
 *   LIFECYCLE_DISBAND_COOLDOWN_HOURS  Hours between disband requests (default: 24)
 *   LIFECYCLE_SKIP_LARK_CHECK Set to '1' to skip lark-cli check (for testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, missing deps)
 */

import { readdir, readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
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
  disbandRequested: string | null;
}

export interface ExpiredPR {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  expiresAt: string;
  disbandRequested: string | null;
  needsDisband: boolean;
}

// ---- Constants ----

export const DEFAULT_STATE_DIR = '.temp-chats';
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
export const DEFAULT_DISBAND_COOLDOWN_HOURS = 24;
const VALID_STATES: PRState[] = ['reviewing', 'approved', 'closed'];
const LARK_TIMEOUT_MS = 30_000;

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function nowISO(): string {
  return new Date().toISOString();
}

function stateFilePath(dir: string, prNumber: number): string {
  return resolve(dir, `pr-${prNumber}.json`);
}

/**
 * Atomic file write: write to temp file then rename.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/**
 * Validate and parse a state file from JSON string.
 * Accepts disbandRequested as string | null (Phase 2 format).
 */
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

  if (!isValidPRState(obj.state)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
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

  // chatId can be null or string
  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }

  // disbandRequested can be null or ISO string (Phase 2)
  if (obj.disbandRequested !== null) {
    if (typeof obj.disbandRequested !== 'string' || !UTC_DATETIME_REGEX.test(obj.disbandRequested)) {
      throw new Error(`State file '${filePath}' has invalid 'disbandRequested'`);
    }
  }

  return data as PRStateFile;
}

function isValidPRState(value: unknown): value is PRState {
  return typeof value === 'string' && VALID_STATES.includes(value as PRState);
}

/**
 * Read all state files from the state directory.
 */
async function readAllStates(stateDir: string): Promise<PRStateFile[]> {
  const states: PRStateFile[] = [];

  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch {
    return states;
  }

  const jsonFiles = files.filter(f => f.startsWith('pr-') && f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = resolve(stateDir, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      const state = parseStateFile(content, filePath);
      states.push(state);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`WARN: Skipping corrupted state file '${fileName}': ${msg}`);
    }
  }

  return states;
}

/**
 * Parse CLI arguments into a structured object.
 */
export function parseArgs(argv: string[]): {
  action: string;
  pr: number | null;
} {
  const args = argv.slice(2); // skip node + script
  let action = '';
  let pr: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--action':
        action = args[++i] ?? '';
        break;
      case '--pr':
        pr = parseInt(args[++i] ?? '', 10);
        if (!Number.isFinite(pr) || pr <= 0) {
          exit(`Invalid --pr value: must be a positive integer`);
        }
        break;
      default:
        if (!action) {
          // Support positional action
          action = arg;
        } else {
          exit(`Unknown argument: ${arg}`);
        }
        break;
    }
  }

  return { action, pr };
}

// ---- Actions ----

/**
 * check-expired: Find expired PRs that may need disband request.
 *
 * Returns JSON array of ExpiredPR objects. An entry has needsDisband=true when:
 * - The PR is expired (now > expiresAt)
 * - AND the state is 'reviewing'
 * - AND either disbandRequested is null OR cooldown has elapsed (>= 24h)
 */
async function actionCheckExpired(
  stateDir: string,
  cooldownHours: number,
): Promise<void> {
  const states = await readAllStates(stateDir);
  const now = Date.now();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;

  const expired: ExpiredPR[] = [];

  for (const s of states) {
    const expiresAtMs = new Date(s.expiresAt).getTime();

    // Only consider reviewing PRs that are expired
    if (s.state !== 'reviewing') continue;
    if (expiresAtMs > now) continue;

    // Check disband cooldown
    let needsDisband = false;
    if (s.disbandRequested === null) {
      // Never sent a disband request
      needsDisband = true;
    } else {
      // Check if cooldown has elapsed since last request
      const lastRequestMs = new Date(s.disbandRequested).getTime();
      if (now - lastRequestMs >= cooldownMs) {
        needsDisband = true;
      }
    }

    expired.push({
      prNumber: s.prNumber,
      chatId: s.chatId,
      state: s.state,
      expiresAt: s.expiresAt,
      disbandRequested: s.disbandRequested,
      needsDisband,
    });
  }

  console.log(JSON.stringify(expired, null, 2));
}

/**
 * mark-disband: Update disbandRequested timestamp for a PR.
 */
async function actionMarkDisband(
  stateDir: string,
  prNumber: number,
): Promise<void> {
  const filePath = stateFilePath(stateDir, prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    exit(`State file for PR #${prNumber} not found: ${filePath}`);
  }

  const stateFile = parseStateFile(content, filePath);

  // Only allow disband for reviewing PRs
  if (stateFile.state !== 'reviewing') {
    exit(`Cannot mark disband for PR #${prNumber}: state is '${stateFile.state}', expected 'reviewing'`);
  }

  stateFile.disbandRequested = nowISO();
  stateFile.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2));

  console.log(JSON.stringify(stateFile, null, 2));
}

// ---- Main ----

async function main(): Promise<void> {
  const { action, pr } = parseArgs(process.argv);

  // Resolve configuration from environment
  const stateDir = resolve(process.env.PR_SCANNER_STATE_DIR ?? DEFAULT_STATE_DIR);
  const cooldownHours = parseInt(
    process.env.LIFECYCLE_DISBAND_COOLDOWN_HOURS ?? '',
    10,
  ) || DEFAULT_DISBAND_COOLDOWN_HOURS;

  // Ensure state directory exists
  await mkdir(stateDir, { recursive: true });

  switch (action) {
    case 'check-expired':
      await actionCheckExpired(stateDir, cooldownHours);
      break;

    case 'mark-disband':
      if (pr === null) exit('--pr is required for mark-disband action');
      await actionMarkDisband(stateDir, pr);
      break;

    case '':
      exit('No action specified. Usage: pr-scanner-lifecycle.ts <action> [--pr <number>]');

    default:
      exit(`Unknown action: '${action}'. Valid actions: check-expired, mark-disband`);
  }
}

// Run if executed directly (not imported)
const isDirectRun = process.argv[1]?.endsWith('pr-scanner-lifecycle.ts') ||
  process.argv[1]?.endsWith('pr-scanner-lifecycle.js');
if (isDirectRun) {
  main().catch(err => {
    console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
