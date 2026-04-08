#!/usr/bin/env tsx
/**
 * schedule/pr-scanner.ts — Scan open PRs and manage review state.
 *
 * Part of PR Scanner v2 (Issue #2210, Phase 1).
 * Scans open PRs, tracks review state via files in workspace/pr-scanner/,
 * and manages GitHub labels for status tracking.
 *
 * Usage:
 *   npx tsx scripts/schedule/pr-scanner.ts scan [--repo owner/repo] [--max-reviewing N]
 *   npx tsx scripts/schedule/pr-scanner.ts status
 *   npx tsx scripts/schedule/pr-scanner.ts mark <pr-number> <status>
 *
 * Environment variables (optional):
 *   PR_SCANNER_REPO           GitHub repo in owner/repo format (default: hs3180/disclaude)
 *   PR_SCANNER_MAX_REVIEWING  Max PRs in reviewing state (default: 3)
 *   PR_SCANNER_STATE_DIR      State directory path (default: workspace/pr-scanner)
 *   PR_SCANNER_LABEL          GitHub label for reviewing PRs (default: pr-scanner:reviewing)
 *   PR_SCANNER_SKIP_GH_CHECK  Set to '1' to skip gh CLI check (for testing)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error
 */

import { readdir, readFile, writeFile, stat, realpath, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLock } from '../chat/lock.js';
import { nowISO, DEFAULT_MAX_PER_RUN } from '../chat/schema.js';

const execFileAsync = promisify(execFile);

// ---- Types ----

export type PRScanStatus = 'reviewing' | 'approved' | 'rejected' | 'closed';

export interface PRScanFile {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  status: PRScanStatus;
  createdAt: string;
  updatedAt: string;
  notifiedAt: string | null;
  chatId: string | null;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PRInfo {
  number: number;
  title: string;
  author: { login: string } | string;
  headRefName: string;
  baseRefName: string;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: Array<{ name: string }>;
  updatedAt: string;
}

export interface ScanResult {
  action: 'created' | 'skipped' | 'limit_reached';
  prNumber: number;
  title: string;
  reason?: string;
}

// ---- Constants ----

const DEFAULT_REPO = 'hs3180/disclaude';
const DEFAULT_MAX_REVIEWING = 3;
const DEFAULT_STATE_DIR = 'workspace/pr-scanner';
const DEFAULT_LABEL = 'pr-scanner:reviewing';
const GH_TIMEOUT_MS = 30_000;
const PR_FILENAME_REGEX = /^pr-(\d+)\.json$/;
const VALID_STATUSES: PRScanStatus[] = ['reviewing', 'approved', 'rejected', 'closed'];

// ---- Helpers ----

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function getConfig(): {
  repo: string;
  maxReviewing: number;
  stateDir: string;
  label: string;
  skipGhCheck: boolean;
} {
  const repo = process.env.PR_SCANNER_REPO || DEFAULT_REPO;
  const maxReviewingEnv = process.env.PR_SCANNER_MAX_REVIEWING;
  const maxReviewing = maxReviewingEnv ? parseInt(maxReviewingEnv, 10) : DEFAULT_MAX_REVIEWING;
  const stateDir = process.env.PR_SCANNER_STATE_DIR || DEFAULT_STATE_DIR;
  const label = process.env.PR_SCANNER_LABEL || DEFAULT_LABEL;
  const skipGhCheck = process.env.PR_SCANNER_SKIP_GH_CHECK === '1';

  if (isNaN(maxReviewing) || maxReviewing <= 0) {
    exit(`Invalid PR_SCANNER_MAX_REVIEWING='${maxReviewingEnv}'`);
  }

  return { repo, maxReviewing, stateDir, label, skipGhCheck };
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpFile, data, 'utf-8');
  await rename(tmpFile, filePath);
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await stat(dirPath);
  } catch {
    await mkdir(dirPath, { recursive: true });
  }
}

// ---- gh CLI wrappers ----

