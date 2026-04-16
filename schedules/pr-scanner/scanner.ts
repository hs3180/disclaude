#!/usr/bin/env npx tsx
/**
 * PR Scanner — CLI script for managing PR review state files.
 *
 * Issue #2219: Sub-Issue A — scanner.ts 基础脚本骨架
 * Parent: #2210 — PR Scanner v2
 *
 * Provides deterministic CLI actions for the Schedule Prompt to orchestrate
 * PR review lifecycle. All state is persisted as JSON files in `.temp-chats/`.
 *
 * Usage:
 *   npx tsx scanner.ts --action check-capacity
 *   npx tsx scanner.ts --action list-candidates --repo owner/repo
 *   npx tsx scanner.ts --action create-state --pr 123 --chatId oc_xxx
 *   npx tsx scanner.ts --action mark --pr 123 --state approved
 *   npx tsx scanner.ts --action status
 */

import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ---- Constants ----

/** Default directory for PR state files (relative to CWD) */
const DEFAULT_STATE_DIR = '.temp-chats';

/** Maximum concurrent PR reviews (configurable via env) */
const DEFAULT_MAX_CONCURRENT = 3;

/** State file expiry: 48 hours from creation */
const EXPIRY_HOURS = 48;

/** Valid state transitions */
const VALID_STATES = ['reviewing', 'approved', 'closed'] as const;

// ---- Types ----

/** PR state as stored in `.temp-chats/pr-{number}.json` — strict §3.1 schema */
export interface PRStateFile {
  prNumber: number;
  chatId: string;
  state: 'reviewing' | 'approved' | 'closed';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null;
}

