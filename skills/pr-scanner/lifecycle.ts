#!/usr/bin/env tsx
/**
 * skills/pr-scanner/lifecycle.ts — PR Scanner v2: discussion group lifecycle management.
 *
 * Phase 2 of PR Scanner: manages expired PR discussion groups by detecting
 * stale entries and coordinating disband requests.
 *
 * CLI Actions:
 *   check-expired   — Scan .temp-chats/ for expired reviewing PRs
 *   mark-disband    — Set disbandRequested timestamp on a PR state file
 *
 * Usage:
 *   npx tsx lifecycle.ts --action check-expired
 *   npx tsx lifecycle.ts --action mark-disband --pr 123
 *
 * Environment variables:
 *   PR_SCANNER_STATE_DIR       State file directory (default: .temp-chats)
 *   PR_SCANNER_DISBAND_COOLDOWN  Cooldown hours before resending disband (default: 24)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, I/O failure)
 */

import { readFile, writeFile, rename, mkdir, stat, realpath, readdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseStateFile,
  parsePrNumberFromFileName,
  stateFilePath,
  isValidState,
  validateStateFileData,
  nowISO,
  UTC_DATETIME_REGEX,
  DISBAND_COOLDOWN_HOURS,
  STATE_FILE_REGEX,
  ValidationError,
  type PrStateFile,
  type ExpiredPr,
} from './schema.js';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const REVIEWING_LABEL = 'pr-scanner:reviewing';

// ---- Helpers ----

/** Atomic file write: write to temp file then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Parse CLI arguments into a simple key-value map */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
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

/** Get cooldown hours from env or default */
function getCooldownHours(): number {
  const env = process.env.PR_SCANNER_DISBAND_COOLDOWN;
  if (env) {
    const parsed = parseFloat(env);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DISBAND_COOLDOWN_HOURS;
}

/** Get state directory from env or default */
function getStateDir(): string {
  return process.env.PR_SCANNER_STATE_DIR ?? '.temp-chats';
}

/** Ensure state directory exists */
async function ensureStateDir(stateDir: string): Promise<string> {
  const resolved = resolve(stateDir);
  try {
    await mkdir(resolved, { recursive: true });
  } catch {
    // Directory may already exist
  }
  return resolved;
}

/** Read and parse all valid state files from the state directory */
async function readAllStates(stateDir: string): Promise<PrStateFile[]> {
  let canonicalDir: string;
  try {
    canonicalDir = await realpath(stateDir);
  } catch {
    return [];
  }

  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    return [];
  }

  const states: PrStateFile[] = [];

  for (const fileName of files) {
    if (!STATE_FILE_REGEX.test(fileName)) {
      continue;
    }

    const filePath = resolve(canonicalDir, fileName);
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

    try {
      const state = parseStateFile(content, filePath);
      states.push(state);
    } catch {
      // Skip corrupted files
    }
  }

  return states;
}

