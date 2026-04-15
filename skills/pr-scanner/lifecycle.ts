#!/usr/bin/env tsx
/**
 * skills/pr-scanner/lifecycle.ts — PR discussion group lifecycle management.
 *
 * Issue #2221: Manages the lifecycle of PR discussion groups:
 * - Detects expired discussions (state=reviewing, expiresAt < now)
 * - Sends disband request cards with 24h cooldown
 * - Executes disband on user confirmation
 *
 * CLI Actions:
 *   --action check-expired    Find expired PR discussions eligible for disband request
 *   --action mark-disband     Update disbandRequested timestamp for a PR
 *   --action confirm-disband  Verify state and prepare for disband execution
 *
 * State file schema (compatible with scanner.ts from PR #2373):
 *   {
 *     "prNumber": number,
 *     "chatId": string | null,
 *     "state": "reviewing" | "approved" | "closed",
 *     "createdAt": string,   // ISO 8601 Z-suffix
 *     "updatedAt": string,   // ISO 8601 Z-suffix
 *     "expiresAt": string,   // ISO 8601 Z-suffix
 *     "disbandRequested": string | null  // ISO 8601 Z-suffix, null = never requested
 *   }
 *
 * Environment variables:
 *   PR_STATE_DIR             Directory for state files (default: workspace/schedules/.temp-chats)
 *   DISBAND_COOLDOWN_HOURS   Hours between disband request cards (default: 24)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error
 */

import { readdir, readFile, writeFile, stat, mkdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { acquireLock } from '../chat/lock.js';

// ============================================================================
// Types (compatible with scanner.ts schema from PR #2373)
// ============================================================================

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
  disbandEligible: boolean;
  /** Hours since last disband request (null if never requested) */
  hoursSinceLastRequest: number | null;
  filePath: string;
}

// ============================================================================
// Constants
// ============================================================================

const PR_FILE_REGEX = /^pr-(\d+)\.json$/;
const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DEFAULT_STATE_DIR = 'workspace/schedules/.temp-chats';
const DEFAULT_DISBAND_COOLDOWN_HOURS = 24;

// ============================================================================
// Helpers
// ============================================================================

function nowISO(): string {
  return new Date().toISOString();
}

function exitWithError(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/**
 * Atomic file write: write to temp file then rename.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  // Use rename for atomicity
  const { rename } = await import('node:fs/promises');
  await rename(tmpFile, filePath);
}

/**
 * Parse and validate a PR state file.
 */
function parsePRStateFile(json: string, filePath: string): PRStateFile {
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

  // Required fields
  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }
  if (typeof obj.state !== 'string' || !['reviewing', 'approved', 'closed'].includes(obj.state)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new Error(`State file '${filePath}' has invalid 'createdAt'`);
  }
  if (typeof obj.updatedAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.updatedAt)) {
    throw new Error(`State file '${filePath}' has invalid 'updatedAt'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new Error(`State file '${filePath}' has invalid 'expiresAt'`);
  }

  // Optional fields
  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }
  if (obj.disbandRequested != null && typeof obj.disbandRequested !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested'`);
  }
  if (obj.disbandRequested != null && typeof obj.disbandRequested === 'string' && !UTC_DATETIME_REGEX.test(obj.disbandRequested)) {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested' format`);
  }

  return data as PRStateFile;
}

/**
 * Calculate hours between two ISO timestamps.
 */
function hoursBetween(earlier: string, later: string): number {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / (1000 * 60 * 60);
}

// ============================================================================
// Actions
// ============================================================================

/**
 * check-expired: Find expired PR discussions eligible for disband request.
 *
 * Scans state files for:
 * - state === 'reviewing' AND expiresAt < now (expired)
 * - disbandRequested is null OR disbandRequested < now - cooldown (eligible)
 *
 * Outputs JSON array of expired PRs.
 */
