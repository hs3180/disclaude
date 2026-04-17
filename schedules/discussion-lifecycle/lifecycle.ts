#!/usr/bin/env tsx
/**
 * schedules/discussion-lifecycle/lifecycle.ts — Manage expired PR discussion groups.
 *
 * Part of PR Scanner v2 (Sub-Issue C — Discussion Lifecycle Management, Issue #2221).
 * Operates on the same state files as scanner.ts (`.temp-chats/pr-{number}.json`).
 *
 * CLI interface (`--action` mode):
 *   --action check-expired   Scan .temp-chats/ for expired PR state files
 *   --action mark-disband    Update disbandRequested timestamp for a PR
 *
 * Environment variables (optional):
 *   PR_SCANNER_DIR           State directory (default: .temp-chats)
 *   DISBAND_COOLDOWN_HOURS   Hours between disband notifications (default: 24)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid arguments)
 */

import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// ---- Types (compatible with scanner.ts PrStateFile schema §3.1) ----

export type PrState = 'reviewing' | 'approved' | 'closed';

export interface PrStateFile {
  prNumber: number;
  chatId: string | null;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

export interface ExpiredPr {
  prNumber: number;
  chatId: string | null;
  state: PrState;
  expiresAt: string;
  disbandRequested: string | null;
  needsNotification: boolean;
  hoursSinceLastNotification: number | null;
}

export interface CheckExpiredResult {
  expired: ExpiredPr[];
  total: number;
}

export interface MarkDisbandResult {
  prNumber: number;
  disbandRequested: string;
  updatedAt: string;
}

// ---- Constants ----

export const DEFAULT_STATE_DIR = '.temp-chats';
export const DISBAND_COOLDOWN_HOURS = 24;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const VALID_STATES: readonly PrState[] = ['reviewing', 'approved', 'closed'] as const;

/**
 * Resolve state directory — reads env var at call time for testability.
 */
export function getStateDir(): string {
  return process.env.PR_SCANNER_DIR || DEFAULT_STATE_DIR;
}

// ---- Helpers ----

/** Current UTC time in ISO format (without milliseconds), matching scanner.ts nowISO(). */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Resolve state file path for a given PR number. */
export function stateFilePath(prNumber: number, stateDir?: string): string {
  const dir = stateDir ?? getStateDir();
  return resolve(dir, `pr-${prNumber}.json`);
}

/** Atomic file write: write to temp file then rename (matching scanner.ts pattern). */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Ensure state directory exists. */
export async function ensureStateDir(stateDir?: string): Promise<string> {
  const dir = stateDir ?? getStateDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Validate PR number from string input. */
export function validatePrNumber(raw: string): number {
  const num = parseInt(raw, 10);
  if (!Number.isFinite(num) || num <= 0 || raw !== String(num)) {
    throw new Error(`Invalid PR number: '${raw}' (must be a positive integer)`);
  }
  return num;
}

/**
 * Parse a state file JSON string into a PrStateFile.
 * Validates the schema strictly following design spec §3.1.
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

/**
 * Validate state file data object.
 * Ensures all required fields exist with correct types.
 */
export function validateStateFileData(data: unknown, filePath: string): PrStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`State file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  // prNumber: required positive integer
  if (typeof obj.prNumber !== 'number' || !Number.isFinite(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  // chatId: string or null
  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId' (must be string or null)`);
  }

  // state: must be one of the valid states
  if (!VALID_STATES.includes(obj.state as PrState)) {
    throw new Error(`State file '${filePath}' has invalid 'state' (must be one of: ${VALID_STATES.join(', ')})`);
  }

  // createdAt: required UTC datetime string
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'createdAt'`);
  }

  // updatedAt: required UTC datetime string
  if (typeof obj.updatedAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.updatedAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'updatedAt'`);
  }

  // expiresAt: required UTC datetime string
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'expiresAt'`);
  }

  // disbandRequested: string or null
  if (obj.disbandRequested !== null && typeof obj.disbandRequested !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested' (must be string or null)`);
  }

  return data as PrStateFile;
}

/**
 * Check if a PR needs a disband notification based on the cooldown rule.
 *
 * Returns:
 * - needsNotification: true if no previous notification or cooldown has passed
 * - hoursSinceLastNotification: hours since last disband request, or null if never sent
 */
export function checkNotificationNeeded(
  disbandRequested: string | null,
  now: string,
  cooldownHours: number = DISBAND_COOLDOWN_HOURS,
): { needsNotification: boolean; hoursSinceLastNotification: number | null } {
  if (disbandRequested === null) {
    return { needsNotification: true, hoursSinceLastNotification: null };
  }

  const lastNotification = new Date(disbandRequested).getTime();
  const nowMs = new Date(now).getTime();
  const hoursSince = (nowMs - lastNotification) / (1000 * 60 * 60);

  return {
    needsNotification: hoursSince >= cooldownHours,
    hoursSinceLastNotification: Math.round(hoursSince * 100) / 100,
  };
}

