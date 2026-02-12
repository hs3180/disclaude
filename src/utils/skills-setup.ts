/**
 * Skills setup utility for copying skills to workspace.
 *
 * This module handles copying skills from the package installation directory
 * to the workspace's .claude directory, enabling SDK to load them via settingSources.
 *
 * Additionally, it copies and updates the configuration file to the workspace.
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

/**
 * Verify that skills are set up in workspace.
 *
 * @returns true if .claude/skills exists in workspace
 */
export async function verifySkillsSetup(): Promise<boolean> {
  try {
    const workspaceDir = Config.getWorkspaceDir();
    const skillsDir = path.join(workspaceDir, '.claude', 'skills');

    await fs.access(skillsDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy and update configuration file to workspace.
 *
 * This function copies the configuration file from the package root to the
 * workspace directory, updating the workspace.dir path to point to the
 * actual workspace location.
 *
 * The workspace config file helps SDK and other tools understand the
 * project structure without requiring global configuration.
 *
 * @returns Promise<boolean> True if config was copied successfully
 */
export async function copyConfigToWorkspace(): Promise<boolean> {
  try {
    const workspaceDir = Config.getWorkspaceDir();

    // Source config file (in package root)
    const packageRoot = process.cwd();
    const sourceConfig = path.join(packageRoot, 'disclaude.config.yaml');

    // Target config file (in workspace)
    const targetConfig = path.join(workspaceDir, 'disclaude.config.yaml');

    logger.debug({
      sourceConfig,
      targetConfig,
      workspaceDir,
    }, 'Copying config to workspace');

    // Check if source config exists
    try {
      await fs.access(sourceConfig);
    } catch {
      logger.warn({ sourceConfig }, 'Source config file not found, skipping copy');
      return false;
    }

    // Read source config
    const configContent = await fs.readFile(sourceConfig, 'utf-8');

    // Update workspace.dir in config
    const updatedConfig = updateWorkspaceDirInConfig(configContent, workspaceDir);

    // Write updated config to workspace
    await fs.writeFile(targetConfig, updatedConfig, 'utf-8');

    logger.info({ targetConfig }, 'Config copied and updated in workspace');
    return true;

  } catch (error) {
    const err = error as Error;
    logger.error({ err }, 'Failed to copy config to workspace');
    return false;
  }
}

/**
 * Update workspace directory in configuration content.
 *
 * This function replaces the workspace.dir value with the actual workspace path.
 * It handles both quoted and unquoted values.
 *
 * @param configContent - Original YAML configuration content
 * @param workspaceDir - New workspace directory path
 * @returns Updated configuration content
 */
function updateWorkspaceDirInConfig(configContent: string, workspaceDir: string): string {
  // Pattern to match workspace.dir: "path" or workspace.dir: path
  // This regex handles:
  // - workspace.dir: "/some/path"
  // - workspace.dir: '/some/path'
  // - workspace.dir: /some/path
  const pattern = /(workspace\s*:\s*\n\s*dir\s*:\s*)(["']?)([^\s"']+)?\2/g;

  const updated = configContent.replace(pattern, (_match, prefix, _quote, _oldValue) => {
    // Always use quoted format for consistency
    return `${prefix}"${workspaceDir}"`;
  });

  // Log if any changes were made
  if (updated !== configContent) {
    logger.debug({ workspaceDir }, 'Updated workspace.dir in config');
  }

  return updated;
}
