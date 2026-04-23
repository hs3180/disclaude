#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/lifecycle.ts — Discussion lifecycle management CLI.
 *
 * Manages expiration and disband flow for PR Scanner discussion groups.
 * Works with state files in .temp-chats/ created by scanner.ts.
 *
 * Actions:
 *   check-expired   Find expired reviewing PRs eligible for disband notification
 *   mark-disband    Update disbandRequested timestamp for a PR
 *
 * Usage:
 *   npx tsx lifecycle.ts --action check-expired
 *   npx tsx lifecycle.ts --action mark-disband --pr 123
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid args, file I/O failure)
 *
 * Dependency: scanner.ts (PR #2219 / PR #2761) — shares state file schema
 *   Once scanner.ts is merged, this file should import shared utilities
 *   (nowISO, stateFilePath, atomicWrite, parseStateFile) from ./scanner.js
 *   instead of defining them locally.
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

// ---- Types (mirrors scanner.ts — consolidate after merge) ----

export type PRState = 'reviewing' | 'approved' | 'closed';

/** State file schema per design spec §3.1 */
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
  /** True if disband notification was sent less than 24h ago */
  withinCooldown: boolean;
}

// ---- Constants ----

export const STATE_DIR = '.temp-chats';
/** Minimum interval between disband notifications (24 hours in ms) */
export const DISBAND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ---- Helpers (mirrors scanner.ts — consolidate after merge) ----

/** Get current UTC timestamp in ISO 8601 Z-suffix format (no milliseconds) */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Get state file path for a PR number */
export function stateFilePath(prNumber: number): string {
  return resolve(STATE_DIR, `pr-${prNumber}.json`);
}

/** Atomic file write: write to temp file then rename */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  try {
    await rm(filePath).catch(() => { /* first write — file may not exist */ });
    const { rename } = await import('node:fs/promises');
    await rename(tmpFile, filePath);
  } catch {
    // Fallback: if rename fails (cross-device link), write directly
    await writeFile(filePath, data, 'utf-8');
    await rm(tmpFile).catch(() => { /* cleanup temp file */ });
  }
}

/** Parse and validate a PR state file */
export function parseStateFile(json: string, filePath: string): PRStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`State file '${filePath}' is not valid JSON`);
  }
  return validateStateFile(data, filePath);
}

export function validateStateFile(data: unknown, filePath: string): PRStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`State file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || obj.prNumber < 1 || !Number.isInteger(obj.prNumber)) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }
  if (!isValidState(obj.state)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }
  if (typeof obj.createdAt !== 'string') {
    throw new Error(`State file '${filePath}' has invalid or missing 'createdAt'`);
  }
  if (typeof obj.updatedAt !== 'string') {
    throw new Error(`State file '${filePath}' has invalid or missing 'updatedAt'`);
  }
  if (typeof obj.expiresAt !== 'string') {
    throw new Error(`State file '${filePath}' has invalid or missing 'expiresAt'`);
  }
  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }
  if (obj.disbandRequested != null && typeof obj.disbandRequested !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested'`);
  }

  return data as PRStateFile;
}

function isValidState(state: unknown): state is PRState {
  return typeof state === 'string' && ['reviewing', 'approved', 'closed'].includes(state);
}

// ---- Actions ----

/**
 * Find expired reviewing PRs eligible for disband notification.
 *
 * Scans .temp-chats/ for state files where:
 *   - state === 'reviewing'
 *   - expiresAt < now (the PR has expired)
 *
 * For each expired PR, also reports whether the last disbandRequested
 * was within the 24h cooldown window.
 */