async function checkExpired(): Promise<void> {
  const stateDir = resolve(process.env.PR_STATE_DIR || DEFAULT_STATE_DIR);
  const cooldownHours = parseInt(process.env.DISBAND_COOLDOWN_HOURS || '', 10) || DEFAULT_DISBAND_COOLDOWN_HOURS;
  const now = nowISO();

  // Ensure directory exists
  try {
    await stat(stateDir);
  } catch {
    // No state directory = no expired PRs
    console.log(JSON.stringify({ action: 'check-expired', expired: [], now }));
    return;
  }

  // Read all pr-*.json files
  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch {
    exitWithError('Failed to read state directory');
    return; // unreachable, but helps TypeScript
  }

  const expired: ExpiredPR[] = [];

  for (const fileName of files) {
    const match = PR_FILE_REGEX.exec(fileName);
    if (!match) continue;

    const filePath = resolve(stateDir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      console.error(`WARN: Failed to read ${filePath}, skipping`);
      continue;
    }

    let stateFile: PRStateFile;
    try {
      stateFile = parsePRStateFile(content, filePath);
    } catch (err) {
      console.error(`WARN: ${err instanceof Error ? err.message : err}, skipping`);
      continue;
    }

    // Only interested in reviewing state
    if (stateFile.state !== 'reviewing') continue;

    // Check if expired
    if (stateFile.expiresAt >= now) continue;

    // Calculate disband eligibility
    let disbandEligible = false;
    let hoursSinceLastRequest: number | null = null;

    if (stateFile.disbandRequested === null) {
      // Never requested — eligible
      disbandEligible = true;
    } else {
      hoursSinceLastRequest = hoursBetween(stateFile.disbandRequested, now);
      if (hoursSinceLastRequest >= cooldownHours) {
        disbandEligible = true;
      }
    }

    expired.push({
      prNumber: stateFile.prNumber,
      chatId: stateFile.chatId,
      state: stateFile.state,
      expiresAt: stateFile.expiresAt,
      disbandRequested: stateFile.disbandRequested,
      disbandEligible,
      hoursSinceLastRequest,
      filePath,
    });
  }

  console.log(JSON.stringify({ action: 'check-expired', expired, now, cooldownHours }));
}

/**
 * mark-disband: Update disbandRequested timestamp for a PR.
 *
 * Usage: --action mark-disband --pr 123
 *
 * Atomically updates the state file with the current timestamp.
 * Requires a file lock to prevent concurrent modification.
 */
async function markDisband(prNumber: number): Promise<void> {
  const stateDir = resolve(process.env.PR_STATE_DIR || DEFAULT_STATE_DIR);
  const fileName = `pr-${prNumber}.json`;
  const filePath = resolve(stateDir, fileName);
  const now = nowISO();

  // Read current state
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    exitWithError(`State file not found for PR #${prNumber}: ${filePath}`);
    return; // unreachable
  }

  let stateFile: PRStateFile;
  try {
    stateFile = parsePRStateFile(content, filePath);
  } catch (err) {
    exitWithError(`Invalid state file: ${err instanceof Error ? err.message : err}`);
    return; // unreachable
  }

  // Acquire lock
  const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);

  try {
    // Re-read under lock
    const currentContent = await readFile(filePath, 'utf-8');
    const currentState = parsePRStateFile(currentContent, filePath);

    // Update disbandRequested
    const updated: PRStateFile = {
      ...currentState,
      disbandRequested: now,
      updatedAt: now,
    };

    await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');

    console.log(JSON.stringify({
      action: 'mark-disband',
      success: true,
      prNumber: updated.prNumber,
      disbandRequested: now,
    }));
  } finally {
    await lock.release();
  }
}

/**
 * confirm-disband: Verify PR state and prepare for disband execution.
 *
 * Usage: --action confirm-disband --pr 123
 *
 * Checks:
 * - State file exists
 * - state === 'reviewing' (reject if not)
 * - Returns the chatId for group dissolution
 *
 * Does NOT execute the disband itself — the schedule handles that via lark-cli.
 */