async function ghListPRs(repo: string): Promise<PRInfo[]> {
  const result = await execFileAsync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--json',
      'number,title,author,headRefName,baseRefName,mergeable,additions,deletions,changedFiles,labels,updatedAt',
      '--limit',
      '100',
    ],
    { timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

async function ghAddLabel(repo: string, prNumber: number, label: string): Promise<void> {
  await execFileAsync(
    'gh',
    ['pr', 'edit', String(prNumber), '--repo', repo, '--add-label', label],
    { timeout: GH_TIMEOUT_MS },
  );
}

async function ghRemoveLabel(repo: string, prNumber: number, label: string): Promise<void> {
  try {
    await execFileAsync(
      'gh',
      ['pr', 'edit', String(prNumber), '--repo', repo, '--remove-label', label],
      { timeout: GH_TIMEOUT_MS },
    );
  } catch {
    // Label may not exist — ignore
  }
}

// ---- State file operations ----

function stateFilePath(stateDir: string, prNumber: number): string {
  return resolve(stateDir, `pr-${prNumber}.json`);
}

async function readStateFile(filePath: string): Promise<PRScanFile | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as PRScanFile;
  } catch {
    return null;
  }
}

async function writeStateFile(filePath: string, data: PRScanFile): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n');
}

function parseAuthor(author: { login: string } | string): string {
  return typeof author === 'string' ? author : author.login;
}

async function loadExistingStates(stateDir: string): Promise<Map<number, PRScanFile>> {
  const states = new Map<number, PRScanFile>();
  const canonicalDir = await realpath(stateDir);

  let files: string[];
  try {
    files = await readdir(canonicalDir);
  } catch {
    return states;
  }

  for (const fileName of files) {
    const match = fileName.match(PR_FILENAME_REGEX);
    if (!match) continue;

    const filePath = resolve(canonicalDir, fileName);
    const state = await readStateFile(filePath);
    if (state && VALID_STATUSES.includes(state.status)) {
      states.set(state.number, state);
    }
  }

  return states;
}

// ---- Commands ----

async function cmdScan(): Promise<void> {
  const config = getConfig();
  const { repo, maxReviewing, stateDir, label, skipGhCheck } = config;

  // Check gh CLI availability
  if (!skipGhCheck) {
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5000 });
    } catch {
      exit('Missing required dependency: gh CLI not found in PATH');
    }
  }

  await ensureDir(stateDir);

  // Load existing state
  const existingStates = await loadExistingStates(stateDir);

  // Count currently reviewing PRs
  let reviewingCount = 0;
  for (const state of existingStates.values()) {
    if (state.status === 'reviewing') {
      reviewingCount++;
    }
  }

  if (reviewingCount >= maxReviewing) {
    console.log(
      `INFO: Already at max reviewing capacity (${reviewingCount}/${maxReviewing}), skipping scan`,
    );
    process.exit(0);
  }

  // Get open PRs
  let prs: PRInfo[];
  try {
    prs = await ghListPRs(repo);
  } catch (err: unknown) {
    exit(`Failed to list PRs: ${err instanceof Error ? err.message : err}`);
  }

  if (prs.length === 0) {
    console.log('INFO: No open PRs found');
    process.exit(0);
  }

  // Filter: skip PRs already tracked in state files
  const newPRs = prs.filter((pr) => !existingStates.has(pr.number));

  // Filter: skip PRs that already have the reviewing label (may have been added externally)
  const untrackedPRs = newPRs.filter(
    (pr) => !pr.labels.some((l) => l.name === label),
  );

  // Sort by updatedAt (oldest first) to prioritize stale PRs
  untrackedPRs.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

  const slotsAvailable = maxReviewing - reviewingCount;
  const toProcess = untrackedPRs.slice(0, slotsAvailable);

  if (toProcess.length === 0) {
    console.log(
      `INFO: No new PRs to process (${reviewingCount}/${maxReviewing} reviewing, ${prs.length - newPRs.length} already tracked)`,
    );
    process.exit(0);
  }

  const results: ScanResult[] = [];

  for (const pr of toProcess) {
    const filePath = stateFilePath(stateDir, pr.number);
    const now = nowISO();

    const stateFile: PRScanFile = {
      number: pr.number,
      title: pr.title,
      author: parseAuthor(pr.author),
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      status: 'reviewing',
      createdAt: now,
      updatedAt: now,
      notifiedAt: null,
      chatId: null,
      mergeable: pr.mergeable,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
    };

    // Acquire lock for this PR's state file
    const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);
    try {
      // Re-check under lock
      const existing = await readStateFile(filePath);
      if (existing) {
        results.push({
          action: 'skipped',
          prNumber: pr.number,
          title: pr.title,
          reason: 'state file already exists',
        });
        continue;
      }

      // Write state file
      await writeStateFile(filePath, stateFile);

      // Add GitHub label
      try {
        await ghAddLabel(repo, pr.number, label);
      } catch (err: unknown) {
        console.error(
          `WARN: Failed to add label '${label}' to PR #${pr.number}: ${err instanceof Error ? err.message : err}`,
        );
        // Continue — state file is the source of truth
      }

      results.push({
        action: 'created',
        prNumber: pr.number,
        title: pr.title,
      });
      console.log(`OK: PR #${pr.number} "${pr.title}" added to review queue`);
    } catch (err) {
      console.error(`WARN: Error processing PR #${pr.number}: ${err}`);
      results.push({
        action: 'skipped',
        prNumber: pr.number,
        title: pr.title,
        reason: err instanceof Error ? err.message : 'unknown error',
      });
    } finally {
      await lock.release();
    }
  }

  // Output summary as JSON (for AI agent consumption)
  const summary = {
    timestamp: nowISO(),
    repo,
    totalPRs: prs.length,
    alreadyTracked: prs.length - newPRs.length,
    reviewingCount: reviewingCount + results.filter((r) => r.action === 'created').length,
    maxReviewing,
    results,
    notified: results.filter((r) => r.action === 'created').map((r) => r.prNumber),
  };

  console.log('\n---SCAN_SUMMARY---');
  console.log(JSON.stringify(summary, null, 2));
}

