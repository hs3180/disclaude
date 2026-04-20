#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/lifecycle.ts — Discussion group lifecycle management.
 *
 * Manages the lifecycle of PR discussion groups:
 * - Detecting expired discussions (now > expiresAt)
 * - Sending disband request cards with 24h deduplication
 * - Cleaning up state files, labels, and groups after confirmation
 *
 * Usage:
 *   npx tsx lifecycle.ts --action check-expired
 *   npx tsx lifecycle.ts --action mark-disband --pr 123
 *   npx tsx lifecycle.ts --action cleanup --pr 123
 *
 * Related: #2221
 */

import { readdir, readFile, unlink, mkdir } from 'node:fs/promises';
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
  /** ISO 8601 timestamp of last disband request, or null if never requested */
  disbandRequested: string | null;
}

/** Result of check-expired action */
export interface ExpiredPR {
  prNumber: number;
  chatId: string | null;
  expiresAt: string;
  disbandRequested: string | null;
  /** Whether we should send a new disband request (24h dedup passed) */
  shouldNotify: boolean;
}

// ---- Constants ----

/** Default directory for state files */
export const DEFAULT_DIR = '.temp-chats';

/** Minimum hours between disband notifications */
export const DISBAND_NOTIFY_INTERVAL_HOURS = 24;

/** Valid state values */
export const VALID_STATES: PRState[] = ['reviewing', 'approved', 'closed'];

// ---- Helpers ----

/** Get current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Build state file path */
export function stateFilePath(prNumber: number, dir: string = DEFAULT_DIR): string {
  return resolve(dir, `pr-${prNumber}.json`);
}

/** Atomic file write: write to temp file then rename */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  const { rename } = await import('node:fs/promises');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Parse and validate a state file JSON string */
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

  // prNumber
  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  // chatId
  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }

  // state
  if (!VALID_STATES.includes(obj.state as PRState)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }

  // timestamps
  const tsRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  for (const field of ['createdAt', 'updatedAt', 'expiresAt']) {
    if (typeof obj[field] !== 'string' || !tsRegex.test(obj[field] as string)) {
      throw new Error(`State file '${filePath}' has invalid or missing '${field}'`);
    }
  }

  // disbandRequested: string (ISO timestamp) or null
  if (obj.disbandRequested !== null) {
    if (typeof obj.disbandRequested !== 'string' || !tsRegex.test(obj.disbandRequested)) {
      throw new Error(`State file '${filePath}' has invalid 'disbandRequested' (must be ISO 8601 string or null)`);
    }
  }

  return data as PRStateFile;
}

/** Resolve the state directory */
export function getDir(): string {
  return process.env.PR_SCANNER_DIR || DEFAULT_DIR;
}

/** Get the repository from environment or default */
export function getRepo(): string {
  return process.env.PR_SCANNER_REPO || 'hs3180/disclaude';
}