/** Remove a GitHub label from a PR via gh CLI. Failures logged, not thrown. */
async function removeLabel(repo: string, prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync('gh', ['pr', 'edit', String(prNumber), '--repo', repo, '--remove-label', label], {
      timeout: 15_000,
    });
  } catch (err) {
    console.error(`WARN: Failed to remove label '${label}' from PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
  }
}

// ---- Action Handlers ----

/**
 * check-expired: Scan .temp-chats/ for reviewing PRs where now > expiresAt.
 *
 * For each expired PR, determine if a disband request needs to be sent:
 * - disbandRequested is null → needs request
 * - disbandRequested was set >= cooldown hours ago → needs request (resend)
 * - disbandRequested was set < cooldown hours ago → skip (recently sent)
 *
 * Outputs JSON array of { prNumber, chatId, needsDisbandRequest }.
 */
async function actionCheckExpired(stateDir: string): Promise<void> {
  const states = await readAllStates(stateDir);
  const now = new Date(nowISO());
  const cooldownMs = getCooldownHours() * 3600 * 1000;

  const expired: ExpiredPr[] = [];

  for (const s of states) {
    // Only process reviewing PRs that have expired
    if (s.state !== 'reviewing') {
      continue;
    }

    const expiresAt = new Date(s.expiresAt);
    if (now <= expiresAt) {
      continue; // Not yet expired
    }

    // Determine if disband request is needed
    let needsDisbandRequest = false;
    if (s.disbandRequested === null) {
      // Never sent a disband request → need to send one
      needsDisbandRequest = true;
    } else {
      // Disband request was sent before — check cooldown
      const lastRequest = new Date(s.disbandRequested);
      const elapsed = now.getTime() - lastRequest.getTime();
      if (elapsed >= cooldownMs) {
        needsDisbandRequest = true;
      }
    }

    expired.push({
      prNumber: s.prNumber,
      chatId: s.chatId,
      needsDisbandRequest,
    });
  }

  console.log(JSON.stringify(expired));
}

/**
 * mark-disband: Set disbandRequested timestamp on a PR state file.
 *
 * Usage: --action mark-disband --pr 123
 * Updates disbandRequested to current time and updatedAt to current time.
 */
async function actionMarkDisband(stateDir: string, prNumber: number): Promise<void> {
  const filePath = stateFilePath(stateDir, prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    console.error(`ERROR: State file for PR #${prNumber} not found`);
    process.exit(1);
  }

  let stateFile: PrStateFile;
  try {
    stateFile = parseStateFile(content, filePath);
  } catch (err) {
    console.error(`ERROR: Corrupted state file: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const now = nowISO();
  const updated: PrStateFile = {
    ...stateFile,
    updatedAt: now,
    disbandRequested: now,
  };

  // Validate the updated file
  validateStateFileData(updated, filePath);

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  console.log(JSON.stringify(updated));
}

/**
 * cleanup: Delete state file and remove GitHub label for a disbanded PR.
 *
 * Usage: --action cleanup --pr 123 [--repo owner/repo]
 */
async function actionCleanup(stateDir: string, prNumber: number, repo?: string): Promise<void> {
  const filePath = stateFilePath(stateDir, prNumber);

  // Read state file for chatId (for confirmation output)
  let chatId = '';
  try {
    const content = await readFile(filePath, 'utf-8');
    const state = parseStateFile(content, filePath);
    chatId = state.chatId;
  } catch {
    // File may already be deleted
  }

  // Delete the state file
  try {
    await unlink(filePath);
  } catch {
    console.error(`WARN: State file for PR #${prNumber} not found or already deleted`);
  }

  // Remove GitHub label if repo specified
  if (repo) {
    await removeLabel(repo, prNumber, REVIEWING_LABEL);
  }

  const result = {
    prNumber,
    chatId,
    action: 'cleaned-up',
    labelRemoved: !!repo,
  };
  console.log(JSON.stringify(result));
}

// ---- Main ----

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action;

  if (!action) {
    console.error('ERROR: --action is required. Valid actions: check-expired, mark-disband, cleanup');
    process.exit(1);
  }

  const stateDir = await ensureStateDir(getStateDir());

  switch (action) {
    case 'check-expired':
      await actionCheckExpired(stateDir);
      break;

    case 'mark-disband': {
      const prStr = args.pr;
      if (!prStr) {
        console.error('ERROR: --pr is required for mark-disband');
        process.exit(1);
      }
      const prNumber = parseInt(prStr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid --pr value '${prStr}', must be a positive integer`);
        process.exit(1);
      }
      await actionMarkDisband(stateDir, prNumber);
      break;
    }

    case 'cleanup': {
      const prStr = args.pr;
      if (!prStr) {
        console.error('ERROR: --pr is required for cleanup');
        process.exit(1);
      }
      const prNumber = parseInt(prStr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid --pr value '${prStr}', must be a positive integer`);
        process.exit(1);
      }
      await actionCleanup(stateDir, prNumber, args.repo);
      break;
    }

    default:
      console.error(`ERROR: Unknown action '${action}'. Valid actions: check-expired, mark-disband, cleanup`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
