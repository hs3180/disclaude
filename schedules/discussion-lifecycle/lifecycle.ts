#!/usr/bin/env tsx
/**
 * schedules/discussion-lifecycle/lifecycle.ts — Manage PR discussion group expiration and dissolution.
 *
 * Scans .temp-chats/ for expired PR state files, sends disband request cards,
 * and handles confirmed disbands (lark-cli disband + cleanup).
 *
 * Actions:
 *   check-expired  — Scan for expired reviewing PRs, output JSON list
 *   mark-disband   — Update disbandRequested timestamp for a PR
 *   confirm-disband — Execute disband: lark-cli disband + delete state + remove label
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (missing dependencies, invalid arguments)
 */

import { readdir, readFile, writeFile, rename, unlink, stat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLock } from '../../skills/chat/lock.js';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const STATE_DIR = '.temp-chats';
const STATE_FILE_PREFIX = 'pr-';
const STATE_FILE_SUFFIX = '.json';
const DISBAND_NOTIFY_INTERVAL_HOURS = 24;
const LARK_TIMEOUT_MS = 30_000;
const DEFAULT_REPO = 'hs3180/disclaude';

// ---- Types ----

export const PR_STATES = ['reviewing', 'approved', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

export interface PrStateFile {
  prNumber: number;
  chatId: string;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** ISO timestamp of last disband notification sent (lifecycle-managed) */
  disbandRequested?: string | null;
}

export interface ExpiredPr {
  prNumber: number;
  chatId: string;
  state: PrState;
  expiresAt: string;
  disbandRequested: string | null;
  /** Whether a new disband notification should be sent (24h cooldown elapsed) */
  shouldNotify: boolean;
}

// ---- Internal helpers ----

function nowISO(): string {
  return new Date().toISOString();
}

function stateFilePath(stateDir: string, prNumber: number): string {
  return resolve(stateDir, `${STATE_FILE_PREFIX}${prNumber}${STATE_FILE_SUFFIX}`);
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action' && args[i + 1]) {
      result.action = args[++i];
    } else if (args[i] === '--pr' && args[i + 1]) {
      result.pr = args[++i];
    } else if (args[i] === '--repo' && args[i + 1]) {
      result.repo = args[++i];
    } else if (args[i] === '--state-dir' && args[i + 1]) {
      result.stateDir = args[++i];
    }
  }
  return result;
}

