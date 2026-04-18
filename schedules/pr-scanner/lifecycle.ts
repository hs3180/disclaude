#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/lifecycle.ts — Discussion group lifecycle CLI tool.
 *
 * Manages expired PR discussion groups: detection, disband request tracking,
 * and cleanup. Called by the discussion-lifecycle Schedule prompt.
 *
 * No external dependencies — uses only Node.js built-ins.
 * No GitHub API calls — fully offline-testable.
 *
 * Usage:
 *   npx tsx lifecycle.ts --action check-expired [--cooldown-hours 24]
 *   npx tsx lifecycle.ts --action mark-disband --pr 123
 *   npx tsx lifecycle.ts --action cleanup --pr 123
 *   npx tsx lifecycle.ts --action disband --pr 123
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, file system failure)
 */

import { readdir, readFile, writeFile, unlink, realpath, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  prFilePath,
  readPrState,
  TEMP_CHATS_DIR,
  PR_FILE_PREFIX,
  PR_FILE_SUFFIX,
  ScannerError,
  type PrStateFile,
} from './scanner.js';

const execFileAsync = promisify(execFile);

// ---- Types ----

export interface ExpiredPr {
  prNumber: number;
  chatId: string | null;
  expiresAt: string;
  disbandRequested: string | null;
  createdAt: string;
  /** Whether this PR needs a new disband request (cooldown elapsed) */
  needsDisbandRequest: boolean;
}

interface CheckExpiredResult {
  expired: ExpiredPr[];
  total: number;
  skippedCooldown: number;
}

interface MarkDisbandResult {
  prNumber: number;
  disbandRequested: string;
  updatedAt: string;
}

interface CleanupResult {
  prNumber: number;
  deleted: boolean;
  error?: string;
}

interface DisbandResult {
  prNumber: number;
  chatId: string | null;
  groupDissolved: boolean;
  stateFileDeleted: boolean;
  error?: string;
}

// ---- Constants ----

/** Default cooldown period (hours) before re-sending a disband request */
export const DEFAULT_COOLDOWN_HOURS = 24;

/** lark-cli timeout in milliseconds */
const LARK_TIMEOUT_MS = 30_000;

/** Label to remove on disband */
const LABEL_REVIEWING = 'pr-scanner:reviewing';
const DEFAULT_REPO = 'hs3180/disclaude';
const GH_TIMEOUT_MS = 15_000;

// ---- Helpers ----

/** Atomic file write: write to temp file then rename */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.${process.pid}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Check if a timestamp is within the cooldown period */
function isWithinCooldown(disbandRequested: string | null, cooldownMs: number): boolean {
  if (!disbandRequested) return false;
  const requestedAt = new Date(disbandRequested).getTime();
  if (!Number.isFinite(requestedAt)) return false;
  return (Date.now() - requestedAt) < cooldownMs;
}

// ---- Actions ----

/**
 * check-expired: scan .temp-chats/ for expired PRs in reviewing state.
 * Returns a list of expired PRs, filtered by cooldown period.
 */
async function actionCheckExpired(cooldownHours: number): Promise<CheckExpiredResult> {
  const dir = resolve(TEMP_CHATS_DIR);
  const now = new Date().toISOString();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const expired: ExpiredPr[] = [];
  let total = 0;
  let skippedCooldown = 0;

  try {
    const canonicalDir = await realpath(dir);
    const files = await readdir(canonicalDir);
    const prFiles = files.filter(
      (f) => f.startsWith(PR_FILE_PREFIX) && f.endsWith(PR_FILE_SUFFIX),
    );

    for (const file of prFiles) {
      try {
        const state = await readPrState(resolve(canonicalDir, file));
        total++;

        // Only care about reviewing state
        if (state.state !== 'reviewing') continue;

        // Check if expired
        if (state.expiresAt >= now) continue;

        const withinCooldown = isWithinCooldown(state.disbandRequested, cooldownMs);

        expired.push({
          prNumber: state.prNumber,
          chatId: state.chatId,
          expiresAt: state.expiresAt,
          disbandRequested: state.disbandRequested,
          createdAt: state.createdAt,
          needsDisbandRequest: !withinCooldown,
        });

        if (withinCooldown) {
          skippedCooldown++;
        }
      } catch {
        // Skip corrupted files
      }
    }
  } catch {
    // Directory doesn't exist — return empty result
  }

  return { expired, total, skippedCooldown };
}

/**
 * mark-disband: update disbandRequested timestamp for a PR.
 * The PR must be in reviewing state.
 */
