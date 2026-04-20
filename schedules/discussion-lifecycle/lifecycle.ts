#!/usr/bin/env tsx
/**
 * schedules/discussion-lifecycle/lifecycle.ts — Manage PR discussion group expiry and disbandment.
 *
 * Scans .temp-chats/ for expired PR state files, sends disband request cards
 * to discussion groups (with 24h dedup), and handles confirmed disband actions.
 *
 * CLI Actions:
 *   check-expired  — Find expired reviewing PR state files
 *   mark-disband   — Update disbandRequested timestamp for a PR
 *
 * Environment variables (optional):
 *   DISBAND_DEDUP_HOURS   Hours between disband request cards (default: 24)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error
 */

import { readdir, readFile, writeFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

/** Directory for PR scanner state files (shared with scanner.ts) */
export const STATE_DIR = '.temp-chats';

/** Valid PR states (must match scanner.ts) */
export const VALID_STATES = ['reviewing', 'approved', 'closed'] as const;
export type PRState = (typeof VALID_STATES)[number];

/** Default hours between repeated disband request cards */
export const DEFAULT_DISBAND_DEDUP_HOURS = 24;

/** PR Scanner reviewing label */
export const REVIEWING_LABEL = 'pr-scanner:reviewing';

/** Default repository */
export const DEFAULT_REPO = 'hs3180/disclaude';

/** lark-cli command timeout (ms) */
export const LARK_TIMEOUT_MS = 30_000;

/** Disband confirmation action value */
export const DISBAND_CONFIRM_ACTION = 'confirm-disband';

// ---- Types ----

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
  expiresAt: string;
  disbandRequested: string | null;
  filePath: string;
}

export interface DisbandResult {
  prNumber: number;
  success: boolean;
  error: string | null;
  action: string;
}

// ---- Helpers ----

/** Get current UTC timestamp in ISO 8601 format */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Get state file path for a given PR number */
export function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

/** Check if a UTC ISO string represents a time in the past */
export function isExpired(isoString: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(isoString)) return false;
  return new Date(isoString).getTime() < Date.now();
}

/**
 * Check if enough time has passed since the last disband request.
 * Returns true if disband has never been requested or if dedup period has elapsed.
 */
export function shouldSendDisband(disbandRequested: string | null, dedupHours: number): boolean {
  if (!disbandRequested) return true;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(disbandRequested)) return true;
  const elapsed = Date.now() - new Date(disbandRequested).getTime();
  return elapsed >= dedupHours * 60 * 60 * 1000;
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

// ---- Actions ----

/**
 * check-expired: Scan .temp-chats/ for expired reviewing PR state files.
 *
 * Returns a list of PRs where:
 * - state === 'reviewing'
 * - expiresAt < now
 * - disbandRequested is null OR >= dedupHours ago
 *
 * PRs that are expired but within the dedup window are reported separately
 * so the caller knows they exist but should not be notified again.
 */
export async function checkExpired(dedupHours: number = DEFAULT_DISBAND_DEDUP_HOURS): Promise<{
  needsDisband: ExpiredPR[];
  alreadyNotified: ExpiredPR[];
}> {
  const needsDisband: ExpiredPR[] = [];
  const alreadyNotified: ExpiredPR[] = [];

  try {
    const dir = resolve(STATE_DIR);
    const files = await readdir(dir);
    const now = nowISO();

    for (const file of files) {
      if (!file.startsWith('pr-') || !file.endsWith('.json')) continue;

      const filePath = resolve(dir, file);
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      let stateFile: PRStateFile;
      try {
        stateFile = parseStateFile(content, filePath);
      } catch {
        continue;
      }

      // Only process reviewing state
      if (stateFile.state !== 'reviewing') continue;

      // Check if expired
      if (!isExpired(stateFile.expiresAt)) continue;

      const entry: ExpiredPR = {
        prNumber: stateFile.prNumber,
        chatId: stateFile.chatId,
        expiresAt: stateFile.expiresAt,
        disbandRequested: stateFile.disbandRequested,
        filePath,
      };

      if (shouldSendDisband(stateFile.disbandRequested, dedupHours)) {
        needsDisband.push(entry);
      } else {
        alreadyNotified.push(entry);
      }
    }
  } catch {
    // Directory doesn't exist — nothing to check
  }

  return { needsDisband, alreadyNotified };
}

/**
 * mark-disband: Update disbandRequested timestamp for a PR.
 *
 * Sets disbandRequested to the current time. Also updates updatedAt.
 * Returns the updated state file.
 */
export async function markDisband(prNumber: number): Promise<PRStateFile> {
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

  // Only allow marking reviewing PRs
  if (stateFile.state !== 'reviewing') {
    throw new Error(`Cannot mark disband for PR #${prNumber}: state is '${stateFile.state}', expected 'reviewing'`);
  }

  stateFile.disbandRequested = nowISO();
  stateFile.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');
  return stateFile;
}

