#!/usr/bin/env npx tsx
/**
 * PR Scanner - State Management CLI
 *
 * Provides deterministic state management logic for the PR Scanner v2.
 * Designed to be invoked by Schedule Prompts via `npx tsx`.
 *
 * Usage:
 *   npx tsx scanner.ts --action <action> [options]
 *
 * Actions:
 *   check-capacity    Count reviewing PRs and report availability
 *   list-candidates   Filter open PRs that don't have state files yet
 *   create-state      Create a new state file for a PR
 *   mark              Update the state of a tracked PR
 *   status            List all tracked PRs grouped by state
 *
 * @see Issue #2219 - scanner.ts 基础脚本骨架
 * @see Issue #2210 - PR Scanner v2 design
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PRState {
  prNumber: number;
  chatId: string | null;
  state: 'reviewing' | 'approved' | 'closed';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: string | null;
}

export type PRStateEnum = PRState['state'];

export interface CheckCapacityResult {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_MAX_CONCURRENT = 1;
export const EXPIRY_HOURS = 48;
export const DEFAULT_STATE_DIR = '.temp-chats';
export const VALID_STATES: readonly PRStateEnum[] = [
  'reviewing',
  'approved',
  'closed',
] as const;

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Resolve the state directory path.
 * Priority: PR_SCANNER_STATE_DIR env > DEFAULT_STATE_DIR relative to baseDir.
 */
function getStateDir(baseDir?: string): string {
  const dir = process.env['PR_SCANNER_STATE_DIR'] || DEFAULT_STATE_DIR;
  return baseDir ? resolve(baseDir, dir) : resolve(dir);
}

/** Ensure a directory exists (recursive). */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Build the state file path for a given PR number. */
function stateFilePath(stateDir: string, prNumber: number): string {
  return join(stateDir, `pr-${prNumber}.json`);
}

/** Read and parse a state file. Returns null on any I/O or parse error. */
function readStateFile(filePath: string): PRState | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return validateStateSchema(data) ? data : null;
  } catch {
    return null;
  }
}

/** Write a state object to disk as formatted JSON. */
function writeStateFile(filePath: string, state: PRState): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)  }\n`, 'utf-8');
}

/** Current timestamp in ISO-8601. */
function nowISO(): string {
  return new Date().toISOString();
}

/** Add hours to an ISO timestamp and return a new ISO string. */
function addHours(iso: string, hours: number): string {
  const d = new Date(iso);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

/** Validate that a parsed object conforms to the PRState schema. */
function validateStateSchema(data: unknown): data is PRState {
  if (typeof data !== 'object' || data === null) {return false;}
  const d = data as Record<string, unknown>;
  if (typeof d['prNumber'] !== 'number') {return false;}
  if (!VALID_STATES.includes(d['state'] as PRStateEnum)) {return false;}
  if (typeof d['createdAt'] !== 'string') {return false;}
  if (typeof d['updatedAt'] !== 'string') {return false;}
  if (typeof d['expiresAt'] !== 'string') {return false;}
  // chatId and disbandRequested are nullable
  return true;
}

/** Read maxConcurrent from env or return the default. */
function getMaxConcurrent(): number {
  const raw = process.env['PR_SCANNER_MAX_CONCURRENT'];
  if (!raw) {return DEFAULT_MAX_CONCURRENT;}
  const n = parseInt(raw, 10);
  return isNaN(n) ? DEFAULT_MAX_CONCURRENT : n;
}

/**
 * List all state files in the state directory.
 * Returns an array of { fileName, prNumber, state }.
 * Silently skips corrupt or unreadable files.
 */
function listStateFiles(
  stateDir: string,
): Array<{ fileName: string; prNumber: number; state: PRState | null }> {
  if (!existsSync(stateDir)) {return [];}

  const results: Array<{ fileName: string; prNumber: number; state: PRState | null }> = [];

  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const match = entry.match(/^pr-(\d+)\.json$/);
    if (!match) {continue;}

    const prNumber = parseInt(match[1], 10);
    const parsed = readStateFile(join(stateDir, entry));
    results.push({ fileName: entry, prNumber, state: parsed });
  }

  return results;
}

// ─── Exported Actions ────────────────────────────────────────────────────────

/**
 * Count PRs in "reviewing" state and report capacity.
 */
export function checkCapacity(baseDir?: string): CheckCapacityResult {
  const stateDir = getStateDir(baseDir);
  const maxConcurrent = getMaxConcurrent();
  const files = listStateFiles(stateDir);

  let reviewing = 0;
  for (const { state } of files) {
    if (state?.state === 'reviewing') {
      reviewing++;
    }
  }

  return {
    reviewing,
    maxConcurrent,
    available: Math.max(0, maxConcurrent - reviewing),
  };
}

/**
 * Given a list of open PR numbers, return those without existing state files.
 */
export function listCandidates(openPRs: number[], baseDir?: string): number[] {
  const stateDir = getStateDir(baseDir);
  const files = listStateFiles(stateDir);

  const tracked = new Set<number>();
  for (const { prNumber } of files) {
    tracked.add(prNumber);
  }

  return openPRs.filter((pr) => !tracked.has(pr));
}

/**
 * Create a new state file for a PR.
 * Throws if the file already exists.
 */
export function createState(
  prNumber: number,
  chatId: string | null = null,
  baseDir?: string,
): PRState {
  const stateDir = getStateDir(baseDir);
  const filePath = stateFilePath(stateDir, prNumber);

  if (existsSync(filePath)) {
    throw new Error(`State file for PR #${prNumber} already exists: ${filePath}`);
  }

  const createdAt = nowISO();
  const state: PRState = {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt,
    updatedAt: createdAt,
    expiresAt: addHours(createdAt, EXPIRY_HOURS),
    disbandRequested: null,
  };

  ensureDir(stateDir);
  writeStateFile(filePath, state);
  return state;
}