/** Result of check-capacity action */
export interface CapacityReport {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

/** PR info from gh CLI (minimal) */
export interface PRInfo {
  number: number;
  title: string;
  labels: string[];
}

/** Status report grouped by state */
export interface StatusReport {
  reviewing: PRStateFile[];
  approved: PRStateFile[];
  closed: PRStateFile[];
}

// ---- Pure functions (testable without GitHub API) ----

/**
 * Get the file path for a PR's state file.
 */
export function getStateFilePath(stateDir: string, prNumber: number): string {
  return join(stateDir, `pr-${prNumber}.json`);
}

/**
 * Parse a PR state file from JSON string.
 * Returns null if content is invalid.
 */
export function parseStateFile(content: string): PRStateFile | null {
  try {
    const data = JSON.parse(content) as PRStateFile;
    // Validate required fields
    if (
      typeof data.prNumber !== 'number' ||
      typeof data.chatId !== 'string' ||
      !VALID_STATES.includes(data.state) ||
      typeof data.createdAt !== 'string' ||
      typeof data.updatedAt !== 'string' ||
      typeof data.expiresAt !== 'string' ||
      data.disbandRequested !== null
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Create a new PR state file object (in-memory).
 * Does not write to disk — callers should use writeStateFile().
 */
export function createPRStateObject(
  prNumber: number,
  chatId: string,
  now: Date = new Date(),
): PRStateFile {
  const expiresAt = new Date(now.getTime() + EXPIRY_HOURS * 60 * 60 * 1000);
  return {
    prNumber,
    chatId,
    state: 'reviewing',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    disbandRequested: null,
  };
}

/**
 * Ensure the state directory exists.
 */
export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
}

/**
 * Write a PR state file to disk.
 */
export async function writeStateFile(
  stateDir: string,
  state: PRStateFile,
): Promise<void> {
  await ensureStateDir(stateDir);
  const filePath = getStateFilePath(stateDir, state.prNumber);
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Read a PR state file from disk.
 * Returns null if file does not exist or is corrupted.
 */
export async function readStateFile(
  stateDir: string,
  prNumber: number,
): Promise<PRStateFile | null> {
  const filePath = getStateFilePath(stateDir, prNumber);
  try {
    const content = await readFile(filePath, 'utf-8');
    return parseStateFile(content);
  } catch {
    return null;
  }
}

/**
 * Read all PR state files from the state directory.
 * Silently skips corrupted files.
 */
export async function readAllStateFiles(stateDir: string): Promise<PRStateFile[]> {
  try {
    const files = await readdir(stateDir);
    const prFiles = files.filter(
      (f) => f.startsWith('pr-') && f.endsWith('.json'),
    );

    const states: PRStateFile[] = [];
    for (const file of prFiles) {
      try {
        const content = await readFile(join(stateDir, file), 'utf-8');
        const state = parseStateFile(content);
        if (state) {
          states.push(state);
        }
      } catch {
        // Skip unreadable files
      }
    }
    return states;
  } catch {
    return [];
  }
}

/**
 * Check capacity: count reviewing states and compute available slots.
 */
export async function checkCapacity(
  stateDir: string,
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
): Promise<CapacityReport> {
  const states = await readAllStateFiles(stateDir);
  const reviewing = states.filter((s) => s.state === 'reviewing').length;
  return {
    reviewing,
    maxConcurrent,
    available: Math.max(0, maxConcurrent - reviewing),
  };
}

/**
 * Create state for a PR. Fails if state file already exists.
 */
export async function createPRState(
  stateDir: string,
  prNumber: number,
  chatId: string,
): Promise<PRStateFile> {
  // Check for existing state
  const existing = await readStateFile(stateDir, prNumber);
  if (existing) {
    throw new Error(
      `State file already exists for PR #${prNumber} (state: ${existing.state})`,
    );
  }

  const state = createPRStateObject(prNumber, chatId);
  await writeStateFile(stateDir, state);
  return state;
}

/**
 * Mark a PR's state. Validates state transition.
 */
export async function markPRState(
  stateDir: string,
  prNumber: number,
  newState: 'reviewing' | 'approved' | 'closed',
): Promise<PRStateFile> {
  if (!VALID_STATES.includes(newState)) {
    throw new Error(
      `Invalid state "${newState}". Must be one of: ${VALID_STATES.join(', ')}`,
    );
  }

  const existing = await readStateFile(stateDir, prNumber);
  if (!existing) {
    throw new Error(`No state file found for PR #${prNumber}`);
  }

  const updated: PRStateFile = {
    ...existing,
    state: newState,
    updatedAt: new Date().toISOString(),
  };

  await writeStateFile(stateDir, updated);
  return updated;
}

/**
 * Get status of all tracked PRs, grouped by state.
 */
export async function getStatus(stateDir: string): Promise<StatusReport> {
  const states = await readAllStateFiles(stateDir);
  return {
    reviewing: states.filter((s) => s.state === 'reviewing'),
    approved: states.filter((s) => s.state === 'approved'),
    closed: states.filter((s) => s.state === 'closed'),
  };
}

/**
 * Format a StatusReport as human-readable text.
 */
export function formatStatusText(report: StatusReport): string {
  const lines: string[] = [];

  const total =
    report.reviewing.length + report.approved.length + report.closed.length;

  if (total === 0) {
    return 'No tracked PRs found.';
  }

  lines.push(`PR Scanner Status (${total} tracked)\n`);

  if (report.reviewing.length > 0) {
    lines.push('📋 Reviewing:');
    for (const s of report.reviewing) {
      lines.push(
        `  PR #${s.prNumber} — created ${s.createdAt}, expires ${s.expiresAt}`,
      );
    }
    lines.push('');
  }

  if (report.approved.length > 0) {
    lines.push('✅ Approved:');
    for (const s of report.approved) {
      lines.push(`  PR #${s.prNumber} — updated ${s.updatedAt}`);
    }
    lines.push('');
  }

  if (report.closed.length > 0) {
    lines.push('❌ Closed:');
    for (const s of report.closed) {
      lines.push(`  PR #${s.prNumber} — updated ${s.updatedAt}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Filter open PRs to only those without existing state files.
 * This is the core logic for list-candidates.
 */
export function filterCandidates(
  openPRs: PRInfo[],
  existingStates: PRStateFile[],
): PRInfo[] {
  const trackedNumbers = new Set(existingStates.map((s) => s.prNumber));
  return openPRs.filter((pr) => !trackedNumbers.has(pr.number));
}

// ---- GitHub API wrapper (isolated for testability) ----

/**
 * Fetch open PRs using gh CLI.
 * Abstracted so tests can mock without GitHub API access.
 */
export async function fetchOpenPRs(repo: string): Promise<PRInfo[]> {
  const cmd = `gh pr list --repo ${repo} --state open --json number,title,labels`;
  const stdout = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  const prs = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    labels: Array<{ name: string }>;
  }>;

  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    labels: pr.labels.map((l) => l.name),
  }));
}

// ---- CLI ----

type Action =
  | 'check-capacity'
  | 'list-candidates'
  | 'create-state'
  | 'mark'
  | 'status';

const VALID_ACTIONS: Action[] = [
  'check-capacity',
  'list-candidates',
  'create-state',
  'mark',
  'status',
];

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      }
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
PR Scanner — PR review state management CLI

Usage:
  npx tsx scanner.ts --action <action> [options]

Actions:
  check-capacity    Count reviewing PRs and available slots
  list-candidates   List open PRs without existing state files
  create-state      Create a new PR state file
  mark              Update a PR's state
  status            Show all tracked PRs grouped by state

Options:
  --action <action>   Action to perform (required)
  --pr <number>       PR number (for create-state, mark)
  --chatId <id>       Chat ID (for create-state)
  --state <state>     New state: reviewing|approved|closed (for mark)
  --repo <owner/repo> Repository (for list-candidates)
  --state-dir <path>  State directory (default: .temp-chats)
`);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);

  if (!args.action) {
    printUsage();
    process.exit(1);
  }

  const action = args.action as Action;
  if (!VALID_ACTIONS.includes(action)) {
    console.error(`Unknown action: ${action}`);
    console.error(`Valid actions: ${VALID_ACTIONS.join(', ')}`);
    process.exit(1);
  }

  const stateDir = args['state-dir'] ?? DEFAULT_STATE_DIR;

  switch (action) {
    case 'check-capacity': {
      const maxConcurrent = parseInt(
        process.env.PR_SCANNER_MAX_CONCURRENT ?? String(DEFAULT_MAX_CONCURRENT),
        10,
      );
      const result = await checkCapacity(stateDir, maxConcurrent);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'list-candidates': {
      const repo = args.repo;
      if (!repo) {
        console.error('--repo is required for list-candidates');
        process.exit(1);
      }
      const [openPRs, existingStates] = await Promise.all([
        fetchOpenPRs(repo),
        readAllStateFiles(stateDir),
      ]);
      const candidates = filterCandidates(openPRs, existingStates);
      console.log(JSON.stringify(candidates, null, 2));
      break;
    }

    case 'create-state': {
      const prNumber = parseInt(args.pr ?? '', 10);
      const chatId = args.chatId;
      if (!prNumber || !chatId) {
        console.error('--pr and --chatId are required for create-state');
        process.exit(1);
      }
      const result = await createPRState(stateDir, prNumber, chatId);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'mark': {
      const prNumber = parseInt(args.pr ?? '', 10);
      const newState = args.state as 'reviewing' | 'approved' | 'closed';
      if (!prNumber || !newState) {
        console.error('--pr and --state are required for mark');
        process.exit(1);
      }
      const result = await markPRState(stateDir, prNumber, newState);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'status': {
      const result = await getStatus(stateDir);
      console.log(formatStatusText(result));
      break;
    }
  }
}

// Run main if executed directly (not imported)
// Use import.meta.url check to avoid running during tests
const isDirectRun =
  process.argv[1]?.endsWith('scanner.ts') ||
  process.argv[1]?.endsWith('scanner.js');

if (isDirectRun) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
