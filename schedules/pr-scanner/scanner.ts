#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner state management CLI.
 *
 * Provides deterministic logic for managing PR scanning state files.
 * Designed to be called from the pr-scanner schedule prompt or directly via CLI.
 *
 * State files are stored in `.temp-chats/pr-{number}.json` with a strict schema
 * aligned to the PR Scanner v2 design specification §3.1.
 *
 * Usage:
 *   npx tsx scanner.ts --action check-capacity
 *   npx tsx scanner.ts --action list-candidates
 *   npx tsx scanner.ts --action create-state --pr 123 --chat-id oc_xxx
 *   npx tsx scanner.ts --action mark --pr 123 --state approved
 *   npx tsx scanner.ts --action status
 *
 * Environment variables (optional):
 *   PR_STATE_DIR       Directory for state files (default: .temp-chats)
 *   PR_MAX_CONCURRENT  Max concurrent reviewing PRs (default: 3)
 *   PR_EXPIRY_HOURS    Hours until state expires (default: 48)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (invalid arguments, I/O failure)
 */

import { readFile, writeFile, readdir, mkdir, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// ---- Types ----

/** PR tracking state — strictly aligned to design spec §3.1 */
export type PRState = 'reviewing' | 'approved' | 'closed';

/** State file schema — design spec §3.1 */
export interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

/** Check-capacity output */
export interface CapacityInfo {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

// ---- Constants ----

export const DEFAULT_STATE_DIR = '.temp-chats';
export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_EXPIRY_HOURS = 48;
export const VALID_STATES: readonly PRState[] = ['reviewing', 'approved', 'closed'] as const;
export const STATE_FILE_REGEX = /^pr-(\d+)\.json$/;

// ---- Helpers ----

/** Get current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Calculate expiry timestamp from creation time */
export function calculateExpiry(createdAt: string, hours: number): string {
  const date = new Date(createdAt);
  date.setTime(date.getTime() + hours * 60 * 60 * 1000);
  return date.toISOString();
}

/** Validate that a value is a valid PR state */
export function isValidState(value: string): value is PRState {
  return VALID_STATES.includes(value as PRState);
}

/** Get the state directory path, respecting env var */
export function getStateDir(): string {
  return process.env.PR_STATE_DIR || DEFAULT_STATE_DIR;
}

/** Get max concurrent PRs, respecting env var */
export function getMaxConcurrent(): number {
  const env = process.env.PR_MAX_CONCURRENT;
  if (!env) return DEFAULT_MAX_CONCURRENT;
  const parsed = parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CONCURRENT;
  return parsed;
}

/** Get expiry hours, respecting env var */
export function getExpiryHours(): number {
  const env = process.env.PR_EXPIRY_HOURS;
  if (!env) return DEFAULT_EXPIRY_HOURS;
  const parsed = parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EXPIRY_HOURS;
  return parsed;
}

/** Get state file path for a PR number */
export function getStateFilePath(prNumber: number): string {
  return join(getStateDir(), `pr-${prNumber}.json`);
}

/** Parse PR number from state filename */
export function parsePRNumber(filename: string): number | null {
  const match = filename.match(STATE_FILE_REGEX);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Atomic file write: write to temp file then rename.
 * Prevents partial/corrupt writes on crash.
 */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Ensure the state directory exists */
export async function ensureStateDir(): Promise<void> {
  const dir = getStateDir();
  try {
    await stat(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

/** Read and parse a state file */
export async function readStateFile(prNumber: number): Promise<PRStateFile | null> {
  const filePath = getStateFilePath(prNumber);
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as PRStateFile;
  } catch {
    return null;
  }
}

/** Validate a state file object */
export function validateStateFile(data: unknown): PRStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('State file is not a valid JSON object');
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`Invalid prNumber: ${obj.prNumber}`);
  }
  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`Invalid chatId: ${obj.chatId}`);
  }
  if (!isValidState(obj.state as string)) {
    throw new Error(`Invalid state: ${obj.state}`);
  }
  if (typeof obj.createdAt !== 'string') {
    throw new Error(`Invalid createdAt: ${obj.createdAt}`);
  }
  if (typeof obj.updatedAt !== 'string') {
    throw new Error(`Invalid updatedAt: ${obj.updatedAt}`);
  }
  if (typeof obj.expiresAt !== 'string') {
    throw new Error(`Invalid expiresAt: ${obj.expiresAt}`);
  }
  if (obj.disbandRequested !== null && typeof obj.disbandRequested !== 'string') {
    throw new Error(`Invalid disbandRequested: ${obj.disbandRequested}`);
  }

  return obj as unknown as PRStateFile;
}

/** Read all state files from the state directory */
export async function readAllStateFiles(): Promise<PRStateFile[]> {
  const dir = getStateDir();
  const results: PRStateFile[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const prNumber = parsePRNumber(entry);
    if (prNumber === null) continue;

    const filePath = join(dir, entry);
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const validated = validateStateFile(parsed);
      results.push(validated);
    } catch {
      // Skip corrupted files — report them in status but don't crash
      results.push({
        prNumber,
        chatId: null,
        state: 'reviewing', // default for display
        createdAt: 'unknown',
        updatedAt: 'unknown',
        expiresAt: 'unknown',
        disbandRequested: null,
        _corrupted: true,
      } as PRStateFile & { _corrupted: boolean });
    }
  }

  return results;
}

// ---- Actions ----

