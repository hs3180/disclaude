#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/scanner.ts — PR Scanner state management CLI.
 *
 * Provides deterministic logic for the PR Scanner schedule prompt.
 * Manages per-PR state files in `.temp-chats/pr-{number}.json`.
 *
 * CLI usage:
 *   npx tsx scanner.ts --action check-capacity [--max-concurrent N]
 *   npx tsx scanner.ts --action list-candidates [--repo owner/repo]
 *   npx tsx scanner.ts --action create-state --pr N [--chat-id xxx]
 *   npx tsx scanner.ts --action mark --pr N --state reviewing|approved|closed
 *   npx tsx scanner.ts --action status
 *
 * Environment variables:
 *   TEMP_CHATS_DIR   State file directory (default: .temp-chats)
 *   MAX_CONCURRENT   Max concurrent reviewing PRs (default: 3)
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error or fatal error
 */

import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PR_STATES = ['reviewing', 'approved', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

export interface PrStateFile {
  prNumber: number;
  chatId: string;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CapacityResult {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

export interface CandidatePr {
  number: number;
  title: string;
  author: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_EXPIRY_HOURS = 48;
const STATE_FILE_PREFIX = 'pr-';
const STATE_FILE_SUFFIX = '.json';

function getStateDir(): string {
  return process.env.TEMP_CHATS_DIR
    ? resolve(process.env.TEMP_CHATS_DIR)
    : resolve(process.cwd(), '.temp-chats');
}

function getMaxConcurrent(): number {
  const env = process.env.MAX_CONCURRENT;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_CONCURRENT;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidState(s: string): s is PrState {
  return (PR_STATES as readonly string[]).includes(s);
}

function nowISO(): string {
  return new Date().toISOString();
}

function expiryISO(hours = DEFAULT_EXPIRY_HOURS): string {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

function stateFilePath(stateDir: string, prNumber: number): string {
  return resolve(stateDir, `${STATE_FILE_PREFIX}${prNumber}${STATE_FILE_SUFFIX}`);
}

function parsePrNumber(raw: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid PR number: ${raw}`);
  return n;
}

/**
 * Atomic file write: write to temp file then rename.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

function fail(msg: string): never {
  throw new FatalError(msg);
}

// ---------------------------------------------------------------------------
// State file I/O
// ---------------------------------------------------------------------------

export async function ensureStateDir(stateDir: string): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true });
  } catch (err) {
    fail(`Cannot create state directory: ${stateDir} (${err})`);
  }
}

export async function readStateFile(
  stateDir: string,
  prNumber: number,
): Promise<PrStateFile | null> {
  const filePath = stateFilePath(stateDir, prNumber);
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as PrStateFile;
  } catch {
    return null;
  }
}

export async function writeStateFile(
  stateDir: string,
  prNumber: number,
  data: PrStateFile,
): Promise<void> {
  await ensureStateDir(stateDir);
  const filePath = stateFilePath(stateDir, prNumber);
  await atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n');
}

export async function listAllStateFiles(stateDir: string): Promise<PrStateFile[]> {
  const results: PrStateFile[] = [];
  try {
    await stat(stateDir);
  } catch {
    return results;
  }

  let files: string[];
  try {
    files = await readdir(stateDir);
  } catch {
    return results;
  }

  for (const file of files) {
    if (!file.startsWith(STATE_FILE_PREFIX) || !file.endsWith(STATE_FILE_SUFFIX)) continue;
    const filePath = resolve(stateDir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as PrStateFile;
      if (typeof parsed.prNumber === 'number' && typeof parsed.state === 'string') {
        results.push(parsed);
      }
    } catch {
      // Skip corrupt files
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function checkCapacity(stateDir: string, maxConcurrent: number): Promise<CapacityResult> {
  const allStates = await listAllStateFiles(stateDir);
  const reviewing = allStates.filter((s) => s.state === 'reviewing').length;
  const available = Math.max(0, maxConcurrent - reviewing);
  return { reviewing, maxConcurrent, available };
}

export async function listCandidates(
  stateDir: string,
  repo?: string,
): Promise<CandidatePr[]> {
  // Get all currently tracked PR numbers
  const allStates = await listAllStateFiles(stateDir);
  const trackedNumbers = new Set(allStates.map((s) => s.prNumber));

  // Call gh pr list to get open PRs
  const args = ['pr', 'list', '--state', 'open', '--json', 'number,title,author'];
  if (repo) {
    args.push('--repo', repo);
  }
  args.push('--limit', '100');

  let stdout: string;
  try {
    const result = await execFileAsync('gh', args, { timeout: 30000 });
    stdout = result.stdout;
  } catch {
    // gh not available or failed — return empty
    return [];
  }

  let prs: Array<{ number: number; title: string; author: { login: string } }>;
  try {
    prs = JSON.parse(stdout) as typeof prs;
  } catch {
    return [];
  }

  return prs
    .filter((pr) => !trackedNumbers.has(pr.number))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login ?? 'unknown',
    }));
}

export async function createState(
  stateDir: string,
  prNumber: number,
  chatId: string,
): Promise<PrStateFile> {
  // Check if state file already exists
  const existing = await readStateFile(stateDir, prNumber);
  if (existing) {
    fail(`State file already exists for PR #${prNumber}`);
  }

  const now = nowISO();
  const stateFile: PrStateFile = {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: now,
    updatedAt: now,
    expiresAt: expiryISO(),
  };

  await writeStateFile(stateDir, prNumber, stateFile);
  return stateFile;
}

export async function markState(
  stateDir: string,
  prNumber: number,
  newState: PrState,
): Promise<PrStateFile> {
  const existing = await readStateFile(stateDir, prNumber);
  if (!existing) {
    fail(`No state file found for PR #${prNumber}`);
  }

  const updated: PrStateFile = {
    ...existing,
    state: newState,
    updatedAt: nowISO(),
  };

  await writeStateFile(stateDir, prNumber, updated);
  return updated;
}

export async function statusReport(stateDir: string): Promise<string> {
  const allStates = await listAllStateFiles(stateDir);

  if (allStates.length === 0) {
    return 'No PRs are currently being tracked.';
  }

  const grouped: Record<string, PrStateFile[]> = {};
  for (const s of allStates) {
    if (!grouped[s.state]) grouped[s.state] = [];
    grouped[s.state].push(s);
  }

  const lines: string[] = [`Tracking ${allStates.length} PR(s):\n`];

  for (const state of PR_STATES) {
    const items = grouped[state];
    if (!items || items.length === 0) continue;
    lines.push(`  [${state}] (${items.length})`);
    for (const item of items) {
      const chatInfo = item.chatId ? ` chat=${item.chatId}` : '';
      lines.push(`    #${item.prNumber}${chatInfo}  updated=${item.updatedAt}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--action' || arg === '--pr' || arg === '--state' || arg === '--chat-id' || arg === '--repo' || arg === '--max-concurrent') {
      i++;
      if (i >= argv.length) exit(`Missing value for ${arg}`);
      args[arg.slice(2)] = argv[i];
    }
    i++;
  }
  return args;
}

function usage(): never {
  console.error(`
Usage: npx tsx scanner.ts --action <action> [options]

Actions:
  check-capacity          Check reviewing capacity
  list-candidates         List PRs without state files
  create-state            Create a new PR state file
  mark                    Update PR state
  status                  Show all tracked PRs

Options:
  --pr N                  PR number (required for create-state, mark)
  --state S               Target state: reviewing|approved|closed (required for mark)
  --chat-id xxx           Chat ID (for create-state)
  --repo owner/repo       GitHub repo (for list-candidates)
  --max-concurrent N      Max concurrent reviewing PRs (for check-capacity, default: 3)
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const action = args['action'];

  if (!action) usage();

  const stateDir = getStateDir();

  switch (action) {
    case 'check-capacity': {
      const maxConcurrent = args['max-concurrent']
        ? parseInt(args['max-concurrent'], 10) || DEFAULT_MAX_CONCURRENT
        : getMaxConcurrent();
      const result = await checkCapacity(stateDir, maxConcurrent);
      outputJson(result);
      break;
    }

    case 'list-candidates': {
      const repo = args['repo'];
      const candidates = await listCandidates(stateDir, repo);
      outputJson(candidates);
      break;
    }

    case 'create-state': {
      if (!args['pr']) fail('--pr is required for create-state');
      const prNumber = parsePrNumber(args['pr']);
      const chatId = args['chat-id'] ?? '';
      const result = await createState(stateDir, prNumber, chatId);
      outputJson(result);
      break;
    }

    case 'mark': {
      if (!args['pr']) fail('--pr is required for mark');
      if (!args['state']) fail('--state is required for mark');
      const prNumber = parsePrNumber(args['pr']);
      if (!isValidState(args['state'])) {
        fail(`Invalid state: ${args['state']}. Must be one of: ${PR_STATES.join(', ')}`);
      }
      const result = await markState(stateDir, prNumber, args['state']);
      outputJson(result);
      break;
    }

    case 'status': {
      const report = await statusReport(stateDir);
      console.log(report);
      break;
    }

    default:
      fail(`Unknown action: ${action}`);
  }
}

// Only run CLI when executed directly (not when imported as a module)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