/**
 * Update the state of an existing tracked PR.
 * Throws if the state file doesn't exist or is corrupt.
 */
export function markState(
  prNumber: number,
  newState: PRStateEnum,
  baseDir?: string,
): PRState {
  if (!VALID_STATES.includes(newState)) {
    throw new Error(`Invalid state: "${newState}". Valid: ${VALID_STATES.join(', ')}`);
  }

  const stateDir = getStateDir(baseDir);
  const filePath = stateFilePath(stateDir, prNumber);

  if (!existsSync(filePath)) {
    throw new Error(`State file for PR #${prNumber} not found: ${filePath}`);
  }

  const current = readStateFile(filePath);
  if (!current) {
    throw new Error(`Corrupt state file for PR #${prNumber}: ${filePath}`);
  }

  current.state = newState;
  current.updatedAt = nowISO();

  writeStateFile(filePath, current);
  return current;
}

/**
 * List all tracked PRs grouped by their state.
 */
export function getStatus(baseDir?: string): Record<PRStateEnum, PRState[]> {
  const stateDir = getStateDir(baseDir);
  const result: Record<PRStateEnum, PRState[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  const files = listStateFiles(stateDir);
  for (const { state } of files) {
    if (state) {
      result[state.state].push(state);
    }
  }

  // Sort each group by updatedAt descending (most recent first)
  for (const key of VALID_STATES) {
    result[key].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  return result;
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

interface ParsedArgs {
  [key: string]: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      const value = next && !next.startsWith('--') ? next : '';
      parsed[key] = value;
      if (value) {i++;}
    }
  }
  return parsed;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { action } = args;

  if (!action) {
    console.error('Usage: npx tsx scanner.ts --action <action> [options]');
    console.error('');
    console.error('Actions:');
    console.error('  check-capacity              Count reviewing PRs');
    console.error('  list-candidates --prs N,N   Filter untracked PRs');
    console.error('  create-state --pr N         Create state file');
    console.error('  mark --pr N --state S       Update PR state');
    console.error('  status                      List all tracked PRs');
    process.exit(1);
  }

  try {
    switch (action) {
      case 'check-capacity': {
        const result = checkCapacity();
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'list-candidates': {
        const prsArg = args['prs'];
        const openPRs = prsArg
          ? prsArg
              .split(',')
              .map((s) => parseInt(s.trim(), 10))
              .filter((n) => !isNaN(n))
          : [];
        const candidates = listCandidates(openPRs);
        console.log(JSON.stringify(candidates, null, 2));
        break;
      }
      case 'create-state': {
        const pr = parseInt(args['pr'] || '', 10);
        if (isNaN(pr)) {
          throw new Error('--pr <number> is required');
        }
        const chatId = args['chat-id'] || null;
        const state = createState(pr, chatId);
        console.log(JSON.stringify(state, null, 2));
        break;
      }
      case 'mark': {
        const pr = parseInt(args['pr'] || '', 10);
        const newState = args['state'] as PRStateEnum;
        if (isNaN(pr)) {
          throw new Error('--pr <number> is required');
        }
        if (!newState || !VALID_STATES.includes(newState)) {
          throw new Error(
            `--state <state> is required. Valid: ${VALID_STATES.join(', ')}`,
          );
        }
        const updated = markState(pr, newState);
        console.log(JSON.stringify(updated, null, 2));
        break;
      }
      case 'status': {
        const result = getStatus();
        let hasAny = false;
        for (const stateName of VALID_STATES) {
          const items = result[stateName];
          if (items.length > 0) {
            hasAny = true;
            console.log(`[${stateName}]`);
            for (const item of items) {
              console.log(
                `  PR #${item.prNumber} (updated: ${item.updatedAt})`,
              );
            }
          }
        }
        if (!hasAny) {
          console.log('No tracked PRs.');
        }
        break;
      }
      default:
        console.error(`Unknown action: ${action}`);
        console.error(
          'Valid actions: check-capacity, list-candidates, create-state, mark, status',
        );
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Run CLI when executed directly (not imported as a module)
const scriptPath = process.argv[1] ?? '';
if (
  scriptPath.endsWith('scanner.ts') ||
  scriptPath.endsWith('scanner.js') ||
  scriptPath.includes('pr-scanner/scanner')
) {
  main();
}
