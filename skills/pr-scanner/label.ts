/**
 * skills/pr-scanner/label.ts — GitHub Label management for PR Scanner.
 *
 * Provides non-blocking GitHub label operations via `gh` CLI.
 * Label failures are logged as warnings and never block the main flow.
 *
 * Environment variables:
 *   PR_SCANNER_REPO        GitHub repo in owner/name format (default: hs3180/disclaude)
 *   PR_SCANNER_SKIP_LABELS Set to 'true' to skip all label operations (for testing)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Label applied to PRs currently under review */
export const REVIEWING_LABEL = 'pr-scanner:reviewing';

/** Default GitHub repository */
const DEFAULT_REPO = 'hs3180/disclaude';

/** Get the configured GitHub repository */
export function getRepo(): string {
  return process.env.PR_SCANNER_REPO ?? DEFAULT_REPO;
}

/** Check if label operations should be skipped */
function shouldSkipLabels(): boolean {
  return process.env.PR_SCANNER_SKIP_LABELS === 'true';
}

/**
 * Add a GitHub label to a PR.
 * Non-blocking: failures are logged as warnings, never throws.
 */
export async function addLabel(prNumber: number, label: string): Promise<void> {
  if (shouldSkipLabels()) {
    console.error(`INFO: Skipping add-label '${label}' to PR #${prNumber} (PR_SCANNER_SKIP_LABELS=true)`);
    return;
  }

  const repo = getRepo();
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', repo,
      '--add-label', label,
    ], { timeout: 30_000 });
    console.error(`INFO: Added label '${label}' to PR #${prNumber}`);
  } catch (err) {
    console.error(
      `WARN: Failed to add label '${label}' to PR #${prNumber}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/**
 * Remove a GitHub label from a PR.
 * Non-blocking: failures are logged as warnings, never throws.
 */
export async function removeLabel(prNumber: number, label: string): Promise<void> {
  if (shouldSkipLabels()) {
    console.error(`INFO: Skipping remove-label '${label}' from PR #${prNumber} (PR_SCANNER_SKIP_LABELS=true)`);
    return;
  }

  const repo = getRepo();
  try {
    await execFileAsync('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', repo,
      '--remove-label', label,
    ], { timeout: 30_000 });
    console.error(`INFO: Removed label '${label}' from PR #${prNumber}`);
  } catch (err) {
    console.error(
      `WARN: Failed to remove label '${label}' from PR #${prNumber}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}
