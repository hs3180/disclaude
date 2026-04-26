#!/usr/bin/env tsx
/**
 * schedules/discussion-lifecycle/lifecycle.ts — Discussion group lifecycle management CLI.
 *
 * Manages the lifecycle of PR discussion groups created by the PR Scanner v2:
 * - Detects expired reviewing states
 * - Sends disband request cards (with 24h dedup)
 * - Executes disband after human confirmation
 * - Cleans up state files and removes GitHub labels
 *
 * Designed to be called from the discussion-lifecycle SCHEDULE.md prompt.
 *
 * Usage:
 *   npx tsx lifecycle.ts --action <action> [options]
 *
 * Actions:
 *   check-expired   Scan .temp-chats/ for expired PRs, output JSON list
 *   mark-disband    Update disbandRequested timestamp on a state file
 *   disband         Execute disband: lark-cli disband + delete state + remove label
 *   status          List all tracked PRs with lifecycle info
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error or fatal failure
 */

import { readdir, readFile, writeFile, unlink, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base directory for state files. Can be overridden via env for testing. */
const STATE_DIR = process.env.PR_SCANNER_STATE_DIR ?? resolve(process.cwd(), '.temp-chats');

/** Minimum interval between disband request cards for the same PR (24h in ms). */
const DISBAND_REQUEST_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** GitHub repository for `gh` CLI commands. */
const REPO = process.env.PR_SCANNER_REPO ?? 'hs3180/disclaude';

/** GitHub label for tracking reviewing state. */
const REVIEWING_LABEL = 'pr-scanner:reviewing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed state values per design spec. */
type PRState = 'reviewing' | 'approved' | 'closed';

/** State file schema per design spec. */
interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

/** Expired PR info returned by check-expired action. */
interface ExpiredPR {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  expiresAt: string;
  disbandRequested: string | null;
  disbandEligible: boolean; // true if 24h since last request (or never requested)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function exitError(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** Atomic write: write to temp file then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Get state file path for a PR number. */
function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

/** Parse a state file, returning null on any error. */
async function readStateFile(filePath: string): Promise<PRStateFile | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.prNumber === 'number' &&
      typeof parsed.state === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.updatedAt === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return parsed as PRStateFile;
    }
    return null;
  } catch {
    return null;
  }
}

/** List all state files in the state directory. */
async function listStateFiles(): Promise<string[]> {
  try {
    const files = await readdir(STATE_DIR);
    return files
      .filter((f) => /^pr-\d+\.json$/.test(f))
      .map((f) => resolve(STATE_DIR, f));
  } catch {
    return [];
  }
}

/** Read all valid state files. */
async function readAllStates(): Promise<PRStateFile[]> {
  const files = await listStateFiles();
  const states: PRStateFile[] = [];
  for (const f of files) {
    const state = await readStateFile(f);
    if (state) states.push(state);
  }
  return states;
}

// ---------------------------------------------------------------------------
// GitHub Label Operations
// ---------------------------------------------------------------------------

/**
 * Remove a GitHub label from a PR. Non-blocking: logs errors but does not throw.
 */