// ---- CLI Actions ----

/**
 * Action: check-expired
 *
 * Scans `.temp-chats/` for state files where `now > expiresAt`.
 * Output: JSON with list of expired PRs including notification status.
 */
export async function actionCheckExpired(stateDir?: string): Promise<void> {
  const dir = stateDir ?? getStateDir();
  const resolvedDir = resolve(dir);
  const now = nowISO();

  let files: string[];
  try {
    files = await readdir(resolvedDir);
  } catch {
    // Directory doesn't exist — no expired PRs
    console.log(JSON.stringify({ expired: [], total: 0 }));
    return;
  }

  const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));
  const expired: ExpiredPr[] = [];

  for (const fileName of jsonFiles) {
    const filePath = resolve(resolvedDir, fileName);

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let stateFile: PrStateFile;
    try {
      stateFile = parseStateFile(content, filePath);
    } catch {
      console.error(`WARN: Skipping corrupted state file: ${filePath}`);
      continue;
    }

    // Check if expired
    if (!UTC_DATETIME_REGEX.test(stateFile.expiresAt) || stateFile.expiresAt >= now) {
      continue;
    }

    const { needsNotification, hoursSinceLastNotification } = checkNotificationNeeded(
      stateFile.disbandRequested,
      now,
    );

    expired.push({
      prNumber: stateFile.prNumber,
      chatId: stateFile.chatId,
      state: stateFile.state,
      expiresAt: stateFile.expiresAt,
      disbandRequested: stateFile.disbandRequested,
      needsNotification,
      hoursSinceLastNotification,
    });
  }

  // Sort by expiresAt ascending (oldest first)
  expired.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  console.log(JSON.stringify({ expired, total: expired.length }));
}

/**
 * Action: mark-disband
 *
 * Updates the `disbandRequested` timestamp for a specific PR state file.
 * This is called after sending a disband notification to prevent spam.
 *
 * Output: JSON with updated state.
 */
export async function actionMarkDisband(prNumber: number, stateDir?: string): Promise<void> {
  const dir = stateDir ?? getStateDir();
  const filePath = stateFilePath(prNumber, dir);
  const now = nowISO();

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`State file not found for PR #${prNumber}: ${filePath}`);
  }

  let stateFile: PrStateFile;
  try {
    stateFile = parseStateFile(content, filePath);
  } catch {
    throw new Error(`Corrupted state file for PR #${prNumber}: ${filePath}`);
  }

  // Update disbandRequested and updatedAt
  const updated: PrStateFile = {
    ...stateFile,
    disbandRequested: now,
    updatedAt: now,
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');

  const result: MarkDisbandResult = {
    prNumber: updated.prNumber,
    disbandRequested: updated.disbandRequested,
    updatedAt: updated.updatedAt,
  };

  console.log(JSON.stringify(result));
}

// ---- CLI Entry Point ----

function printUsage(): void {
  console.error(`Usage: npx tsx schedules/discussion-lifecycle/lifecycle.ts --action <action> [--pr <number>]

Actions:
  check-expired    Scan .temp-chats/ for expired PR state files
  mark-disband     Update disbandRequested timestamp for a PR (requires --pr)

Options:
  --pr <number>    PR number (required for mark-disband)
  --state-dir      Override state directory (for testing)

Environment variables:
  PR_SCANNER_DIR        State directory (default: .temp-chats)
  DISBAND_COOLDOWN_HOURS  Hours between notifications (default: 24)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let action: string | null = null;
  let prNumber: number | null = null;
  let stateDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action' && i + 1 < args.length) {
      action = args[++i];
    } else if (args[i] === '--pr' && i + 1 < args.length) {
      prNumber = validatePrNumber(args[++i]);
    } else if (args[i] === '--state-dir' && i + 1 < args.length) {
      stateDir = args[++i];
    }
  }

  if (!action) {
    printUsage();
    process.exit(1);
  }

  switch (action) {
    case 'check-expired':
      await actionCheckExpired(stateDir);
      break;
    case 'mark-disband':
      if (prNumber === null) {
        console.error('ERROR: --pr <number> is required for mark-disband action');
        process.exit(1);
      }
      await actionMarkDisband(prNumber, stateDir);
      break;
    default:
      console.error(`ERROR: Unknown action '${action}'. Valid actions: check-expired, mark-disband`);
      process.exit(1);
  }
}

// Only run main() when executed directly (not when imported for testing)
if (process.argv[1]?.endsWith('lifecycle.ts')) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