/**
 * execute-disband: Actually disband a discussion group.
 *
 * Steps:
 * 1. Validate PR state is still reviewing
 * 2. Disband the Feishu group via lark-cli (if chatId exists)
 * 3. Update state to 'closed'
 * 4. Remove pr-scanner:reviewing label from GitHub PR
 * 5. Delete the state file
 */
export async function executeDisband(
  prNumber: number,
  repo: string = DEFAULT_REPO,
  skipLarkCheck: boolean = false,
): Promise<DisbandResult> {
  const filePath = stateFilePath(prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      return { prNumber, success: false, error: `No state file found for PR #${prNumber}`, action: 'skip' };
    }
    throw err;
  }

  let stateFile: PRStateFile;
  try {
    stateFile = parseStateFile(content, filePath);
  } catch (err: unknown) {
    return { prNumber, success: false, error: `Corrupted state file: ${err}`, action: 'skip' };
  }

  // Validate state is still reviewing
  if (stateFile.state !== 'reviewing') {
    return { prNumber, success: false, error: `State is '${stateFile.state}', expected 'reviewing'`, action: 'reject' };
  }

  // Disband group via lark-cli
  if (stateFile.chatId && !skipLarkCheck) {
    try {
      await execFileAsync(
        'lark-cli',
        ['api', 'DELETE', `/open-apis/im/v1/chats/${stateFile.chatId}`],
        { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string };
      const errorMsg = execErr.stderr ?? execErr.message ?? 'unknown error';
      // Continue even if dissolution fails — group may already be disbanded
      console.error(`WARN: Failed to dissolve group ${stateFile.chatId} for PR #${prNumber}: ${errorMsg}`);
    }
  }

  // Update state to closed
  stateFile.state = 'closed';
  stateFile.updatedAt = nowISO();
  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2) + '\n');

  // Remove reviewing label from GitHub PR
  try {
    await execFileAsync(
      'gh',
      ['pr', 'edit', String(prNumber), '--repo', repo, '--remove-label', REVIEWING_LABEL],
      { timeout: 15_000 },
    );
  } catch (err: unknown) {
    // Non-blocking — label removal failure should not block disband
    const execErr = err as { stderr?: string; message?: string };
    console.error(`WARN: Failed to remove label for PR #${prNumber}: ${execErr.stderr ?? execErr.message}`);
  }

  // Delete state file
  try {
    await unlink(filePath);
  } catch {
    // Best-effort cleanup
  }

  return { prNumber, success: true, error: null, action: 'disbanded' };
}

// ---- CLI ----

function printUsage(): never {
  console.error(`Usage: lifecycle.ts --action <action> [options]

Actions:
  check-expired [--dedup-hours N]     Find expired reviewing PRs needing disband
  mark-disband --pr NUMBER            Update disbandRequested timestamp for a PR
  execute-disband --pr NUMBER [--repo OWNER/REPO]  Disband group and clean up

Options:
  --dedup-hours N   Hours between disband request cards (default: ${DEFAULT_DISBAND_DEDUP_HOURS})
  --pr NUMBER       PR number
  --repo OWNER/REPO GitHub repository (default: ${DEFAULT_REPO})`);
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
  const dedupIdx = args.indexOf('--dedup-hours');
  const dedupHours = dedupIdx !== -1 && dedupIdx + 1 < args.length
    ? parseInt(args[dedupIdx + 1], 10)
    : DEFAULT_DISBAND_DEDUP_HOURS;

  const prIdx = args.indexOf('--pr');
  const prNumber = prIdx !== -1 && prIdx + 1 < args.length
    ? parseInt(args[prIdx + 1], 10)
    : null;

  const repoIdx = args.indexOf('--repo');
  const repo = repoIdx !== -1 && repoIdx + 1 < args.length
    ? args[repoIdx + 1]
    : DEFAULT_REPO;

  try {
    switch (action) {
      case 'check-expired': {
        if (!Number.isFinite(dedupHours) || dedupHours <= 0) {
          console.error('ERROR: --dedup-hours must be a positive number');
          process.exit(1);
        }
        const result = await checkExpired(dedupHours);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'mark-disband': {
        if (prNumber === null || !Number.isFinite(prNumber) || prNumber <= 0) {
          console.error('ERROR: --pr must be a positive integer');
          process.exit(1);
        }
        const result = await markDisband(prNumber);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'execute-disband': {
        if (prNumber === null || !Number.isFinite(prNumber) || prNumber <= 0) {
          console.error('ERROR: --pr must be a positive integer');
          process.exit(1);
        }
        const result = await executeDisband(prNumber, repo);
        console.log(JSON.stringify(result, null, 2));
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
if (process.argv[1]?.includes('lifecycle.ts')) {
  main();
}
