#!/usr/bin/env tsx
/**
 * schedules/discussion-lifecycle/lifecycle.ts — Discussion Group Lifecycle Manager.
 *
 * Issue #2221: Manages discussion group expiration and disband flow.
 * Operates on state files in `.temp-chats/pr-{number}.json` (shared with scanner.ts).
 *
 * CLI Interface (`--action` mode):
 *   --action check-expired                     Scan for expired PRs (now > expiresAt)
 *   --action mark-disband --pr <number>        Update disbandRequested timestamp
 *   --action cleanup --pr <number>             Remove state file (post-disband cleanup)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (missing args, invalid input)
 */

import { readdir, readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

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
  expiredAt: string;
  disbandRequested: string | null;
  hoursSinceExpiry: number;
  hoursSinceDisbandRequest: number | null;
  needsDisbandNotification: boolean;
}

// ---- Constants ----

export const DEFAULT_STATE_DIR = '.temp-chats';
export const VALID_STATES: PRState[] = ['reviewing', 'approved', 'closed'];
export const DISBAND_NOTIFICATION_INTERVAL_HOURS = 24;

/**
 * Resolve the state directory.
 * Priority: PR_STATE_DIR env var > default `.temp-chats` relative to project root.
 */
export function getStateDir(): string {
  const envDir = process.env.PR_STATE_DIR;
  if (envDir) {
    return resolve(envDir);
  }
  return resolve(PROJECT_ROOT, DEFAULT_STATE_DIR);
}

// ---- Validation & Parsing ----

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleError';
  }
}