/** Read all state files from the directory */
export async function readAllStates(dir: string = getDir()): Promise<PRStateFile[]> {
  const absDir = resolve(dir);
  let files: string[];
  try {
    files = await readdir(absDir);
  } catch {
    return [];
  }

  const states: PRStateFile[] = [];
  for (const fileName of files) {
    if (!fileName.match(/^pr-\d+\.json$/)) continue;

    const filePath = resolve(absDir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    try {
      states.push(parseStateFile(content, filePath));
    } catch (err) {
      console.error(`WARN: Skipping corrupted state file: ${filePath} — ${err instanceof Error ? err.message : err}`);
    }
  }

  return states;
}

/** Read a single state file */
async function readStateFile(prNumber: number, dir?: string): Promise<PRStateFile> {
  const filePath = stateFilePath(prNumber, dir ?? getDir());
  const content = await readFile(filePath, 'utf-8');
  return parseStateFile(content, filePath);
}

// ---- Actions ----

/**
 * check-expired: Find expired PR discussions that need attention.
 *
 * Returns JSON array of expired PRs with:
 * - prNumber, chatId, expiresAt, disbandRequested
 * - shouldNotify: true if 24h have passed since last notification (or never notified)
 */
export async function actionCheckExpired(dir?: string): Promise<ExpiredPR[]> {
  const states = await readAllStates(dir);
  const now = Date.now();
  const expired: ExpiredPR[] = [];

  for (const state of states) {
    // Only care about reviewing state (still active discussions)
    if (state.state !== 'reviewing') continue;

    const expiresAtMs = new Date(state.expiresAt).getTime();
    if (now <= expiresAtMs) continue; // Not expired yet

    // Check if we should send a notification (24h dedup)
    let shouldNotify = true;
    if (state.disbandRequested !== null) {
      const lastNotifiedMs = new Date(state.disbandRequested).getTime();
      const hoursSinceLastNotify = (now - lastNotifiedMs) / (1000 * 60 * 60);
      if (hoursSinceLastNotify < DISBAND_NOTIFY_INTERVAL_HOURS) {
        shouldNotify = false;
      }
    }

    expired.push({
      prNumber: state.prNumber,
      chatId: state.chatId,
      expiresAt: state.expiresAt,
      disbandRequested: state.disbandRequested,
      shouldNotify,
    });
  }

  console.log(JSON.stringify(expired, null, 2));
  return expired;
}

/**
 * mark-disband: Update the disbandRequested timestamp for a PR.
 * This records when a disband notification was last sent, enabling 24h dedup.
 */
export async function actionMarkDisband(
  prNumber: number,
  dir?: string,
): Promise<PRStateFile> {
  const actualDir = dir ?? getDir();
  const filePath = stateFilePath(prNumber, actualDir);

  // Read existing state
  let existing: PRStateFile;
  try {
    existing = await readStateFile(prNumber, actualDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`State file for PR #${prNumber} not found at ${filePath}`);
    }
    throw err;
  }

  // Only mark reviewing PRs for disband
  if (existing.state !== 'reviewing') {
    throw new Error(`Cannot mark disband for PR #${prNumber}: state is '${existing.state}', expected 'reviewing'`);
  }

  const updated: PRStateFile = {
    ...existing,
    disbandRequested: nowISO(),
    updatedAt: nowISO(),
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');

  console.log(JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * cleanup: Remove state file and GitHub label for a PR.
 * Called after the discussion group has been disbanded.
 */
export async function actionCleanup(
  prNumber: number,
  dir?: string,
  repo?: string,
): Promise<{ prNumber: number; labelRemoved: boolean; fileDeleted: boolean }> {
  const actualDir = dir ?? getDir();
  const actualRepo = repo ?? getRepo();
  const filePath = stateFilePath(prNumber, actualDir);

  // Verify state file exists and state is reviewing
  let state: PRStateFile;
  try {
    state = await readStateFile(prNumber, actualDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`State file for PR #${prNumber} not found at ${filePath}`);
    }
    throw err;
  }

  if (state.state !== 'reviewing') {
    throw new Error(
      `Cannot cleanup PR #${prNumber}: state is '${state.state}', expected 'reviewing'. ` +
      `Only reviewing discussions should be disbanded.`,
    );
  }

  // Remove GitHub label (best-effort, don't block on failure)
  let labelRemoved = false;
  try {
    await execFileAsync('gh', [
      'pr', 'edit',
      String(prNumber),
      '--repo', actualRepo,
      '--remove-label', 'pr-scanner:reviewing',
    ], { timeout: 30000 });
    labelRemoved = true;
  } catch (err) {
    console.error(
      `WARN: Failed to remove label from PR #${prNumber}: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }

  // Delete state file
  let fileDeleted = false;
  try {
    await unlink(filePath);
    fileDeleted = true;
  } catch (err) {
    console.error(
      `WARN: Failed to delete state file for PR #${prNumber}: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }

  const result = { prNumber, labelRemoved, fileDeleted };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ---- CLI ----

/** Simple CLI argument parser */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const action = args.action;

  if (!action) {
    console.error('Usage: lifecycle.ts --action <check-expired|mark-disband|cleanup> [options]');
    console.error('');
    console.error('Actions:');
    console.error('  check-expired         Find expired PR discussions needing attention');
    console.error('  mark-disband --pr N   Record disband notification timestamp for PR #N');
    console.error('  cleanup --pr N        Remove state file + label for disbanded PR #N');
    process.exit(1);
  }

  switch (action) {
    case 'check-expired':
      await actionCheckExpired();
      break;

    case 'mark-disband': {
      if (!args.pr) {
        console.error('ERROR: --pr is required for mark-disband action');
        process.exit(1);
      }
      const prNumber = parseInt(args.pr, 10);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid PR number: ${args.pr}`);
        process.exit(1);
      }
      await actionMarkDisband(prNumber);
      break;
    }

    case 'cleanup': {
      if (!args.pr) {
        console.error('ERROR: --pr is required for cleanup action');
        process.exit(1);
      }
      const prNumber = parseInt(args.pr, 10);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid PR number: ${args.pr}`);
        process.exit(1);
      }
      await actionCleanup(prNumber);
      break;
    }

    default:
      console.error(`ERROR: Unknown action '${action}'`);
      console.error('Valid actions: check-expired, mark-disband, cleanup');
      process.exit(1);
  }
}

// Only run main when executed directly (not imported)
const isMainModule = process.argv[1]?.includes('lifecycle.ts');
if (isMainModule) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
