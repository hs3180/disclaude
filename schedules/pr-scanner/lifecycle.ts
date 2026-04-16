#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/lifecycle.ts — Discussion group lifecycle management for PR Scanner v2.
 *
 * Manages the lifecycle of PR discussion groups by tracking expiration
 * and disband requests. Reads/writes state files in .temp-chats/pr-{number}.json
 * with schema defined in the PR Scanner v2 design spec §3.1.
 *
 * CLI actions:
 *   --action check-expired   Scan .temp-chats/ for PRs where now > expiresAt
 *   --action mark-disband    Update disbandRequested timestamp (requires --pr)
 *
 * Environment variables (optional):
 *   TEMP_CHATS_DIR           Override state file directory (default: .temp-chats)
 *   DISBAND_COOLDOWN_HOURS   Hours between repeated disband requests (default: 24)
 *
 * Exit codes:
 *   0 — success (or no expired PRs found)
 *   1 — fatal error (invalid args, missing file, etc.)
 */

import { readdir, readFile, writeFile, rename, stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// ---- Types ----

export type PRState = 'reviewing' | 'approved' | 'closed';

export interface PRStateFile {
  prNumber: number;
  chatId: string;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

export interface ExpiredPR {
  prNumber: number;
  chatId: string;
  state: PRState;
  expiresAt: string;
  disbandRequested: string | null;
  elapsedMs: number;
  canSendDisbandRequest: boolean;
}

// ---- Constants ----

export const TEMP_CHATS_DIR = '.temp-chats';
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DEFAULT_DISBAND_COOLDOWN_HOURS = 24;

// ---- Helpers ----

export function nowISO(): string {
  return new Date().toISOString();
}

function isValidState(state: unknown): state is PRState {
  return typeof state === 'string' && ['reviewing', 'approved', 'closed'].includes(state);
}

/**
 * Parse and validate a PR state file from JSON string.
 */
export function parsePRStateFile(json: string, filePath: string): PRStateFile {
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

  if (typeof obj.prNumber !== 'number') {
    throw new Error(`State file '${filePath}' has invalid 'prNumber'`);
  }
  if (typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }
  if (!isValidState(obj.state)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new Error(`State file '${filePath}' has invalid 'expiresAt' (must be UTC Z-suffix)`);
  }
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new Error(`State file '${filePath}' has invalid 'createdAt' (must be UTC Z-suffix)`);
  }
  if (typeof obj.updatedAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.updatedAt)) {
    throw new Error(`State file '${filePath}' has invalid 'updatedAt' (must be UTC Z-suffix)`);
  }

  return data as PRStateFile;
}

/**
 * Atomic file write: write to temp file then rename.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

// ---- CLI Argument Parsing ----

interface CLIArgs {
  action: string;
  pr?: number;
}

export function parseArgs(argv: string[]): CLIArgs {
  const args = argv.slice(2);
  let action: string | undefined;
  let pr: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action' && i + 1 < args.length) {
      action = args[++i];
    } else if (args[i] === '--pr' && i + 1 < args.length) {
      pr = parseInt(args[++i], 10);
    }
  }

  if (!action) {
    throw new Error('--action is required (check-expired, mark-disband)');
  }

  if (action === 'mark-disband' && pr === undefined) {
    throw new Error('--pr is required for mark-disband action');
  }

  return { action, pr };
}

// ---- Actions ----

/**
 * check-expired: Scan .temp-chats/ for PRs where now > expiresAt.
 *
 * Returns expired PRs sorted by expiration time (oldest first).
 * Each result includes `canSendDisbandRequest` which is true when
 * no previous request was sent, or the last request was >= 24h ago.
 */