async function cmdStatus(): Promise<void> {
  const config = getConfig();
  const { stateDir } = config;

  await ensureDir(stateDir);
  const states = await loadExistingStates(stateDir);

  if (states.size === 0) {
    console.log('INFO: No PRs currently tracked');
    process.exit(0);
  }

  const byStatus: Record<string, PRScanFile[]> = {
    reviewing: [],
    approved: [],
    rejected: [],
    closed: [],
  };

  for (const state of states.values()) {
    byStatus[state.status]?.push(state);
  }

  console.log(`PR Scanner Status (${states.size} tracked)\n`);
  for (const [status, items] of Object.entries(byStatus)) {
    if (items.length === 0) continue;
    console.log(`${status.toUpperCase()} (${items.length}):`);
    for (const item of items) {
      console.log(`  #${item.number} "${item.title}" — ${item.author} (updated: ${item.updatedAt})`);
    }
    console.log();
  }
}

async function cmdMark(prNumber: string, newStatus: string): Promise<void> {
  const config = getConfig();
  const { stateDir, repo, label, skipGhCheck } = config;

  const num = parseInt(prNumber, 10);
  if (isNaN(num)) {
    exit(`Invalid PR number: '${prNumber}'`);
  }

  if (!VALID_STATUSES.includes(newStatus as PRScanStatus)) {
    exit(`Invalid status: '${newStatus}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  await ensureDir(stateDir);
  const filePath = stateFilePath(stateDir, num);
  const lock = await acquireLock(`${filePath}.lock`, 'exclusive', 0);

  try {
    const existing = await readStateFile(filePath);
    if (!existing) {
      exit(`No state file found for PR #${num}`);
    }

    const oldStatus = existing.status;
    if (oldStatus === newStatus) {
      console.log(`INFO: PR #${num} is already '${newStatus}'`);
      process.exit(0);
    }

    const updated: PRScanFile = {
      ...existing,
      status: newStatus as PRScanStatus,
      updatedAt: nowISO(),
    };

    await writeStateFile(filePath, updated);

    // Manage GitHub label based on status
    if (!skipGhCheck) {
      if (newStatus === 'reviewing') {
        try {
          await ghAddLabel(repo, num, label);
        } catch {
          console.error(`WARN: Failed to add label to PR #${num}`);
        }
      } else {
        // Remove reviewing label when PR leaves reviewing state
        try {
          await ghRemoveLabel(repo, num, label);
        } catch {
          console.error(`WARN: Failed to remove label from PR #${num}`);
        }
      }
    }

    console.log(`OK: PR #${num} status changed: ${oldStatus} → ${newStatus}`);
  } finally {
    await lock.release();
  }
}

// ---- Main ----

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'scan':
      await cmdScan();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'mark':
      if (args.length < 3) {
        exit('Usage: pr-scanner.ts mark <pr-number> <status>');
      }
      await cmdMark(args[1], args[2]);
      break;
    default:
      exit('Usage: pr-scanner.ts <scan|status|mark>');
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