function parsePRStateFile(json: string, filePath: string): PRStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new LifecycleError(`State file '${filePath}' is not valid JSON`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new LifecycleError(`State file '${filePath}' is not a valid JSON object`);
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new LifecycleError(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  if (!VALID_STATES.includes(obj.state as PRState)) {
    throw new LifecycleError(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }

  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new LifecycleError(`State file '${filePath}' has invalid 'chatId'`);
  }

  if (typeof obj.createdAt !== 'string') {
    throw new LifecycleError(`State file '${filePath}' has missing or invalid 'createdAt'`);
  }

  if (typeof obj.updatedAt !== 'string') {
    throw new LifecycleError(`State file '${filePath}' has missing or invalid 'updatedAt'`);
  }

  if (typeof obj.expiresAt !== 'string') {
    throw new LifecycleError(`State file '${filePath}' has missing or invalid 'expiresAt'`);
  }

  if (obj.disbandRequested !== null && typeof obj.disbandRequested !== 'string') {
    throw new LifecycleError(`State file '${filePath}' has invalid 'disbandRequested'`);
  }

  return data as PRStateFile;
}

// ---- Helpers ----

function nowISO(): string {
  return new Date().toISOString();
}

function stateFilePath(prNumber: number): string {
  return resolve(getStateDir(), `pr-${prNumber}.json`);
}

async function ensureStateDir(): Promise<void> {
  await mkdir(getStateDir(), { recursive: true });
}

/** Atomic write: write to temp file then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Read and parse a state file. Returns null if not found. */
async function readStateFile(prNumber: number): Promise<PRStateFile | null> {
  const filePath = stateFilePath(prNumber);
  try {
    const content = await readFile(filePath, 'utf-8');
    return parsePRStateFile(content, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** Read all state files from the state directory. */
async function readAllStateFiles(): Promise<PRStateFile[]> {
  const results: PRStateFile[] = [];
  const stateDir = getStateDir();
  try {
    const files = await readdir(stateDir);
    const jsonFiles = files.filter((f) => f.startsWith('pr-') && f.endsWith('.json'));

    for (const fileName of jsonFiles) {
      const filePath = resolve(stateDir, fileName);
      try {
        const content = await readFile(filePath, 'utf-8');
        results.push(parsePRStateFile(content, filePath));
      } catch {
        console.error(`WARN: Skipping corrupted state file: ${filePath}`);
      }
    }
  } catch {
    // Directory doesn't exist — return empty
  }
  return results;
}

/** Calculate hours between two ISO timestamps. */
function hoursBetween(pastISO: string, nowMs: number): number {
  const pastMs = new Date(pastISO).getTime();
  return (nowMs - pastMs) / (60 * 60 * 1000);
}

/**
 * Determine if a disband notification should be sent.
 * Returns true if:
 * - No previous disband request, OR
 * - Previous disband request was >= 24 hours ago
 */
function needsDisbandNotification(disbandRequested: string | null, nowMs: number): boolean {
  if (!disbandRequested) return true;
  const hoursSince = hoursBetween(disbandRequested, nowMs);
  return hoursSince >= DISBAND_NOTIFICATION_INTERVAL_HOURS;
}

// ---- Actions ----

async function actionCheckExpired(): Promise<void> {
  const now = Date.now();
  const allStates = await readAllStateFiles();

  const expired: ExpiredPR[] = [];

  for (const stateFile of allStates) {
    const expiresAtMs = new Date(stateFile.expiresAt).getTime();

    // Only include PRs that have expired (now > expiresAt)
    if (now <= expiresAtMs) continue;

    const hoursSinceExpiry = hoursBetween(stateFile.expiresAt, now);
    const hoursSinceDisband = stateFile.disbandRequested
      ? hoursBetween(stateFile.disbandRequested, now)
      : null;
    const shouldNotify = needsDisbandNotification(stateFile.disbandRequested, now);

    expired.push({
      prNumber: stateFile.prNumber,
      chatId: stateFile.chatId,
      state: stateFile.state,
      expiredAt: stateFile.expiresAt,
      disbandRequested: stateFile.disbandRequested,
      hoursSinceExpiry: Math.round(hoursSinceExpiry * 100) / 100,
      hoursSinceDisband: hoursSinceDisband !== null ? Math.round(hoursSinceDisband * 100) / 100 : null,
      needsDisbandNotification: shouldNotify,
    });
  }

  // Sort by expiry time (oldest first)
  expired.sort((a, b) => new Date(a.expiredAt).getTime() - new Date(b.expiredAt).getTime());

  console.log(JSON.stringify(expired, null, 2));
}

async function actionMarkDisband(prNumber: number): Promise<void> {
  await ensureStateDir();

  const existing = await readStateFile(prNumber);
  if (!existing) {
    throw new LifecycleError(`No state file found for PR #${prNumber}`);
  }

  const now = nowISO();
  const updated: PRStateFile = {
    ...existing,
    disbandRequested: now,
    updatedAt: now,
  };

  const filePath = stateFilePath(prNumber);
  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');

  console.log(JSON.stringify(updated, null, 2));
}

async function actionCleanup(prNumber: number): Promise<void> {
  const filePath = stateFilePath(prNumber);

  // Check if file exists
  try {
    await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LifecycleError(`No state file found for PR #${prNumber}`);
    }
    throw err;
  }

  // Delete the state file
  await unlink(filePath);

  const result = {
    prNumber,
    action: 'cleanup',
    deleted: true,
    timestamp: nowISO(),
  };

  console.log(JSON.stringify(result, null, 2));
}

// ---- CLI Argument Parsing ----

interface ParsedArgs {
  action: string;
  pr: number | null;
}

function parseArgs(args: string[]): ParsedArgs {
  let action = '';
  let pr: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action' && i + 1 < args.length) {
      action = args[i + 1];
      i++;
    } else if (args[i] === '--pr' && i + 1 < args.length) {
      const num = Number(args[i + 1]);
      if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
        throw new LifecycleError(`Invalid PR number: '${args[i + 1]}' — must be a positive integer`);
      }
      pr = num;
      i++;
    } else if (!action && !args[i].startsWith('--')) {
      // Positional argument as action (alternative to --action)
      action = args[i];
    }
  }

  if (!action) {
    throw new LifecycleError('Missing required argument: --action <action>');
  }

  return { action, pr };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  switch (parsed.action) {
    case 'check-expired':
      await actionCheckExpired();
      break;

    case 'mark-disband':
      if (!parsed.pr) {
        throw new LifecycleError('Missing required argument: --pr <number> for mark-disband');
      }
      await actionMarkDisband(parsed.pr);
      break;

    case 'cleanup':
      if (!parsed.pr) {
        throw new LifecycleError('Missing required argument: --pr <number> for cleanup');
      }
      await actionCleanup(parsed.pr);
      break;

    default:
      throw new LifecycleError(
        `Unknown action: '${parsed.action}' — valid actions: check-expired, mark-disband, cleanup`,
      );
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
