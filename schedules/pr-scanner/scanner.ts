#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner v2 基础脚本骨架。
 *
 * 提供确定性逻辑供 Schedule Prompt 调用。
 * 使用 `--action` CLI 模式，每个 action 输出 JSON（status 输出人类可读文本）。
 *
 * Usage:
 *   npx tsx scanner.ts --action check-capacity
 *   npx tsx scanner.ts --action list-candidates --repo hs3180/disclaude
 *   npx tsx scanner.ts --action create-state --pr 123
 *   npx tsx scanner.ts --action mark --pr 123 --state approved
 *   npx tsx scanner.ts --action status
 *
 * Related: #2219
 */

import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- Types ----

export type PRState = 'reviewing' | 'approved' | 'closed';

export interface PRStateFile {
  prNumber: number;
  chatId: string | null;
  state: PRState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null; // Phase 1: always null
}

// ---- Constants ----

/** Default directory for state files */
export const DEFAULT_DIR = '.temp-chats';

/** Maximum number of concurrent reviewing PRs */
export const DEFAULT_MAX_REVIEWING = 3;

/** Hours until state file expires */
export const EXPIRY_HOURS = 48;

/** Valid state transitions */
export const VALID_STATES: PRState[] = ['reviewing', 'approved', 'closed'];