async function actionMarkDisband(prNumber: number): Promise<MarkDisbandResult> {
  const filePath = prFilePath(prNumber);

  let existing: PrStateFile;
  try {
    existing = await readPrState(filePath);
  } catch (err: unknown) {
    if (err instanceof ScannerError) throw err;
    throw new ScannerError(`No state file found for PR #${prNumber} at '${filePath}'`);
  }

  // Only allow disband for reviewing state
  if (existing.state !== 'reviewing') {
    throw new ScannerError(
      `Cannot mark disband for PR #${prNumber}: state is '${existing.state}', expected 'reviewing'`,
    );
  }

  const now = new Date().toISOString();
  const updated: PrStateFile = {
    ...existing,
    disbandRequested: now,
    updatedAt: now,
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  return {
    prNumber,
    disbandRequested: now,
    updatedAt: now,
  };
}

/**
 * cleanup: delete a PR state file.
 * Used after disband is confirmed to clean up.
 */
async function actionCleanup(prNumber: number): Promise<CleanupResult> {
  const filePath = prFilePath(prNumber);

  try {
    await unlink(filePath);
    return { prNumber, deleted: true };
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      return { prNumber, deleted: false, error: 'State file not found' };
    }
    return {
      prNumber,
      deleted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * disband: dissolve group via lark-cli, delete state file, remove label.
 * Performs the full cleanup sequence:
 *   1. Verify state is 'reviewing'
 *   2. Dissolve group via lark-cli (if chatId exists)
 *   3. Remove GitHub label
 *   4. Delete state file
 */
async function actionDisband(prNumber: number): Promise<DisbandResult> {
  const filePath = prFilePath(prNumber);

  // Read and validate state
  let existing: PrStateFile;
  try {
    existing = await readPrState(filePath);
  } catch (err: unknown) {
    if (err instanceof ScannerError) throw err;
    throw new ScannerError(`No state file found for PR #${prNumber} at '${filePath}'`);
  }

  if (existing.state !== 'reviewing') {
    throw new ScannerError(
      `Cannot disband PR #${prNumber}: state is '${existing.state}', expected 'reviewing'. ` +
      `The PR may have been approved or closed — refusing disband.`,
    );
  }

  // 1. Dissolve group via lark-cli
  let groupDissolved = false;
  if (existing.chatId) {
    try {
      await execFileAsync(
        'lark-cli',
        ['api', 'DELETE', `/open-apis/im/v1/chats/${existing.chatId}`],
        { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      groupDissolved = true;
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string };
      const errorMsg = execErr.stderr ?? execErr.message ?? 'unknown error';
      // Log but don't fail — group may already be dissolved
      console.error(`WARN: Failed to dissolve group ${existing.chatId}: ${errorMsg.replace(/\n/g, ' ').trim()}`);
    }
  }

  // 2. Remove GitHub label (non-fatal)
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', DEFAULT_REPO,
      '--remove-label', LABEL_REVIEWING,
    ], { timeout: GH_TIMEOUT_MS });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to remove label for PR #${prNumber}: ${msg.replace(/\n/g, ' ').trim()}`);
  }

  // 3. Delete state file
  let stateFileDeleted = false;
  try {
    await unlink(filePath);
    stateFileDeleted = true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARN: Failed to delete state file for PR #${prNumber}: ${msg}`);
  }

  return {
    prNumber,
    chatId: existing.chatId,
    groupDissolved,
    stateFileDeleted,
  };
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

// ---- Main ----

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const action = args.action;
  if (!action) {
    throw new ScannerError('--action is required (check-expired|mark-disband|cleanup|disband)');
  }

  switch (action) {
    case 'check-expired': {
      const cooldownHours = args['cooldown-hours']
        ? parseFloat(args['cooldown-hours'])
        : DEFAULT_COOLDOWN_HOURS;

      if (!Number.isFinite(cooldownHours) || cooldownHours < 0) {
        throw new ScannerError('--cooldown-hours must be a non-negative number');
      }

      const result = await actionCheckExpired(cooldownHours);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'mark-disband': {
      const prNumber = validatePrNumber(args.pr);
      const result = await actionMarkDisband(prNumber);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'cleanup': {
      const prNumber = validatePrNumber(args.pr);
      const result = await actionCleanup(prNumber);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'disband': {
      const prNumber = validatePrNumber(args.pr);
      const result = await actionDisband(prNumber);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default:
      throw new ScannerError(
        `Unknown action: '${action}' — must be one of: check-expired, mark-disband, cleanup, disband`,
      );
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${msg}`);
  process.exit(1);
});
