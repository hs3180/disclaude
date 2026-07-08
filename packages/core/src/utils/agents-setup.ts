/**
 * Agents setup utility for exposing preset agent definitions in-place.
 *
 * Issue #4224: instead of copying agent definitions from the package
 * installation directory into the workspace (the old copy-on-start), symlink
 * each `.md` into `$WORKSPACE/.claude/agents/`. A symlink is always current
 * (no stale copy after an upgrade), costs no per-restart overwrite IO, and
 * Claude Code discovers the agent in-place through the link. See
 * `utils/symlink.ts` for the link helper.
 *
 * Issue #4224 part 2: `setupAgentsInWorkspace` is **synchronous** so it
 * completes inside `getProvider()` before the provider is returned, eliminating
 * the first-message race.
 *
 * @see Issue #1410
 */
import { accessSync, mkdirSync, readdirSync } from 'node:fs';
import * as path from 'path';
import { createLogger } from './logger.js';
import { ensureSymlinkSync } from './symlink.js';
import { Config } from '../config/index.js';

const logger = createLogger('AgentsSetup');

/**
 * Symlink preset agent definitions from the package directory into workspace .claude/agents/.
 * Synchronous — completes before `getProvider()` returns (no first-message race).
 *
 * This enables Claude Code to load agent definitions via `.claude/agents/` in the
 * working directory. Only `.md` files are linked (agent definitions are Markdown).
 * The link always reflects the latest built-in definition (Issue #4224). For
 * customizations, users should place their versions in `<cwd>/.claude/agents/`
 * (project-level) which has higher priority.
 *
 * @returns Success status and error message if failed
 */
export function setupAgentsInWorkspace(): {
  success: boolean;
  error?: string;
} {
  try {
    const workspaceDir = Config.getWorkspaceDir();
    const targetDir = path.join(workspaceDir, '.claude', 'agents');
    const sourceDir = Config.getAgentsDir();

    logger.debug({
      workspaceDir,
      targetDir,
      sourceDir,
    }, 'Setting up agents in workspace');

    // Check if source agents directory exists
    try {
      accessSync(sourceDir);
    } catch {
      // Agents directory is optional — no error if missing
      logger.debug({ sourceDir }, 'Source agents directory does not exist, skipping');
      return { success: true };
    }

    // Create target directory if it doesn't exist
    try {
      mkdirSync(targetDir, { recursive: true });
      logger.debug({ targetDir }, 'Created target agents directory');
    } catch (error) {
      const err = error as Error;
      logger.error({ err, targetDir }, 'Failed to create target directory');
      return { success: false, error: err.message };
    }

    // Symlink only .md agent definition files (idempotent; migrates any stale copy).
    const entries = readdirSync(sourceDir, { withFileTypes: true });
    let linkedCount = 0;

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const agentName = entry.name;
        const sourcePath = path.join(sourceDir, agentName);
        const targetPath = path.join(targetDir, agentName);

        try {
          ensureSymlinkSync(sourcePath, targetPath, 'file');
          linkedCount++;
          logger.debug({ agentName, sourcePath, targetPath }, 'Linked agent definition');
        } catch (error) {
          const err = error as Error;
          logger.warn({ err, agentName }, 'Failed to link agent definition');
        }
      }
    }

    logger.info({
      targetDir,
      linkedCount,
      totalEntries: entries.length,
    }, 'Agent definitions linked into workspace');

    return { success: true };

  } catch (error) {
    const err = error as Error;
    logger.error({ err }, 'Failed to setup agents in workspace');
    return { success: false, error: err.message };
  }
}
