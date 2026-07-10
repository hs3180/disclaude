/**
 * Workspace directory setup utility.
 *
 * Ensures the configured workspace directory exists at startup, so runtime
 * data (logs, schedules, downloads, agent artifacts) can be written without
 * relying on a tracked placeholder file.
 *
 * Replaces the legacy `workspace/.gitkeep` placeholder (Issue #4254): the
 * workspace dir is runtime data and should be auto-created, not tracked in
 * git. Docker already creates `/data/workspace` via `mkdir -p` in
 * `Dockerfile.primary`; this utility covers the local (non-Docker) case so
 * both environments behave identically.
 *
 * @see Issue #4254
 */
import * as fs from 'fs/promises';
import { createLogger } from './logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('WorkspaceSetup');

/**
 * Ensure the configured workspace directory exists.
 *
 * Creates the directory (and any missing parents) with `recursive: true`.
 * Idempotent: safe to call multiple times. Failure is logged but not thrown,
 * so it never blocks startup — downstream writers will surface the concrete
 * error if the dir remains unwritable.
 *
 * @returns The resolved workspace directory path
 */
export async function ensureWorkspaceDir(): Promise<string> {
  const workspaceDir = Config.getWorkspaceDir();
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    logger.debug({ workspaceDir }, 'Workspace directory ensured');
  } catch (error) {
    // Don't throw — let downstream writers report the concrete failure.
    logger.warn({ err: error, workspaceDir }, 'Failed to ensure workspace directory');
  }
  return workspaceDir;
}
