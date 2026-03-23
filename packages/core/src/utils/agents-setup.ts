/**
 * Agents setup utility for copying preset agent definitions to workspace.
 *
 * This module handles copying agent definitions from the package installation
 * directory to the workspace's .claude/agents directory, enabling Claude Code
 * to discover and use them as project-level agents.
 *
 * @see Issue #1410
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('AgentsSetup');

/**
 * Copy preset agent definitions from package directory to workspace .claude/agents/.
 *
 * This enables Claude Code to load agent definitions via `.claude/agents/` in the
 * working directory. Only `.md` files are copied (agent definitions are Markdown).
 * Existing files are never overwritten (preserves user customizations).
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
      // Agents directory is optional — no error if missing
      logger.debug({ sourceDir }, 'Source agents directory does not exist, skipping');
      return { success: true };
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

    // Copy only .md agent definition files
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    let copiedCount = 0;

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const agentName = entry.name;
        const sourcePath = path.join(sourceDir, agentName);
        const targetPath = path.join(targetDir, agentName);

        try {
          // Skip if target already exists (preserve user customizations)
          await fs.access(targetPath);
          logger.debug({ agentName }, 'Agent definition already exists, skipping');
        } catch {
          // Target doesn't exist, copy it
          await fs.copyFile(sourcePath, targetPath);
          copiedCount++;
          logger.debug({ agentName, sourcePath, targetPath }, 'Copied agent definition');
        }
      }
    }

    logger.info({
      targetDir,
      copiedCount,
      totalEntries: entries.length,
    }, 'Agent definitions copied to workspace');

    return { success: true };

  } catch (error) {
    const err = error as Error;
    logger.error({ err }, 'Failed to setup agents in workspace');
    return { success: false, error: err.message };
  }
}