// ---- Helpers ----

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Calculate expiresAt timestamp (createdAt + EXPIRY_HOURS) */
export function calculateExpiresAt(createdAt: string): string {
  const date = new Date(createdAt);
  date.setUTCHours(date.getUTCHours() + EXPIRY_HOURS);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Build state file path */
export function stateFilePath(prNumber: number, dir: string = DEFAULT_DIR): string {
  return resolve(dir, `pr-${prNumber}.json`);
}

/** Atomic file write: write to temp file then rename */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

/** Parse and validate a state file JSON string */
export function parseStateFile(json: string, filePath: string): PRStateFile {
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

  // prNumber
  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new Error(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  // chatId
  if (obj.chatId !== null && typeof obj.chatId !== 'string') {
    throw new Error(`State file '${filePath}' has invalid 'chatId'`);
  }

  // state
  if (!VALID_STATES.includes(obj.state as PRState)) {
    throw new Error(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }

  // timestamps
  const tsRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  for (const field of ['createdAt', 'updatedAt', 'expiresAt']) {
    if (typeof obj[field] !== 'string' || !tsRegex.test(obj[field] as string)) {
      throw new Error(`State file '${filePath}' has invalid or missing '${field}'`);
    }
  }

  // disbandRequested
  if (obj.disbandRequested !== null) {
    throw new Error(`State file '${filePath}' has invalid 'disbandRequested' (must be null in Phase 1)`);
  }

  return data as PRStateFile;
}

/** Get the repository from environment or argument */
export function getRepo(): string {
  return process.env.PR_SCANNER_REPO || 'hs3180/disclaude';
}

/** Resolve the state directory */
export function getDir(): string {
  return process.env.PR_SCANNER_DIR || DEFAULT_DIR;
}

// ---- State file operations ----

/** Read all state files from the directory */
export async function readAllStates(dir: string = getDir()): Promise<PRStateFile[]> {
  const absDir = resolve(dir);
  let files: string[];
  try {
    files = await readdir(absDir);
  } catch {
    return [];
  }

  const states: PRStateFile[] = [];
  for (const fileName of files) {
    if (!fileName.match(/^pr-\d+\.json$/)) continue;

    const filePath = resolve(absDir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    try {
      states.push(parseStateFile(content, filePath));
    } catch (err) {
      console.error(`WARN: Skipping corrupted state file: ${filePath} — ${err instanceof Error ? err.message : err}`);
    }
  }

  return states;
}

/** Read a single state file */
async function readStateFile(prNumber: number, dir?: string): Promise<PRStateFile> {
  const filePath = stateFilePath(prNumber, dir ?? getDir());
  const content = await readFile(filePath, 'utf-8');
  return parseStateFile(content, filePath);
}

// ---- Actions ----

/**
 * check-capacity: Read .temp-chats/ and count reviewing states
 * Returns JSON: { reviewing: number, maxConcurrent: number, available: number }
 */
export async function actionCheckCapacity(dir?: string): Promise<{
  reviewing: number;
  maxConcurrent: number;
  available: number;
}> {
  const states = await readAllStates(dir);
  const reviewing = states.filter((s) => s.state === 'reviewing').length;
  const maxConcurrent = DEFAULT_MAX_REVIEWING;
  const available = Math.max(0, maxConcurrent - reviewing);

  const result = { reviewing, maxConcurrent, available };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * list-candidates: gh pr list + filter out PRs with state files
 * Returns JSON: candidate PR list
 */
export async function actionListCandidates(
  repo: string = getRepo(),
  dir?: string,
): Promise<Array<{ number: number; title: string }>> {
  // Get tracked PR numbers
  const states = await readAllStates(dir);
  const trackedNumbers = new Set(states.map((s) => s.prNumber));

  // Get open PRs from GitHub
  let prList: Array<{ number: number; title: string }>;
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'list',
      '--repo', repo,
      '--state', 'open',
      '--json', 'number,title',
    ], { timeout: 30000 });

    prList = JSON.parse(stdout);
  } catch (err) {
    console.error(`ERROR: Failed to list PRs from ${repo}: ${err instanceof Error ? err.message : err}`);
    prList = [];
  }

  // Filter out tracked PRs
  const candidates = prList.filter((pr) => !trackedNumbers.has(pr.number));

  console.log(JSON.stringify(candidates, null, 2));
  return candidates;
}

/**
 * create-state: Write a new state file for a PR
 * Returns JSON: the created state file content
 */
export async function actionCreateState(
  prNumber: number,
  dir?: string,
): Promise<PRStateFile> {
  const actualDir = dir ?? getDir();
  const filePath = stateFilePath(prNumber, actualDir);

  // Check if already exists
  try {
    await readFile(filePath, 'utf-8');
    throw new Error(`State file for PR #${prNumber} already exists at ${filePath}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    // File doesn't exist — proceed
  }

  const now = nowISO();
  const state: PRStateFile = {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: calculateExpiresAt(now),
    disbandRequested: null,
  };

  await atomicWrite(filePath, JSON.stringify(state, null, 2) + '\n');

  console.log(JSON.stringify(state, null, 2));
  return state;
}

/**
 * mark: Update the state field of an existing state file
 * Returns JSON: the updated state file content
 */
export async function actionMark(
  prNumber: number,
  newState: PRState,
  dir?: string,
): Promise<PRStateFile> {
  if (!VALID_STATES.includes(newState)) {
    throw new Error(`Invalid state '${newState}'. Must be one of: ${VALID_STATES.join(', ')}`);
  }

  const actualDir = dir ?? getDir();
  const filePath = stateFilePath(prNumber, actualDir);

  // Read existing state
  let existing: PRStateFile;
  try {
    existing = await readStateFile(prNumber, actualDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`State file for PR #${prNumber} not found at ${filePath}`);
    }
    throw err;
  }

  // Update state
  const updated: PRStateFile = {
    ...existing,
    state: newState,
    updatedAt: nowISO(),
  };

  await atomicWrite(filePath, JSON.stringify(updated, null, 2) + '\n');

  console.log(JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * status: List all tracked PRs, grouped by state (human-readable)
 */
export async function actionStatus(dir?: string): Promise<string> {
  const states = await readAllStates(dir);

  if (states.length === 0) {
    const msg = 'No tracked PRs found.';
    console.log(msg);
    return msg;
  }

  // Group by state
  const groups: Record<PRState, PRStateFile[]> = {
    reviewing: [],
    approved: [],
    closed: [],
  };

  for (const s of states) {
    groups[s.state].push(s);
  }

  let output = '';
  for (const state of VALID_STATES) {
    const items = groups[state];
    if (items.length === 0) continue;
    output += `\n## ${state.toUpperCase()} (${items.length})\n`;
    for (const item of items) {
      const expiresLabel = `expires ${item.expiresAt}`;
      output += `  - PR #${item.prNumber} — updated ${item.updatedAt} — ${expiresLabel}\n`;
    }
  }

  const summary = `Tracked PRs: ${states.length} total — ${groups.reviewing.length} reviewing, ${groups.approved.length} approved, ${groups.closed.length} closed`;
  const result = summary + output;
  console.log(result);
  return result;
}

// ---- CLI ----

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const action = args.action;

  if (!action) {
    console.error('Usage: scanner.ts --action <check-capacity|list-candidates|create-state|mark|status> [options]');
    console.error('');
    console.error('Actions:');
    console.error('  check-capacity         Check reviewing capacity');
    console.error('  list-candidates        List untracked open PRs');
    console.error('  create-state --pr N    Create state file for PR #N');
    console.error('  mark --pr N --state S  Update state for PR #N');
    console.error('  status                 Show all tracked PRs');
    process.exit(1);
  }

  switch (action) {
    case 'check-capacity':
      await actionCheckCapacity();
      break;

    case 'list-candidates':
      await actionListCandidates(args.repo);
      break;

    case 'create-state': {
      if (!args.pr) {
        console.error('ERROR: --pr is required for create-state action');
        process.exit(1);
      }
      const prNumber = parseInt(args.pr, 10);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid PR number: ${args.pr}`);
        process.exit(1);
      }
      await actionCreateState(prNumber);
      break;
    }

    case 'mark': {
      if (!args.pr) {
        console.error('ERROR: --pr is required for mark action');
        process.exit(1);
      }
      if (!args.state) {
        console.error('ERROR: --state is required for mark action');
        process.exit(1);
      }
      const prNumber = parseInt(args.pr, 10);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        console.error(`ERROR: Invalid PR number: ${args.pr}`);
        process.exit(1);
      }
      if (!VALID_STATES.includes(args.state as PRState)) {
        console.error(`ERROR: Invalid state '${args.state}'. Must be one of: ${VALID_STATES.join(', ')}`);
        process.exit(1);
      }
      await actionMark(prNumber, args.state as PRState);
      break;
    }

    case 'status':
      await actionStatus();
      break;

    default:
      console.error(`ERROR: Unknown action '${action}'`);
      console.error('Valid actions: check-capacity, list-candidates, create-state, mark, status');
      process.exit(1);
  }
}

// Only run main when executed directly (not imported)
const isMainModule = process.argv[1]?.includes('scanner.ts');
if (isMainModule) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
