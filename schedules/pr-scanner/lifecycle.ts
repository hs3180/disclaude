#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/lifecycle.ts — Discussion group lifecycle management.
 *
 * Manages the expiration and disbanding of PR discussion groups.
 * Works with the same `.temp-chats/` state files as scanner.ts, but extends
 * the `disbandRequested` field from `null` to `string | null` to track
 * when a disband request was sent.
 *
 * CLI Interface (--action mode):
 *   check-expired   Find expired PR state files (now > expiresAt)
 *   mark-disband    Set disbandRequested timestamp for a PR
 *   disband         Execute full disband (lark-cli + delete state + remove label)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, I/O failure)
 *
 * @see Issue #2221 — Discussion group lifecycle management (Phase 2)
 * @see Issue #2210 — PR Scanner v2 parent issue
 */

import { readdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ---- Types ----

/** Extended state file with disbandRequested as string | null (vs scanner.ts's null-only) */
export interface LifecycleStateFile {
  prNumber: number;
  chatId: string;
  state: 'reviewing' | 'approved' | 'closed';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

export interface ExpiredPR {
  prNumber: number;
  chatId: string;
  state: string;
  expiresAt: string;
  disbandRequested: string | null;
  /** true if disband was requested within the last 24 hours (dedup) */
  recentlyRequested: boolean;
}

export interface CheckExpiredResult {
  now: string;
  expired: ExpiredPR[];
}

// ---- Constants ----

export const STATE_DIR = '.temp-chats';
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const DISBAND_DEDUP_HOURS = 24;
export const REVIEWING_LABEL = 'pr-scanner:reviewing';
export const LARK_TIMEOUT_MS = 30_000;
export const VALID_STATES: readonly string[] = ['reviewing', 'approved', 'closed'];

// ---- Helpers (exported for testing) ----

/** Strip milliseconds from ISO timestamp */
function stripMs(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

/** Get current UTC timestamp in ISO 8601 Z-suffix format (no milliseconds) */
export function nowISO(): string {
  return stripMs(new Date().toISOString());
}

/** Get the state file path for a given PR number */
export function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

/** Validate a PR number (positive integer) */
export function isValidPRNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Check if disbandRequested was set within the dedup window (24h) */
export function isRecentlyRequested(
  disbandRequested: string | null,
  now: string,
  dedupHours: number = DISBAND_DEDUP_HOURS,
): boolean {
  if (!disbandRequested) return false;
  if (!UTC_DATETIME_REGEX.test(disbandRequested) || !UTC_DATETIME_REGEX.test(now)) return false;
  const requestedAt = new Date(disbandRequested).getTime();
  const nowMs = new Date(now).getTime();
  const diffHours = (nowMs - requestedAt) / (1000 * 60 * 60);
  return diffHours < dedupHours;
}

/** Atomic file write: write to temp file then rename */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

// ---- State File Operations (exported for testing) ----

/**
 * Parse a state file, allowing disbandRequested to be string | null.
 * This is more lenient than scanner.ts's parseStateFile which requires null.
 */
export function parseLifecycleStateFile(json: string, filePath: string): LifecycleStateFile {
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
  if (typeof obj.chatId !== 'string' || !obj.chatId) {
    throw new Error(`State file '${filePath}' has invalid or missing 'chatId'`);
  }
  if (!VALID_STATES.includes(obj.state as string)) {
    throw new Error(
      `State file '${filePath}' has invalid 'state': '${obj.state}' (must be reviewing|approved|closed)`,
    );
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
  if (obj.disbandRequested !== null && typeof obj.disbandRequested !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested' (must be null or ISO timestamp)`);
  }
  if (typeof obj.disbandRequested === 'string' && !UTC_DATETIME_REGEX.test(obj.disbandRequested)) {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested' timestamp format`);
  }

  return data as LifecycleStateFile;
}

/** Read and parse a lifecycle state file */
export async function readLifecycleStateFile(prNumber: number): Promise<LifecycleStateFile> {
  const filePath = stateFilePath(prNumber);
  const content = await readFile(filePath, 'utf-8');
  return parseLifecycleStateFile(content, filePath);
}

// ---- Core Actions (exported for testing) ----

/**
 * check-expired: Scan .temp-chats/ for expired PR state files.
 * Returns list of expired PRs with dedup info.
 */
export async function checkExpired(): Promise<CheckExpiredResult> {
  const now = nowISO();
  const expired: ExpiredPR[] = [];

  const dir = resolve(STATE_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // Directory doesn't exist
    return { now, expired: [] };
  }

  const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

  for (const fileName of jsonFiles) {
    const filePath = resolve(dir, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      const stateFile = parseLifecycleStateFile(content, filePath);

      // Check if expired (expiresAt < now)
      if (stateFile.expiresAt < now) {
        expired.push({
          prNumber: stateFile.prNumber,
          chatId: stateFile.chatId,
          state: stateFile.state,
          expiresAt: stateFile.expiresAt,
          disbandRequested: stateFile.disbandRequested,
          recentlyRequested: isRecentlyRequested(stateFile.disbandRequested, now),
        });
      }
    } catch {
      console.error(`WARN: Skipping corrupted state file: ${filePath}`);
    }
  }

  return { now, expired };
}

/**
 * mark-disband: Update disbandRequested timestamp for a PR.
 * Sets disbandRequested to current time.
 */
export async function markDisband(prNumber: number): Promise<LifecycleStateFile> {
  if (!isValidPRNumber(prNumber)) {
    throw new Error(`Invalid PR number: ${prNumber} (must be positive integer)`);
  }

  const filePath = stateFilePath(prNumber);
  const current = await readLifecycleStateFile(prNumber);

  const updated: LifecycleStateFile = {
    ...current,
    disbandRequested: nowISO(),
    updatedAt: nowISO(),
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  return updated;
}

// ---- External Dependencies ----

const execFileAsync = promisify(execFile);

/** Remove a GitHub label from a PR (non-blocking) */
async function removeLabel(
  prNumber: number,
  label: string,
  repo: string = 'hs3180/disclaude',
): Promise<boolean> {
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', repo,
      '--remove-label', label,
    ], { timeout: 30_000 });
    return true;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to remove label '${label}' from PR #${prNumber}: ${errMsg}`);
    return false;
  }
}

/** Dismiss a Feishu group via lark-cli */
async function dismissGroup(chatId: string): Promise<{ success: boolean; error: string | null }> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = execErr.stderr ?? execErr.message ?? 'unknown error';
    return { success: false, error: errorMsg.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() };
  }
}