async function confirmDisband(prNumber: number): Promise<void> {
  const stateDir = resolve(process.env.PR_STATE_DIR || DEFAULT_STATE_DIR);
  const fileName = `pr-${prNumber}.json`;
  const filePath = resolve(stateDir, fileName);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    exitWithError(`State file not found for PR #${prNumber}: ${filePath}`);
    return; // unreachable
  }

  let stateFile: PRStateFile;
  try {
    stateFile = parsePRStateFile(content, filePath);
  } catch (err) {
    exitWithError(`Invalid state file: ${err instanceof Error ? err.message : err}`);
    return; // unreachable
  }

  // Verify state is reviewing
  if (stateFile.state !== 'reviewing') {
    console.log(JSON.stringify({
      action: 'confirm-disband',
      success: false,
      reason: `PR #${prNumber} state is '${stateFile.state}', expected 'reviewing'. Disband rejected.`,
      prNumber,
      currentState: stateFile.state,
    }));
    return;
  }

  // Return disband instructions
  console.log(JSON.stringify({
    action: 'confirm-disband',
    success: true,
    prNumber: stateFile.prNumber,
    chatId: stateFile.chatId,
    state: stateFile.state,
    instructions: {
      dissolveGroup: stateFile.chatId
        ? `lark-cli api DELETE /open-apis/im/v1/chats/${stateFile.chatId}`
        : null,
      removeLabel: `gh pr edit ${stateFile.prNumber} --repo hs3180/disclaude --remove-label "pr-scanner:reviewing"`,
      deleteStateFile: filePath,
    },
  }));
}

/**
 * cleanup-state: Remove state file after successful disband.
 *
 * Usage: --action cleanup-state --pr 123
 *
 * Safe to call after disband execution. Removes the state file under lock.
 */
async function cleanupState(prNumber: number): Promise<void> {
  const stateDir = resolve(process.env.PR_STATE_DIR || DEFAULT_STATE_DIR);
  const fileName = `pr-${prNumber}.json`;
  const filePath = resolve(stateDir, fileName);

  // Acquire lock
  const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);

  try {
    // Verify file still exists
    try {
      await stat(filePath);
    } catch {
      console.log(JSON.stringify({
        action: 'cleanup-state',
        success: false,
        reason: `State file not found for PR #${prNumber} (already cleaned up)`,
        prNumber,
      }));
      return;
    }

    // Delete state file
    await unlink(filePath);

    console.log(JSON.stringify({
      action: 'cleanup-state',
      success: true,
      prNumber,
      message: `State file for PR #${prNumber} removed`,
    }));
  } finally {
    await lock.release();
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const actionIndex = args.indexOf('--action');
  const prIndex = args.indexOf('--pr');

  if (actionIndex === -1) {
    exitWithError('Missing --action argument. Valid actions: check-expired, mark-disband, confirm-disband, cleanup-state');
  }

  const action = args[actionIndex + 1];
  if (!action) {
    exitWithError('Missing action value after --action');
  }

  switch (action) {
    case 'check-expired':
      await checkExpired();
      break;

    case 'mark-disband': {
      if (prIndex === -1 || !args[prIndex + 1]) {
        exitWithError('Missing --pr argument for mark-disband action');
      }
      const prNumber = parseInt(args[prIndex + 1], 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        exitWithError(`Invalid PR number: ${args[prIndex + 1]}`);
      }
      await markDisband(prNumber);
      break;
    }

    case 'confirm-disband': {
      if (prIndex === -1 || !args[prIndex + 1]) {
        exitWithError('Missing --pr argument for confirm-disband action');
      }
      const prNumber = parseInt(args[prIndex + 1], 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        exitWithError(`Invalid PR number: ${args[prIndex + 1]}`);
      }
      await confirmDisband(prNumber);
      break;
    }

    case 'cleanup-state': {
      if (prIndex === -1 || !args[prIndex + 1]) {
        exitWithError('Missing --pr argument for cleanup-state action');
      }
      const prNumber = parseInt(args[prIndex + 1], 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        exitWithError(`Invalid PR number: ${args[prIndex + 1]}`);
      }
      await cleanupState(prNumber);
      break;
    }

    default:
      exitWithError(`Unknown action: ${action}. Valid actions: check-expired, mark-disband, confirm-disband, cleanup-state`);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
