/**
 * Skills setup utility for copying skills to workspace.
 *
 * This module handles copying skills from the package installation directory
 * to the workspace's .claude directory, enabling SDK to load them via settingSources.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('SkillsSetup');

/**
 * Copy skills from package directory to workspace .claude/skills.
 *
 * This enables the SDK to load skills via settingSources: ['project'],
 * which looks for .claude/skills/ in the working directory.
 *
 * @returns Success status and error message if failed
 */
export async function setupSkillsInWorkspace(): Promise<{
  success: boolean;
  error?: string;
}> {
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
      await fs.access(sourceDir);
    } catch {
      const error = `Source skills directory does not exist: ${sourceDir}`;
      logger.error({ sourceDir }, 'Skills directory not found');
      return { success: false, error };
    }

    // Create target directory if it doesn't exist
    try {
      await fs.mkdir(targetDir, { recursive: true });
      logger.debug({ targetDir }, 'Created target skills directory');
    } catch (error) {
      const err = error as Error;
      logger.error({ err, targetDir }, 'Failed to create target directory');
      return { success: false, error: err.message };
    }

    // Copy all skill directories
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    let copiedCount = 0;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillName = entry.name;
        const sourcePath = path.join(sourceDir, skillName);
        const targetPath = path.join(targetDir, skillName);

        try {
          // Copy directory recursively
          await copyDirectory(sourcePath, targetPath);
          copiedCount++;
          logger.debug({ skillName, sourcePath, targetPath }, 'Copied skill directory');
        } catch (error) {
          const err = error as Error;
          logger.warn({ err, skillName }, 'Failed to copy skill directory');
          // Continue with other skills even if one fails
        }
      }
    }

    logger.info({
      targetDir,
      copiedCount,
      totalEntries: entries.length,
    }, 'Skills copied to workspace');

    return { success: true };

  } catch (error) {
    const err = error as Error;
    logger.error({ err }, 'Failed to setup skills in workspace');
    return { success: false, error: err.message };
  }
}

/**
 * Copy a directory recursively.
 */
async function copyDirectory(source: string, target: string): Promise<void> {
  // Create target directory
  await fs.mkdir(target, { recursive: true });

  // Read source directory
  const entries = await fs.readdir(source, { withFileTypes: true });

  // Copy each entry
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      // Recursively copy subdirectory
      await copyDirectory(sourcePath, targetPath);
    } else {
      // Copy file
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}