export async function checkExpired(tempChatsDir?: string): Promise<ExpiredPR[]> {
  const dir = resolve(tempChatsDir ?? process.env.TEMP_CHATS_DIR ?? TEMP_CHATS_DIR);

  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch {
    return [];
  }

  if (!dirStat.isDirectory()) {
    return [];
  }

  const canonicalDir = await realpath(dir);
  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    return [];
  }

  const now = new Date();
  const cooldownMs = parseCooldownHours() * 60 * 60 * 1000;
  const expired: ExpiredPR[] = [];

  for (const fileName of files) {
    if (!fileName.startsWith('pr-') || !fileName.endsWith('.json')) {
      continue;
    }

    const filePath = resolve(canonicalDir, fileName);

    // Verify file is within the temp-chats directory (symlink protection)
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch {
      continue;
    }
    if (dirname(realFilePath) !== canonicalDir) {
      continue;
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let state: PRStateFile;
    try {
      state = parsePRStateFile(content, filePath);
    } catch {
      console.error(`WARN: Skipping corrupted state file: ${filePath}`);
      continue;
    }

    const expiresAt = new Date(state.expiresAt);
    if (expiresAt <= now) {
      const elapsedMs = now.getTime() - expiresAt.getTime();

      // Determine if we can send a new disband request (24h cooldown)
      let canSendDisbandRequest = false;
      if (state.disbandRequested === null) {
        canSendDisbandRequest = true;
      } else {
        const lastRequest = new Date(state.disbandRequested);
        canSendDisbandRequest = now.getTime() - lastRequest.getTime() >= cooldownMs;
      }

      expired.push({
        prNumber: state.prNumber,
        chatId: state.chatId,
        state: state.state,
        expiresAt: state.expiresAt,
        disbandRequested: state.disbandRequested,
        elapsedMs,
        canSendDisbandRequest,
      });
    }
  }

  // Sort by expiration time (oldest first — most overdue first)
  expired.sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime());

  return expired;
}

/**
 * mark-disband: Update the disbandRequested timestamp for a specific PR.
 *
 * Returns the previous disbandRequested value so callers can detect
 * concurrent modifications.
 */
export async function markDisband(
  prNumber: number,
  tempChatsDir?: string,
): Promise<{ success: boolean; error: string | null; previousDisbandRequested: string | null }> {
  const dir = resolve(tempChatsDir ?? process.env.TEMP_CHATS_DIR ?? TEMP_CHATS_DIR);
  const filePath = resolve(dir, `pr-${prNumber}.json`);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return { success: false, error: `State file not found: pr-${prNumber}.json`, previousDisbandRequested: null };
  }

  let state: PRStateFile;
  try {
    state = parsePRStateFile(content, filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid state file';
    return { success: false, error: msg, previousDisbandRequested: null };
  }

  const previousDisbandRequested = state.disbandRequested;
  const now = nowISO();

  const updated: PRStateFile = {
    ...state,
    updatedAt: now,
    disbandRequested: now,
  };

  try {
    await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to write state file';
    return { success: false, error: msg, previousDisbandRequested };
  }

  return { success: true, error: null, previousDisbandRequested };
}

/**
 * Parse DISBAND_COOLDOWN_HOURS env var with fallback.
 */
function parseCooldownHours(): number {
  const env = process.env.DISBAND_COOLDOWN_HOURS;
  if (!env) return DEFAULT_DISBAND_COOLDOWN_HOURS;
  const parsed = parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`WARN: Invalid DISBAND_COOLDOWN_HOURS='${env}', falling back to ${DEFAULT_DISBAND_COOLDOWN_HOURS}`);
    return DEFAULT_DISBAND_COOLDOWN_HOURS;
  }
  return parsed;
}

// ---- Main ----

async function main(): Promise<void> {
  const { action, pr } = parseArgs(process.argv);

  switch (action) {
    case 'check-expired': {
      const expired = await checkExpired();
      // Output JSON to stdout (machine-readable)
      console.log(JSON.stringify(expired, null, 2));

      if (expired.length === 0) {
        console.error('INFO: No expired PRs found');
      } else {
        const actionable = expired.filter((e) => e.canSendDisbandRequest);
        console.error(`INFO: Found ${expired.length} expired PR(s), ${actionable.length} eligible for disband request`);
      }
      break;
    }

    case 'mark-disband': {
      if (pr === undefined) {
        console.error('ERROR: --pr is required for mark-disband action');
        process.exit(1);
      }

      const result = await markDisband(pr);
      if (!result.success) {
        console.error(`ERROR: ${result.error}`);
        process.exit(1);
      }

      console.log(JSON.stringify({ success: true, previousDisbandRequested: result.previousDisbandRequested }, null, 2));
      console.error(`OK: Marked PR #${pr} disband request at ${nowISO()}`);
      break;
    }

    default:
      console.error(`ERROR: Unknown action '${action}'. Use 'check-expired' or 'mark-disband'`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
