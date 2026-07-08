/**
 * Skills setup utility for exposing package skills to the SDK in-place.
 *
 * Issue #4224: instead of copying skills from the package installation directory
 * into the workspace (the old copy-on-start), symlink each skill directory into
 * `$WORKSPACE/.claude/skills/`. A symlink is always current (no stale copy after
 * an upgrade), costs no per-restart overwrite IO, and the SDK discovers the skill
 * in-place through the link. See `utils/symlink.ts` for the link helper.
 *
 * Issue #4224 part 2: `setupSkillsInWorkspace` is **synchronous** so it completes
 * inside `getProvider()` before the provider is returned, eliminating the
 * first-message race (a query can no longer fire before the skills are linked).
 */
import { accessSync, mkdirSync, readdirSync } from 'node:fs';
import * as path from 'path';
import { createLogger } from './logger.js';
import { Config } from '../config/index.js';
import { ensureSymlinkSync } from './symlink.js';

const logger = createLogger('SkillsSetup');

/**
 * Symlink each package skill into workspace `.claude/skills/` for SDK discovery.
 * Synchronous — completes before `getProvider()` returns (no first-message race).
 *
 * @returns Success status and error message if failed
 */
export function setupSkillsInWorkspace(): {
  success: boolean;
  error?: string;
} {
  try {
    const workspaceDir = Config.getWorkspaceDir();
    const targetDir = path.join(workspaceDir, '.claude', 'skills');
    const sourceDir = Config.getSkillsDir();

    logger.debug({
      workspaceDir,
      targetDir,
      sourceDir,
    }, 'Setting up skills in workspace');

    // Check if source skills directory exists
    try {
      accessSync(sourceDir);
    } catch {
      const error = `Source skills directory does not exist: ${sourceDir}`;
      logger.error({ sourceDir }, 'Skills directory not found');
      return { success: false, error };
    }

    // Create target directory if it doesn't exist
    try {
      mkdirSync(targetDir, { recursive: true });
      logger.debug({ targetDir }, 'Created target skills directory');
    } catch (error) {
      const err = error as Error;
      logger.error({ err, targetDir }, 'Failed to create target directory');
      return { success: false, error: err.message };
    }

    // Symlink each skill directory into place (idempotent; migrates any stale copy).
    const entries = readdirSync(sourceDir, { withFileTypes: true });
    let linkedCount = 0;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillName = entry.name;
        const sourcePath = path.join(sourceDir, skillName);
        const targetPath = path.join(targetDir, skillName);

        try {
          ensureSymlinkSync(sourcePath, targetPath, 'dir');
          linkedCount++;
          logger.debug({ skillName, sourcePath, targetPath }, 'Linked skill directory');
        } catch (error) {
          const err = error as Error;
          logger.warn({ err, skillName }, 'Failed to link skill directory');
          // Continue with other skills even if one fails
        }
      }
    }

    logger.info({
      targetDir,
      linkedCount,
      totalEntries: entries.length,
    }, 'Skills linked into workspace');

    return { success: true };

  } catch (error) {
    const err = error as Error;
    logger.error({ err }, 'Failed to setup skills in workspace');
    return { success: false, error: err.message };
  }
}
