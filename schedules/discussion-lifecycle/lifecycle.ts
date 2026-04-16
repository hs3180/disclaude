#!/usr/bin/env npx tsx
/**
 * Discussion Lifecycle — CLI script for managing expired PR discussion groups.
 *
 * Issue #2221: Sub-Issue C — 讨论群生命周期管理 (Phase 2)
 * Parent: #2210 — PR Scanner v2
 *
 * Scans `.temp-chats/` for expired reviewing PRs, sends disband request cards,
 * and handles disband confirmation/cleanup.
 *
 * Usage:
 *   npx tsx lifecycle.ts --action check-expired
 *   npx tsx lifecycle.ts --action mark-disband --pr 123
 *   npx tsx lifecycle.ts --action delete-state --pr 123
 */

import { unlink } from 'node:fs/promises';
import {
  readAllStateFiles,
  readStateFile,
  writeStateFile,
  getStateFilePath,
  ensureStateDir,
  type PRStateFile,
} from '../pr-scanner/scanner.js';

// ---- Constants ----

/** Default directory for PR state files (relative to CWD) */
const DEFAULT_STATE_DIR = '.temp-chats';

/** Minimum interval between disband requests for the same PR (24 hours) */
const DISBAND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ---- Types ----

/** Expired PR info returned by check-expired */
export interface ExpiredPR {
  prNumber: number;
  chatId: string;
  state: string;
  expiresAt: string;
  /** Whether a disband request can be sent (within cooldown) */
  canSendDisband: boolean;
  /** ISO timestamp of last disband request, or null */
  lastDisbandRequested: string | null;
}

/** Result of check-expired action */
export interface CheckExpiredResult {
  expired: ExpiredPR[];
  total: number;
}

// ---- Pure functions (testable without I/O) ----

/**
 * Check if a disband request can be sent (not within cooldown period).
 */
export function canSendDisbandRequest(
  state: PRStateFile,
  now: Date = new Date(),
): boolean {
  if (state.disbandRequested === null) {
    return true;
  }
  const lastRequested = new Date(state.disbandRequested).getTime();
  const elapsed = now.getTime() - lastRequested;
  return elapsed >= DISBAND_COOLDOWN_MS;
}

/**
 * Filter state files to find expired reviewing PRs.
 * An expired PR is one where state is 'reviewing' and expiresAt < now.
 */
export function findExpiredReviewing(
  states: PRStateFile[],
  now: Date = new Date(),
): ExpiredPR[] {
  const nowISO = now.toISOString();
  return states
    .filter((s) => s.state === 'reviewing' && s.expiresAt < nowISO)
    .map((s) => ({
      prNumber: s.prNumber,
      chatId: s.chatId,
      state: s.state,
      expiresAt: s.expiresAt,
      canSendDisband: canSendDisbandRequest(s, now),
      lastDisbandRequested: s.disbandRequested,
    }));
}

// ---- State file operations ----

/**
 * Mark a PR's disbandRequested timestamp.
 * Updates the timestamp and writes to disk.
 */
export async function markDisbandRequested(
  stateDir: string,
  prNumber: number,
  now: Date = new Date(),
): Promise<PRStateFile> {
  const existing = await readStateFile(stateDir, prNumber);
  if (!existing) {
    throw new Error(`No state file found for PR #${prNumber}`);
  }

  if (existing.state !== 'reviewing') {
    throw new Error(
      `Cannot mark disband for PR #${prNumber}: state is '${existing.state}', expected 'reviewing'`,
    );
  }

  const updated: PRStateFile = {
    ...existing,
    disbandRequested: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await writeStateFile(stateDir, updated);
  return updated;
}

/**
 * Delete a PR's state file.
 * Used after successful disband to clean up.
 */
export async function deleteState(
  stateDir: string,
  prNumber: number,
): Promise<void> {
  const filePath = getStateFilePath(stateDir, prNumber);
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      throw new Error(`No state file found for PR #${prNumber}`);
    }
    throw err;
  }
}

// ---- CLI ----

type Action = 'check-expired' | 'mark-disband' | 'delete-state';

const VALID_ACTIONS: Action[] = ['check-expired', 'mark-disband', 'delete-state'];

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
Discussion Lifecycle — PR discussion group lifecycle management CLI

Usage:
  npx tsx lifecycle.ts --action <action> [options]

Actions:
  check-expired   Find expired reviewing PRs that need disband handling
  mark-disband    Update disbandRequested timestamp for a PR
  delete-state    Delete a PR's state file (after successful disband)

Options:
  --action <action>    Action to perform (required)
  --pr <number>        PR number (for mark-disband, delete-state)
  --state-dir <path>   State directory (default: .temp-chats)
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
    case 'check-expired': {
      const allStates = await readAllStateFiles(stateDir);
      const expired = findExpiredReviewing(allStates);
      const result: CheckExpiredResult = {
        expired,
        total: expired.length,
      };
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'mark-disband': {
      const prNumber = parseInt(args.pr ?? '', 10);
      if (!prNumber) {
        console.error('--pr is required for mark-disband');
        process.exit(1);
      }
      const result = await markDisbandRequested(stateDir, prNumber);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'delete-state': {
      const prNumber = parseInt(args.pr ?? '', 10);
      if (!prNumber) {
        console.error('--pr is required for delete-state');
        process.exit(1);
      }
      await deleteState(stateDir, prNumber);
      console.log(JSON.stringify({ ok: true, prNumber }, null, 2));
      break;
    }
  }
}

// Run main if executed directly (not imported)
const isDirectRun =
  process.argv[1]?.endsWith('lifecycle.ts') ||
  process.argv[1]?.endsWith('lifecycle.js');

if (isDirectRun) {
  main().catch((err) => {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
