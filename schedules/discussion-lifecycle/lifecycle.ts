#!/usr/bin/env tsx
/**
 * schedules/discussion-lifecycle/lifecycle.ts — Manage PR discussion group expiry and disbanding.
 *
 * Scans `.temp-chats/` for expired PR state files, sends disband request cards,
 * and handles group dissolution upon user confirmation.
 *
 * CLI Actions:
 *   check-expired           Find all expired PR state files (now > expiresAt)
 *   mark-disband <prNumber> Update disbandRequested timestamp for a PR
 *   disband <prNumber>      Remove reviewing label + dismiss group + delete state file
 *   help                    Show usage information
 *
 * Environment variables (optional):
 *   STATE_DIR               Directory for PR state files (default: .temp-chats)
 *   REPO                    GitHub repository (default: hs3180/disclaude)
 *   SKIP_LARK_CHECK         Set to '1' to skip lark-cli availability check (for testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error
 */

import { readdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const VALID_STATES = ['reviewing', 'approved', 'closed'] as const;
type PRState = (typeof VALID_STATES)[number];
const LARK_TIMEOUT_MS = 30_000;

interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

interface ExpiredPR {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  expiresAt: string;
  disbandRequested: string | null;
  filePath: string;
}

// ---- Helpers ----

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isValidTimestamp(ts: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3,6})?Z$/.test(ts);
}

function getStateDir(): string {
  return process.env.STATE_DIR || '.temp-chats';
}

function getRepo(): string {
  return process.env.REPO || 'hs3180/disclaude';
}

function getStateFilePath(prNumber: number): string {
  return resolve(getStateDir(), `pr-${prNumber}.json`);
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmpFile, filePath);
}

function parseStateFile(json: string, filePath: string): PRStateFile {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error(`File ${filePath} is not valid JSON`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`File ${filePath} is not a valid JSON object`);
  }
  const rec = obj as Record<string, unknown>;

  if (typeof rec.prNumber !== 'number' || !Number.isInteger(rec.prNumber) || rec.prNumber <= 0) {
    throw new Error(`File ${filePath}: invalid or missing 'prNumber'`);
  }
  if (!VALID_STATES.includes(rec.state as PRState)) {
    throw new Error(`File ${filePath}: invalid 'state' "${rec.state}"`);
  }
  if (typeof rec.createdAt !== 'string' || !isValidTimestamp(rec.createdAt)) {
    throw new Error(`File ${filePath}: invalid or missing 'createdAt'`);
  }

  return {
    prNumber: rec.prNumber,
    chatId: typeof rec.chatId === 'string' ? rec.chatId : null,
    state: rec.state as PRState,
    createdAt: rec.createdAt,
    updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : rec.createdAt,
    expiresAt: typeof rec.expiresAt === 'string' ? rec.expiresAt : rec.createdAt,
    disbandRequested: typeof rec.disbandRequested === 'string' ? rec.disbandRequested : null,
  };
}

/**
 * Dismiss a Feishu group via lark-cli.
 * Uses the raw API call: DELETE /open-apis/im/v1/chats/{chatId}
 */
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
 * Remove the pr-scanner:reviewing label from a PR.
 * Non-blocking: logs warning on failure but does not throw.
 */
async function removeReviewingLabel(prNumber: number): Promise<void> {
  const repo = getRepo();
  try {
    await execFileAsync(
      'gh',
      ['pr', 'edit', String(prNumber), '--repo', repo, '--remove-label', 'pr-scanner:reviewing'],
      { timeout: 15_000 },
    );
    console.log(`OK: Removed reviewing label from PR #${prNumber}`);
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = execErr.stderr ?? execErr.message ?? 'unknown error';
    console.error(`WARN: Failed to remove reviewing label from PR #${prNumber}: ${errorMsg.replace(/\n/g, ' ').trim()}`);
  }
}

// ---- Actions ----

/**
 * check-expired: Find all expired PR state files (now > expiresAt).
 * Outputs JSON array of expired PRs.
 */
async function checkExpired(): Promise<void> {
  const stateDir = resolve(getStateDir());

  let dirExists: boolean;
  try {
    await stat(stateDir);
    dirExists = true;
  } catch {
    dirExists = false;
  }

  if (!dirExists) {
    console.log('[]');
    return;
  }

  const now = nowISO();
  const files = await readdir(stateDir);
  const jsonFiles = files.filter(f => f.startsWith('pr-') && f.endsWith('.json'));

  const expired: ExpiredPR[] = [];

  for (const fileName of jsonFiles) {
    const filePath = resolve(stateDir, fileName);
    const canonicalDir = await import('node:fs/promises').then(m => m.realpath(stateDir));
    const canonicalFile = await import('node:fs/promises').then(m => m.realpath(filePath));

    // Security: ensure file is within stateDir
    if (dirname(canonicalFile) !== canonicalDir) {
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
      state = parseStateFile(content, filePath);
    } catch (err) {
      console.error(`WARN: Skipping corrupted state file: ${filePath} (${err})`);
      continue;
    }

    // Check if expired
    const expiresAt = state.expiresAt;
    if (isValidTimestamp(expiresAt) && expiresAt < now) {
      expired.push({
        prNumber: state.prNumber,
        chatId: state.chatId,
        state: state.state,
        createdAt: state.createdAt,
        expiresAt: state.expiresAt,
        disbandRequested: state.disbandRequested,
        filePath,
      });
    }
  }

  console.log(JSON.stringify(expired, null, 2));
}