async function removeLabel(prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', REPO,
      '--remove-label', label,
    ], { timeout: 15000 });
    console.error(`[label] Removed '${label}' from PR #${prNumber}`);
  } catch (err) {
    console.error(`[label:warn] Failed to remove '${label}' from PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Lark CLI Operations
// ---------------------------------------------------------------------------

/**
 * Disband a group chat via lark-cli. Non-blocking: logs errors but does not throw.
 * @returns true if disband succeeded, false otherwise
 */
async function disbandGroup(chatId: string): Promise<boolean> {
  try {
    await execFileAsync('lark-cli', [
      'im', 'chat-delete',
      '--chat-id', chatId,
    ], { timeout: 30000 });
    console.error(`[lark] Disbanded group ${chatId}`);
    return true;
  } catch (err) {
    console.error(`[lark:warn] Failed to disband group ${chatId}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * check-expired: Scan .temp-chats/ for expired PRs (now > expiresAt).
 * Returns JSON list of expired PRs with dedup info.
 */
async function actionCheckExpired(): Promise<void> {
  const now = new Date();
  const states = await readAllStates();
  const expired: ExpiredPR[] = [];

  for (const s of states) {
    const expiresAtDate = new Date(s.expiresAt);

    // Check if expired
    if (now <= expiresAtDate) continue;

    // Only process reviewing state (approved/closed are already handled)
    if (s.state !== 'reviewing') continue;

    // Check 24h dedup for disband request
    let disbandEligible = true;
    if (s.disbandRequested) {
      const lastRequested = new Date(s.disbandRequested);
      const elapsed = now.getTime() - lastRequested.getTime();
      if (elapsed < DISBAND_REQUEST_INTERVAL_MS) {
        disbandEligible = false;
      }
    }

    expired.push({
      prNumber: s.prNumber,
      chatId: s.chatId,
      state: s.state,
      expiresAt: s.expiresAt,
      disbandRequested: s.disbandRequested,
      disbandEligible,
    });
  }

  console.log(JSON.stringify(expired, null, 2));
}

/**
 * mark-disband: Update disbandRequested timestamp on a state file.
 * Used after sending a disband request card to prevent duplicate sends.
 */
async function actionMarkDisband(prNumber: number): Promise<void> {
  const filePath = stateFilePath(prNumber);

  const existing = await readStateFile(filePath);
  if (!existing) {
    exitError(`No state file found for PR #${prNumber}. Run create-state first.`);
  }

  existing.disbandRequested = nowISO();
  existing.updatedAt = nowISO();

  await atomicWrite(filePath, JSON.stringify(existing, null, 2) + '\n');
  console.log(JSON.stringify(existing, null, 2));
}

/**
 * disband: Execute the full disband flow:
 * 1. Check state is still reviewing (reject if not)
 * 2. Disband group via lark-cli (if chatId exists)
 * 3. Delete state file
 * 4. Remove reviewing label from PR
 */
async function actionDisband(prNumber: number): Promise<void> {
  const filePath = stateFilePath(prNumber);

  const existing = await readStateFile(filePath);
  if (!existing) {
    exitError(`No state file found for PR #${prNumber}.`);
  }

  // Step 1: Verify state is still reviewing
  if (existing.state !== 'reviewing') {
    exitError(`Cannot disband PR #${prNumber}: state is '${existing.state}', expected 'reviewing'. Only reviewing PRs can be disbanded.`);
  }

  const chatId = existing.chatId;
  let disbandSuccess = true;

  // Step 2: Disband group via lark-cli (if chatId exists)
  if (chatId) {
    disbandSuccess = await disbandGroup(chatId);
  } else {
    console.error(`[lark] No chatId for PR #${prNumber}, skipping group disband`);
  }

  // Step 3: Delete state file (even if disband failed — graceful degradation)
  try {
    await unlink(filePath);
    console.error(`[cleanup] Deleted state file for PR #${prNumber}`);
  } catch (err) {
    console.error(`[cleanup:warn] Failed to delete state file for PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
  }

  // Step 4: Remove reviewing label (non-blocking)
  await removeLabel(prNumber, REVIEWING_LABEL);

  // Output result
  const result = {
    prNumber,
    disbanded: disbandSuccess,
    chatId,
    timestamp: nowISO(),
  };
  console.log(JSON.stringify(result, null, 2));
}

/**
 * status: List all tracked PRs with lifecycle-relevant info (human-readable).
 */
async function actionStatus(): Promise<void> {
  const states = await readAllStates();

  if (states.length === 0) {
    console.log('No tracked PRs.');
    return;
  }

  const now = new Date();

  for (const s of states) {
    const expiresAtDate = new Date(s.expiresAt);
    const isExpired = now > expiresAtDate;
    const statusIcon = isExpired ? '⏰ EXPIRED' : '🔍 active';

    const chatInfo = s.chatId ? `chat=${s.chatId}` : 'no chat';
    const disbandInfo = s.disbandRequested
      ? `disbandRequested=${s.disbandRequested}`
      : 'never requested disband';

    console.log(`  PR #${s.prNumber} | ${statusIcon} | state=${s.state} | ${chatInfo} | ${disbandInfo} | expires=${s.expiresAt}`);
  }
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): {
  action: string;
  pr?: number;
} {
  const result: { action: string; pr?: number } = { action: '' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--action':
        result.action = args[++i];
        break;
      case '--pr':
        result.pr = parseInt(args[++i], 10);
        break;
      default:
        // Ignore unknown args
        break;
    }
  }

  return result;
}

function printUsage(): void {
  console.log(`Usage: lifecycle.ts --action <action> [options]

Actions:
  check-expired               List expired reviewing PRs with dedup info
  mark-disband --pr <number>  Update disbandRequested timestamp (after sending card)
  disband --pr <number>       Execute disband: lark-cli + delete state + remove label
  status                      List all tracked PRs with lifecycle info

Options:
  --action <action>   Action to perform (required)
  --pr <number>       PR number (for mark-disband, disband)

Environment variables:
  PR_SCANNER_STATE_DIR            Directory for state files (default: .temp-chats/)
  PR_SCANNER_REPO                 GitHub repo for gh CLI (default: hs3180/disclaude)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { action, pr } = parseArgs(process.argv.slice(2));

  if (!action) {
    printUsage();
    process.exit(1);
  }

  switch (action) {
    case 'check-expired':
      await actionCheckExpired();
      break;

    case 'mark-disband':
      if (!pr) exitError('--pr <number> is required for mark-disband');
      await actionMarkDisband(pr);
      break;

    case 'disband':
      if (!pr) exitError('--pr <number> is required for disband');
      await actionDisband(pr);
      break;

    case 'status':
      await actionStatus();
      break;

    default:
      exitError(`Unknown action '${action}'. Run without args for usage.`);
  }
}

main().catch((err) => {
  exitError(err instanceof Error ? err.message : String(err));
});
