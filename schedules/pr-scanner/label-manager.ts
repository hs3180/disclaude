#!/usr/bin/env tsx
/**
 * schedules/pr-scanner/label-manager.ts — GitHub Label management for PR Scanner v2.
 *
 * Provides CLI actions to add/remove GitHub labels on PRs.
 * Used by SCHEDULE.md to manage `pr-scanner:reviewing` and `pr-scanner:approved` labels.
 *
 * Label operations are **non-blocking**: failures are logged but do not cause exit code 1.
 *
 * Usage:
 *   npx tsx schedules/pr-scanner/label-manager.ts --action add --pr 123 --label "pr-scanner:reviewing"
 *   npx tsx schedules/pr-scanner/label-manager.ts --action remove --pr 123 --label "pr-scanner:reviewing"
 *   npx tsx schedules/pr-scanner/label-manager.ts --action ensure --pr 123 --label "pr-scanner:reviewing"
 *
 * Exit codes:
 *   0 — success (or non-blocking label failure)
 *   1 — invalid arguments or missing dependencies
 */

import { execFile } from 'node:child_process';

const REPO = 'hs3180/disclaude';
const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BUFFER = 1024 * 1024;

// ---- Types ----

export interface LabelResult {
  success: boolean;
  action: 'add' | 'remove' | 'ensure';
  pr: number;
  label: string;
  error: string | null;
}

/** Executor function type for dependency injection (testability). */
export type GhExecFn = (args: string[]) => Promise<string>;

/**
 * Default executor using child_process.execFile with callback.
 * Avoids promisify to ensure consistent behavior with vi.mock in tests.
 */
function defaultGhExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        // Attach stderr to error for error reporting
        const error = new Error(stderr?.trim() || err.message) as Error & { stderr: string };
        error.stderr = stderr ?? '';
        reject(error);
      } else {
        resolve(stdout ?? '');
      }
    });
  });
}

// ---- Helpers ----

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

export function parseArgs(args: string[]): { action: string; pr: number; label: string } {
  const actionIdx = args.indexOf('--action');
  const prIdx = args.indexOf('--pr');
  const labelIdx = args.indexOf('--label');

  if (actionIdx === -1 || prIdx === -1 || labelIdx === -1) {
    fail('Usage: label-manager.ts --action <add|remove|ensure> --pr <number> --label <label>');
  }

  const action = args[actionIdx + 1];
  const prRaw = args[prIdx + 1];
  const label = args[labelIdx + 1];

  if (!action || !prRaw || !label) {
    fail('Missing value for --action, --pr, or --label');
  }

  if (action !== 'add' && action !== 'remove' && action !== 'ensure') {
    fail(`Invalid action '${action}' — must be 'add', 'remove', or 'ensure'`);
  }

  const pr = parseInt(prRaw, 10);
  if (!Number.isFinite(pr) || pr <= 0) {
    fail(`Invalid PR number '${prRaw}' — must be a positive integer`);
  }

  return { action, pr, label };
}

// ---- Core functions (exported for testing) ----

/**
 * Add a label to a PR via `gh pr edit`.
 */
export async function addLabel(pr: number, label: string, ghExec: GhExecFn = defaultGhExec): Promise<LabelResult> {
  try {
    await ghExec(['pr', 'edit', String(pr), '--repo', REPO, '--add-label', label]);
    return { success: true, action: 'add', pr, label, error: null };
  } catch (err: unknown) {
    const execErr = err as Error;
    const errorMsg = execErr.message
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, action: 'add', pr, label, error: errorMsg || 'unknown error' };
  }
}

/**
 * Remove a label from a PR via `gh pr edit`.
 */
export async function removeLabel(pr: number, label: string, ghExec: GhExecFn = defaultGhExec): Promise<LabelResult> {
  try {
    await ghExec(['pr', 'edit', String(pr), '--repo', REPO, '--remove-label', label]);
    return { success: true, action: 'remove', pr, label, error: null };
  } catch (err: unknown) {
    const execErr = err as Error;
    const errorMsg = execErr.message
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, action: 'remove', pr, label, error: errorMsg || 'unknown error' };
  }
}

/**
 * Ensure a label exists on a PR (idempotent add).
 * Checks if the label is already present before adding.
 */
export async function ensureLabel(pr: number, label: string, ghExec: GhExecFn = defaultGhExec): Promise<LabelResult> {
  try {
    // Check current labels
    const stdout = await ghExec([
      'pr', 'view', String(pr), '--repo', REPO,
      '--json', 'labels', '--jq', '.labels[].name',
    ]);
    const currentLabels: string[] = stdout
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (currentLabels.includes(label)) {
      return { success: true, action: 'ensure', pr, label, error: null };
    }

    // Label not present, add it (preserve action type as 'ensure')
    const addResult = await addLabel(pr, label, ghExec);
    return { ...addResult, action: 'ensure' };
  } catch {
    // If the check fails, fall back to add (which may also fail gracefully)
    const addResult = await addLabel(pr, label, ghExec);
    return { ...addResult, action: 'ensure' };
  }
}

/**
 * Execute a label action by name.
 */
export function executeAction(
  action: 'add' | 'remove' | 'ensure',
  pr: number,
  label: string,
  ghExec: GhExecFn = defaultGhExec,
): Promise<LabelResult> {
  switch (action) {
    case 'add':
      return addLabel(pr, label, ghExec);
    case 'remove':
      return removeLabel(pr, label, ghExec);
    case 'ensure':
      return ensureLabel(pr, label, ghExec);
  }
}

// ---- CLI ----

async function main() {
  const { action, pr, label } = parseArgs(process.argv.slice(2));

  const result = await executeAction(action as 'add' | 'remove' | 'ensure', pr, label);

  if (result.success) {
    console.log(JSON.stringify(result));
  } else {
    // Non-blocking: log warning but exit 0
    console.error(`WARN: Label operation failed (non-blocking): ${result.error}`);
    console.log(JSON.stringify(result));
  }
}

// Only run CLI when not in test environment
if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