/**
 * mark-disband: Update disbandRequested timestamp for a PR.
 */
async function markDisband(prNumber: number): Promise<void> {
  const filePath = getStateFilePath(prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    console.error(`ERROR: State file not found for PR #${prNumber}: ${filePath}`);
    process.exit(1);
  }

  let state: PRStateFile;
  try {
    state = parseStateFile(content, filePath);
  } catch (err) {
    console.error(`ERROR: Corrupted state file for PR #${prNumber}: ${err}`);
    process.exit(1);
  }

  const now = nowISO();
  const updated: PRStateFile = {
    ...state,
    disbandRequested: now,
    updatedAt: now,
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');
  console.log(JSON.stringify({ prNumber, disbandRequested: now }));
}

/**
 * disband: Remove reviewing label + dismiss group + delete state file.
 */
async function disband(prNumber: number): Promise<void> {
  const filePath = getStateFilePath(prNumber);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    console.error(`ERROR: State file not found for PR #${prNumber}: ${filePath}`);
    process.exit(1);
  }

  let state: PRStateFile;
  try {
    state = parseStateFile(content, filePath);
  } catch (err) {
    console.error(`ERROR: Corrupted state file for PR #${prNumber}: ${err}`);
    process.exit(1);
  }

  // Validate state before disbanding
  if (state.state !== 'reviewing') {
    console.error(`ERROR: Cannot disband PR #${prNumber}: state is '${state.state}', expected 'reviewing'`);
    process.exit(1);
  }

  const results: { label: boolean; group: boolean; file: boolean } = {
    label: false,
    group: false,
    file: false,
  };

  // Step 1: Remove reviewing label (non-blocking)
  await removeReviewingLabel(prNumber);
  results.label = true;

  // Step 2: Dismiss group if chatId exists
  if (state.chatId) {
    const dismissResult = await dismissGroup(state.chatId);
    if (dismissResult.success) {
      console.log(`OK: Dismissed group ${state.chatId} for PR #${prNumber}`);
      results.group = true;
    } else {
      console.error(`WARN: Failed to dismiss group ${state.chatId} for PR #${prNumber}: ${dismissResult.error}`);
      // Continue to delete state file even if dismissal fails
    }
  } else {
    console.log(`INFO: No chatId for PR #${prNumber}, skipping group dismissal`);
    results.group = true;
  }

  // Step 3: Delete state file
  try {
    await unlink(filePath);
    console.log(`OK: Deleted state file for PR #${prNumber}`);
    results.file = true;
  } catch (err) {
    console.error(`WARN: Failed to delete state file for PR #${prNumber}: ${err}`);
  }

  console.log(JSON.stringify({ prNumber, results }));
}

function printHelp(): void {
  console.log(`
Usage: npx tsx schedules/discussion-lifecycle/lifecycle.ts <action> [args]

Actions:
  check-expired           Find all expired PR state files (now > expiresAt)
  mark-disband <prNumber> Update disbandRequested timestamp for a PR
  disband <prNumber>      Remove reviewing label + dismiss group + delete state file
  help                    Show this help message

Environment:
  STATE_DIR     Directory for PR state files (default: .temp-chats)
  REPO          GitHub repository (default: hs3180/disclaude)
`);
}

// ---- Main ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args[0];

  switch (action) {
    case 'check-expired': {
      // Check lark-cli availability (skippable for testing)
      if (process.env.SKIP_LARK_CHECK !== '1') {
        try {
          await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
        } catch {
          console.error('ERROR: Missing required dependency: lark-cli not found in PATH');
          process.exit(1);
        }
      }
      await checkExpired();
      break;
    }
    case 'mark-disband': {
      const prNumber = parseInt(args[1], 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error('ERROR: Invalid PR number. Usage: lifecycle.ts mark-disband <prNumber>');
        process.exit(1);
      }
      await markDisband(prNumber);
      break;
    }
    case 'disband': {
      const prNumber = parseInt(args[1], 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) {
        console.error('ERROR: Invalid PR number. Usage: lifecycle.ts disband <prNumber>');
        process.exit(1);
      }
      await disband(prNumber);
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`ERROR: Unknown action '${action}'. Run with 'help' for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