/** Action: check-capacity */
export async function actionCheckCapacity(): Promise<CapacityInfo> {
  const maxConcurrent = getMaxConcurrent();
  const states = await readAllStateFiles();
  const reviewing = states.filter((s) => s.state === 'reviewing').length;
  const available = Math.max(0, maxConcurrent - reviewing);
  return { reviewing, maxConcurrent, available };
}

/** Action: list-candidates */
export async function actionListCandidates(openPRNumbers: number[]): Promise<number[]> {
  const states = await readAllStateFiles();
  const tracked = new Set(states.map((s) => s.prNumber));
  return openPRNumbers.filter((n) => !tracked.has(n));
}

/** Action: create-state */
export async function actionCreateState(prNumber: number, chatId: string | null = null): Promise<PRStateFile> {
  await ensureStateDir();

  // Check if state file already exists
  const existing = await readStateFile(prNumber);
  if (existing) {
    throw new Error(`State file already exists for PR #${prNumber}`);
  }

  const now = nowISO();
  const stateFile: PRStateFile = {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: calculateExpiry(now, getExpiryHours()),
    disbandRequested: null,
  };

  const filePath = getStateFilePath(prNumber);
  await atomicWrite(filePath, JSON.stringify(stateFile, null, 2));
  return stateFile;
}

/** Action: mark */
export async function actionMark(prNumber: number, newState: PRState): Promise<PRStateFile> {
  const existing = await readStateFile(prNumber);
  if (!existing) {
    throw new Error(`No state file found for PR #${prNumber}`);
  }

  if (!isValidState(newState)) {
    throw new Error(`Invalid state '${newState}'. Must be one of: ${VALID_STATES.join(', ')}`);
  }

  existing.state = newState;
  existing.updatedAt = nowISO();

  const validated = validateStateFile(existing);
  const filePath = getStateFilePath(prNumber);
  await atomicWrite(filePath, JSON.stringify(validated, null, 2));
  return validated;
}

/** Action: status */
export async function actionStatus(): Promise<Record<PRState | 'expired' | 'corrupted', number[]>> {
  const states = await readAllStateFiles();
  const now = new Date();
  const result: Record<string, number[]> = {
    reviewing: [],
    approved: [],
    closed: [],
    expired: [],
    corrupted: [],
  };

  for (const s of states) {
    const corrupted = (s as PRStateFile & { _corrupted?: boolean })._corrupted;
    if (corrupted) {
      result.corrupted.push(s.prNumber);
      continue;
    }

    if (s.state === 'reviewing' && new Date(s.expiresAt) <= now) {
      result.expired.push(s.prNumber);
      continue;
    }

    if (Array.isArray(result[s.state])) {
      result[s.state].push(s.prNumber);
    }
  }

  return result as Record<PRState | 'expired' | 'corrupted', number[]>;
}

// ---- CLI ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        parsed[key] = value;
        i++;
      } else {
        parsed[key] = 'true';
      }
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  const action = parsed.action;
  if (!action) {
    exit('Missing --action. Valid actions: check-capacity, list-candidates, create-state, mark, status');
  }

  switch (action) {
    case 'check-capacity': {
      const info = await actionCheckCapacity();
      console.log(JSON.stringify(info, null, 2));
      break;
    }

    case 'list-candidates': {
      // Open PR numbers should be passed via --prs (comma-separated)
      // If not provided, returns empty (schedule prompt should supply them)
      const prsStr = parsed.prs;
      const openPRs: number[] = prsStr
        ? prsStr.split(',').map((n) => {
            const num = parseInt(n, 10);
            if (!Number.isFinite(num) || num <= 0) exit(`Invalid PR number: ${n}`);
            return num;
          })
        : [];
      const candidates = await actionListCandidates(openPRs);
      console.log(JSON.stringify(candidates));
      break;
    }

    case 'create-state': {
      const prStr = parsed.pr;
      if (!prStr) exit('Missing --pr (PR number)');
      const prNumber = parseInt(prStr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) exit(`Invalid PR number: ${prStr}`);
      const chatId = parsed['chat-id'] || null;
      const stateFile = await actionCreateState(prNumber, chatId);
      console.log(JSON.stringify(stateFile, null, 2));
      break;
    }

    case 'mark': {
      const prStr = parsed.pr;
      if (!prStr) exit('Missing --pr (PR number)');
      const prNumber = parseInt(prStr, 10);
      if (!Number.isFinite(prNumber) || prNumber <= 0) exit(`Invalid PR number: ${prStr}`);
      const newState = parsed.state;
      if (!newState) exit('Missing --state (new state)');
      if (!isValidState(newState)) exit(`Invalid state '${newState}'. Must be: ${VALID_STATES.join(', ')}`);
      const updated = await actionMark(prNumber, newState as PRState);
      console.log(JSON.stringify(updated, null, 2));
      break;
    }

    case 'status': {
      const status = await actionStatus();
      // Human-readable output
      const sections = Object.entries(status) as [string, number[]][];
      let output = '';
      for (const [state, prs] of sections) {
        if (prs.length > 0) {
          output += `${state}: ${prs.join(', ')}\n`;
        } else {
          output += `${state}: (none)\n`;
        }
      }
      console.log(output.trimEnd());
      break;
    }

    default:
      exit(`Unknown action '${action}'. Valid actions: check-capacity, list-candidates, create-state, mark, status`);
  }
}

// Run CLI only when executed directly (not when imported for testing)
const isDirectRun =
  process.argv[1]?.endsWith('scanner.ts') ||
  process.argv[1]?.endsWith('scanner.js');

if (isDirectRun) {
  main().catch((err) => {
    exit(err instanceof Error ? err.message : String(err));
  });
}