function fail(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

// ---- Core functions (exported for testing) ----

/**
 * Read a PR state file from disk.
 * Returns null if the file doesn't exist or is corrupt.
 */
export async function readStateFile(
  stateDir: string,
  prNumber: number,
): Promise<PrStateFile | null> {
  const filePath = stateFilePath(stateDir, prNumber);
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (typeof parsed.prNumber === 'number' && typeof parsed.state === 'string') {
      return parsed as PrStateFile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write a PR state file to disk (atomic).
 */
export async function writeStateFile(
  stateDir: string,
  prNumber: number,
  data: PrStateFile,
): Promise<void> {
  await ensureDir(stateDir);
  const filePath = stateFilePath(stateDir, prNumber);
  await atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * List all valid PR state files in the state directory.
 */
export async function listAllStateFiles(stateDir: string): Promise<PrStateFile[]> {
  const results: PrStateFile[] = [];
  try {
    await stat(stateDir);
  } catch {
    return results;
  }

  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch {
    return results;
  }

  for (const file of files) {
    if (!file.startsWith(STATE_FILE_PREFIX) || !file.endsWith(STATE_FILE_SUFFIX)) continue;
    const filePath = resolve(stateDir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed.prNumber === 'number' && typeof parsed.state === 'string') {
        results.push(parsed as PrStateFile);
      }
    } catch {
      // Skip corrupt files
    }
  }
  return results;
}

/**
 * Check if a disband notification should be sent based on cooldown.
 * Returns true if no notification has been sent, or if 24h have elapsed
 * since the last notification.
 */
export function shouldSendDisbandNotification(state: PrStateFile, now: string): boolean {
  if (!state.disbandRequested) {
    return true;
  }
  const lastNotify = new Date(state.disbandRequested).getTime();
  const nowMs = new Date(now).getTime();
  const elapsedHours = (nowMs - lastNotify) / (1000 * 60 * 60);
  return elapsedHours >= DISBAND_NOTIFY_INTERVAL_HOURS;
}

/**
 * Scan for expired PR state files that are still in 'reviewing' state.
 * Returns a list of expired PRs with notification status.
 */
export async function checkExpired(stateDir: string): Promise<ExpiredPr[]> {
  const allStates = await listAllStateFiles(stateDir);
  const now = nowISO();
  const expired: ExpiredPr[] = [];

  for (const state of allStates) {
    // Only process reviewing PRs
    if (state.state !== 'reviewing') continue;

    // Check if expired — compare as Date objects for reliability
    const expiresDate = new Date(state.expiresAt);
    if (isNaN(expiresDate.getTime())) continue;
    if (expiresDate >= new Date(now)) continue;

    expired.push({
      prNumber: state.prNumber,
      chatId: state.chatId,
      state: state.state,
      expiresAt: state.expiresAt,
      disbandRequested: state.disbandRequested ?? null,
      shouldNotify: shouldSendDisbandNotification(state, now),
    });
  }

  return expired;
}

/**
 * Update the disbandRequested timestamp for a PR.
 * Uses file lock to prevent concurrent modifications.
 */
export async function markDisband(
  stateDir: string,
  prNumber: number,
): Promise<PrStateFile> {
  const filePath = stateFilePath(stateDir, prNumber);

  // Acquire lock
  const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);

  try {
    const state = await readStateFile(stateDir, prNumber);
    if (!state) {
      throw new Error(`No state file found for PR #${prNumber}`);
    }

    const now = nowISO();
    const updated: PrStateFile = {
      ...state,
      disbandRequested: now,
      updatedAt: now,
    };

    await writeStateFile(stateDir, prNumber, updated);
    return updated;
  } finally {
    await lock.release();
  }
}

/**
 * Execute disband: remove label via gh CLI, disband group via lark-cli,
 * delete state file.
 */
export async function confirmDisband(
  stateDir: string,
  prNumber: number,
  repo: string,
  options?: { skipLark?: boolean; skipGh?: boolean },
): Promise<{ success: boolean; error: string | null }> {
  const filePath = stateFilePath(stateDir, prNumber);
  const skipLark = options?.skipLark ?? false;
  const skipGh = options?.skipGh ?? false;

  // Acquire lock
  const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 5000);

  try {
    // Re-read under lock
    const state = await readStateFile(stateDir, prNumber);
    if (!state) {
      return { success: false, error: `No state file found for PR #${prNumber}` };
    }

    // Only disband reviewing PRs
    if (state.state !== 'reviewing') {
      return { success: false, error: `PR #${prNumber} state is '${state.state}', expected 'reviewing'` };
    }

    const errors: string[] = [];

    // Step 1: Remove GitHub label
    if (!skipGh) {
      try {
        await execFileAsync(
          'gh',
          ['pr', 'edit', String(prNumber), '--repo', repo, '--remove-label', 'pr-scanner:reviewing'],
          { timeout: 15_000 },
        );
        console.log(`OK: Removed pr-scanner:reviewing label from PR #${prNumber}`);
      } catch (err: unknown) {
        const execErr = err as { stderr?: string; message?: string };
        const msg = execErr.stderr ?? execErr.message ?? 'unknown error';
        errors.push(`label-remove: ${msg.replace(/\n/g, ' ').trim()}`);
        console.error(`WARN: Failed to remove label from PR #${prNumber}: ${msg}`);
      }
    }

    // Step 2: Disband group via lark-cli
    if (!skipLark && state.chatId) {
      try {
        await execFileAsync(
          'lark-cli',
          ['api', 'DELETE', `/open-apis/im/v1/chats/${state.chatId}`],
          { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
        console.log(`OK: Disbanded group ${state.chatId} for PR #${prNumber}`);
      } catch (err: unknown) {
        const execErr = err as { stderr?: string; message?: string };
        const msg = execErr.stderr ?? execErr.message ?? 'unknown error';
        errors.push(`disband: ${msg.replace(/\n/g, ' ').trim()}`);
        console.error(`WARN: Failed to disband group ${state.chatId}: ${msg}`);
      }
    }

    // Step 3: Delete state file
    try {
      await unlink(filePath);
      console.log(`OK: Deleted state file for PR #${prNumber}`);
    } catch (err: unknown) {
      const errObj = err as { code?: string; message?: string };
      if (errObj.code === 'ENOENT') {
        console.log(`INFO: State file already removed for PR #${prNumber}`);
      } else {
        errors.push(`delete: ${errObj.message ?? 'unknown error'}`);
        console.error(`WARN: Failed to delete state file for PR #${prNumber}: ${errObj.message}`);
      }
    }

    return {
      success: errors.length === 0,
      error: errors.length > 0 ? errors.join('; ') : null,
    };
  } finally {
    await lock.release();
  }
}

// ---- CLI entry point ----

async function main(): Promise<void> {
  const args = parseArgs();
  const action = args.action;
  const stateDir = args.stateDir ?? STATE_DIR;

  switch (action) {
    case 'check-expired': {
      const expired = await checkExpired(stateDir);
      // Output as JSON for schedule prompt to parse
      console.log(JSON.stringify(expired, null, 2));
      break;
    }

    case 'mark-disband': {
      const prNumber = parseInt(args.pr ?? '', 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        fail('--pr <number> is required and must be a positive integer');
      }
      const result = await markDisband(stateDir, prNumber);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'confirm-disband': {
      const prNumber = parseInt(args.pr ?? '', 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        fail('--pr <number> is required and must be a positive integer');
      }
      const repo = args.repo ?? DEFAULT_REPO;
      const result = await confirmDisband(stateDir, prNumber, repo);
      console.log(JSON.stringify(result, null, 2));
      if (!result.success) {
        process.exitCode = 1;
      }
      break;
    }

    default:
      fail(`Unknown action '${action}'. Valid actions: check-expired, mark-disband, confirm-disband`);
  }
}

// Only run main() when executed directly (not when imported by tests)
const isMainModule = process.argv[1]?.includes('lifecycle.ts');
if (isMainModule) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