/**
 * disband: Execute full disband workflow.
 * 1. Validate state is still reviewing
 * 2. Dismiss group via lark-cli
 * 3. Delete state file
 * 4. Remove reviewing label
 */
export async function disband(
  prNumber: number,
  repo: string = 'hs3180/disclaude',
  skipLark: boolean = false,
): Promise<{ success: boolean; steps: Record<string, boolean | string> }> {
  if (!isValidPRNumber(prNumber)) {
    throw new Error(`Invalid PR number: ${prNumber} (must be positive integer)`);
  }

  const steps: Record<string, boolean | string> = {};
  const filePath = stateFilePath(prNumber);

  // Step 1: Read current state
  let stateFile: LifecycleStateFile;
  try {
    stateFile = await readLifecycleStateFile(prNumber);
  } catch (err: unknown) {
    throw new Error(`Cannot read state file for PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
  }

  // Step 2: Validate state is reviewing
  if (stateFile.state !== 'reviewing') {
    throw new Error(`Cannot disband PR #${prNumber}: state is '${stateFile.state}', expected 'reviewing'`);
  }
  steps['validate_state'] = true;

  // Step 3: Dismiss group via lark-cli
  if (!skipLark && stateFile.chatId) {
    const result = await dismissGroup(stateFile.chatId);
    steps['dismiss_group'] = result.success;
    if (!result.success) {
      console.error(`WARN: Failed to dismiss group ${stateFile.chatId}: ${result.error}`);
      // Continue cleanup even if disband fails (group may already be dissolved)
    }
  } else {
    steps['dismiss_group'] = skipLark ? 'skipped' : true;
  }

  // Step 4: Delete state file
  try {
    await unlink(filePath);
    steps['delete_state'] = true;
  } catch (err: unknown) {
    console.error(`WARN: Failed to delete state file ${filePath}: ${err}`);
    steps['delete_state'] = false;
  }

  // Step 5: Remove reviewing label (non-blocking)
  const labelResult = await removeLabel(prNumber, REVIEWING_LABEL, repo);
  steps['remove_label'] = labelResult;

  return { success: true, steps };
}

// ---- CLI Entry Point ----

function exitWithError(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function printUsage(): never {
  console.log(`Usage: lifecycle.ts --action <action> [options]

Actions:
  check-expired            Find expired PR state files (now > expiresAt)
  mark-disband             Set disbandRequested timestamp for a PR
    --pr <number>            PR number (required)
  disband                  Execute full disband (lark-cli + delete + remove label)
    --pr <number>            PR number (required)

Options:
  --repo <repo>            GitHub repo (default: hs3180/disclaude)
  --skip-lark              Skip lark-cli group dismissal (for testing)

Environment:
  DISBAND_DEDUP_HOURS      Hours before re-sending disband request (default: 24)
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let action = '';
  let prNumber: number | undefined;
  let repo = 'hs3180/disclaude';
  let skipLark = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--action':
        action = args[++i] ?? '';
        break;
      case '--pr': {
        const val = args[++i];
        prNumber = parseInt(val ?? '', 10);
        break;
      }
      case '--repo':
        repo = args[++i] ?? '';
        break;
      case '--skip-lark':
        skipLark = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        break;
    }
  }

  if (!action) {
    exitWithError('Missing required argument: --action <action>. Use --help for usage.');
  }

  switch (action) {
    case 'check-expired': {
      const result = await checkExpired();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'mark-disband': {
      if (!prNumber || !Number.isFinite(prNumber)) {
        exitWithError('Missing or invalid --pr <number> for mark-disband');
      }
      const result = await markDisband(prNumber);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'disband': {
      if (!prNumber || !Number.isFinite(prNumber)) {
        exitWithError('Missing or invalid --pr <number> for disband');
      }
      const result = await disband(prNumber, repo, skipLark);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default:
      exitWithError(`Unknown action: '${action}'. Valid actions: check-expired, mark-disband, disband`);
  }
}

// Only run CLI when executed directly (not when imported by tests)
const isDirectRun = (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.url.replace('file://', ''))
);

if (isDirectRun) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
