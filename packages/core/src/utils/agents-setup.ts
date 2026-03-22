/**
 * Agents setup utility for copying preset agent definitions to workspace.
 *
 * This module handles copying agent definitions (Markdown files) from the
 * package installation directory to the workspace's .claude/agents directory,
 * enabling Claude Code to discover and use them natively.
 *
 * Issue: #1410 - Replace SubagentManager with project-level Agent definitions
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('AgentsSetup');

/**
 * Copy preset agent definitions from package directory to workspace .claude/agents.
 *
 * This enables Claude Code to discover project-level agent definitions via
 * its native .claude/agents/ scanning mechanism.
 *
 * Only copies files that don't already exist in the target directory,
 * preserving user customizations.
 *
 * @returns Success status and error message if failed
 */
export async function setupAgentsInWorkspace(): Promise<{
  success: boolean;
  error?: string;
}> {
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
      await fs.access(sourceDir);
    } catch {
      const error = `Source agents directory does not exist: ${sourceDir}`;
      logger.debug({ sourceDir }, 'Agents directory not found, skipping setup');
      return { success: true }; // Not an error - agents dir is optional
    }

    // Create target directory if it doesn't exist
    try {
      await fs.mkdir(targetDir, { recursive: true });
      logger.debug({ targetDir }, 'Created target agents directory');
    } catch (error) {
      const err = error as Error;
      logger.error({ err, targetDir }, 'Failed to create target directory');
      return { success: false, error: err.message };
    }

    // Copy agent definition files (only .md files)
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    let copiedCount = 0;
    let skippedCount = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }

      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);

      try {
        // Check if file already exists (preserve user customizations)
        await fs.access(targetPath);
        skippedCount++;
        logger.debug({ agent: entry.name }, 'Agent definition already exists, skipping');
      } catch {
        // File doesn't exist, copy it
        try {
          await fs.copyFile(sourcePath, targetPath);
          copiedCount++;
          logger.debug({ agent: entry.name, sourcePath, targetPath }, 'Copied agent definition');
        } catch (error) {
          const err = error as Error;
          logger.warn({ err, agent: entry.name }, 'Failed to copy agent definition');
        }
      }
    }

    logger.info({
      targetDir,
      copiedCount,
      skippedCount,
      totalFiles: entries.filter(e => e.isFile() && e.name.endsWith('.md')).length,
    }, 'Agent definitions copied to workspace');

    return { success: true };

  } catch (error) {
    const err = error as Error;
    logger.error({ err }, 'Failed to setup agents in workspace');
    return { success: false, error: err.message };
  }
}