export async function checkExpired(): Promise<ExpiredPR[]> {
  const now = Date.now();
  const expired: ExpiredPR[] = [];

  // Ensure directory exists
  if (!existsSync(STATE_DIR)) {
    return expired;
  }

  let files: string[];
  try {
    files = await readdir(STATE_DIR);
  } catch {
    return expired;
  }

  for (const fileName of files) {
    if (!fileName.startsWith('pr-') || !fileName.endsWith('.json')) continue;

    const filePath = resolve(STATE_DIR, fileName);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue; // File may have been deleted between readdir and readFile
    }

    let stateFile: PRStateFile;
    try {
      stateFile = parseStateFile(content, filePath);
    } catch (err) {
      console.error(`WARN: Skipping corrupted state file: ${filePath} — ${err}`);
      continue;
    }

    // Only consider reviewing PRs
    if (stateFile.state !== 'reviewing') continue;

    // Check if expired
    const expiresAt = new Date(stateFile.expiresAt).getTime();
    if (isNaN(expiresAt)) {
      console.error(`WARN: Invalid expiresAt in ${filePath}: ${stateFile.expiresAt}`);
      continue;
    }
    if (expiresAt > now) continue; // Not expired yet

    // Check cooldown
    let withinCooldown = false;
    if (stateFile.disbandRequested) {
      const lastDisband = new Date(stateFile.disbandRequested).getTime();
      if (!isNaN(lastDisband) && (now - lastDisband) < DISBAND_COOLDOWN_MS) {
        withinCooldown = true;
      }
    }

    expired.push({
      prNumber: stateFile.prNumber,
      chatId: stateFile.chatId,
      state: stateFile.state,
      expiresAt: stateFile.expiresAt,
      disbandRequested: stateFile.disbandRequested,
      withinCooldown,
    });
  }

  return expired;
}

/**
 * Update the disbandRequested timestamp for a PR state file.
 *
 * @returns The updated state file
 * @throws Error if state file not found or state is not 'reviewing'
 */
export async function markDisband(prNumber: number): Promise<PRStateFile> {
  const path = stateFilePath(prNumber);
  if (!existsSync(path)) {
    throw new Error(`State file for PR #${prNumber} not found: ${path}`);
  }

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    throw new Error(`Failed to read state file for PR #${prNumber}: ${path}`);
  }

  const stateFile = parseStateFile(content, path);

  if (stateFile.state !== 'reviewing') {
    throw new Error(
      `Cannot mark disband for PR #${prNumber}: state is '${stateFile.state}', expected 'reviewing'`,
    );
  }

  const now = nowISO();
  const updated: PRStateFile = {
    ...stateFile,
    disbandRequested: now,
    updatedAt: now,
  };

  await atomicWrite(path, JSON.stringify(updated, null, 2) + '\n');
  return updated;
}

// ---- CLI ----

function printUsage(): void {
  console.log(`Usage:
  npx tsx lifecycle.ts --action check-expired
  npx tsx lifecycle.ts --action mark-disband --pr <number>
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse --action
  const actionIdx = args.indexOf('--action');
  if (actionIdx === -1 || actionIdx + 1 >= args.length) {
    console.error('ERROR: --action is required');
    printUsage();
    process.exit(1);
  }
  const action = args[actionIdx + 1];

  switch (action) {
    case 'check-expired': {
      const expired = await checkExpired();
      if (expired.length === 0) {
        console.log('INFO: No expired reviewing PRs found');
      } else {
        const eligible = expired.filter((e) => !e.withinCooldown);
        const cooled = expired.filter((e) => e.withinCooldown);
        console.log(JSON.stringify({ total: expired.length, eligible: eligible.length, inCooldown: cooled.length, items: expired }, null, 2));
      }
      break;
    }

    case 'mark-disband': {
      const prIdx = args.indexOf('--pr');
      if (prIdx === -1 || prIdx + 1 >= args.length) {
        console.error('ERROR: --pr <number> is required for mark-disband');
        printUsage();
        process.exit(1);
      }
      const prNumber = parseInt(args[prIdx + 1], 10);
      if (!Number.isFinite(prNumber) || prNumber < 1) {
        console.error(`ERROR: Invalid PR number: ${args[prIdx + 1]}`);
        process.exit(1);
      }
      try {
        const updated = await markDisband(prNumber);
        console.log(`OK: disbandRequested updated for PR #${prNumber}`);
        console.log(JSON.stringify(updated, null, 2));
      } catch (err) {
        console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`ERROR: Unknown action '${action}'`);
      printUsage();
      process.exit(1);
  }
}

// Only run CLI when executed directly (not when imported by tests)
const isMainModule = process.argv[1]?.includes('lifecycle.ts');
if (isMainModule) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
