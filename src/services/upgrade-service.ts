/**
 * UpgradeService - Handles disclaude self-upgrade functionality.
 *
 * Provides the ability to upgrade disclaude to the latest version via:
 * - Git pull (fetch latest code)
 * - NPM install (update dependencies)
 * - NPM build (rebuild)
 * - PM2 restart (restart service)
 *
 * @module services/upgrade-service
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('UpgradeService');
const execAsync = promisify(exec);

/**
 * Result of a single upgrade step.
 */
interface StepResult {
  success: boolean;
  message: string;
  output?: string;
}

/**
 * Result of the full upgrade process.
 */
export interface UpgradeResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  steps: StepResult[];
  error?: string;
}

/**
 * Options for upgrade.
 */
export interface UpgradeOptions {
  /** Skip git pull (use local code only) */
  skipGitPull?: boolean;
  /** Skip npm install */
  skipNpmInstall?: boolean;
  /** Skip build */
  skipBuild?: boolean;
  /** Skip PM2 restart */
  skipRestart?: boolean;
  /** Custom working directory */
  workingDir?: string;
}

/**
 * UpgradeService - Manages disclaude self-upgrade process.
 *
 * Security: This service should only be invoked by admin users.
 * The caller is responsible for permission checks.
 *
 * @example
 * ```typescript
 * const service = new UpgradeService();
 * const result = await service.upgrade();
 * if (result.success) {
 *   console.log(`Upgraded from ${result.previousVersion} to ${result.newVersion}`);
 * }
 * ```
 */
export class UpgradeService {
  private readonly workingDir: string;

  constructor(options?: { workingDir?: string }) {
    // Default to current working directory or configured workspace
    this.workingDir = options?.workingDir || process.cwd();
  }

  /**
   * Get the current version from package.json.
   */
  async getCurrentVersion(): Promise<string> {
    try {
      const packagePath = path.join(this.workingDir, 'package.json');
      const content = await fs.readFile(packagePath, 'utf-8');
      const pkg = JSON.parse(content);
      return pkg.version || 'unknown';
    } catch (error) {
      logger.error({ err: error }, 'Failed to read current version');
      return 'unknown';
    }
  }

  /**
   * Execute the full upgrade process.
   *
   * Steps:
   * 1. Get current version
   * 2. Git pull
   * 3. NPM install
   * 4. NPM build
   * 5. PM2 restart
   * 6. Verify new version
   */
  async upgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
    const steps: StepResult[] = [];
    let previousVersion = 'unknown';
    let newVersion = 'unknown';

    logger.info({ workingDir: this.workingDir }, 'Starting upgrade process');

    // Step 1: Get current version
    previousVersion = await this.getCurrentVersion();
    steps.push({
      success: true,
      message: `当前版本: v${previousVersion}`,
    });

    // Step 2: Git pull
    if (!options.skipGitPull) {
      const gitResult = await this.gitPull();
      steps.push(gitResult);
      if (!gitResult.success) {
        return {
          success: false,
          previousVersion,
          newVersion: previousVersion,
          steps,
          error: `Git pull failed: ${gitResult.message}`,
        };
      }
    }

    // Step 3: NPM install
    if (!options.skipNpmInstall) {
      const npmResult = await this.npmInstall();
      steps.push(npmResult);
      if (!npmResult.success) {
        return {
          success: false,
          previousVersion,
          newVersion: previousVersion,
          steps,
          error: `NPM install failed: ${npmResult.message}`,
        };
      }
    }

    // Step 4: NPM build
    if (!options.skipBuild) {
      const buildResult = await this.npmBuild();
      steps.push(buildResult);
      if (!buildResult.success) {
        return {
          success: false,
          previousVersion,
          newVersion: previousVersion,
          steps,
          error: `Build failed: ${buildResult.message}`,
        };
      }
    }

    // Step 5: Get new version
    newVersion = await this.getCurrentVersion();

    // Step 6: PM2 restart
    if (!options.skipRestart) {
      const restartResult = await this.pm2Restart();
      steps.push(restartResult);
      if (!restartResult.success) {
        return {
          success: false,
          previousVersion,
          newVersion,
          steps,
          error: `PM2 restart failed: ${restartResult.message}`,
        };
      }
    }

    logger.info({ previousVersion, newVersion }, 'Upgrade completed successfully');

    return {
      success: true,
      previousVersion,
      newVersion,
      steps,
    };
  }

  /**
   * Execute git pull to fetch latest code.
   */
  private async gitPull(): Promise<StepResult> {
    try {
      logger.debug('Executing git pull');
      const { stdout, stderr } = await execAsync('git pull', {
        cwd: this.workingDir,
        timeout: 60000, // 1 minute timeout
      });

      const output = (stdout + stderr).trim();
      logger.debug({ output }, 'Git pull completed');

      // Check if already up to date
      if (output.includes('Already up to date') || output.includes('Already up-to-date')) {
        return {
          success: true,
          message: '代码已是最新',
          output,
        };
      }

      return {
        success: true,
        message: '拉取最新代码成功',
        output,
      };
    } catch (error) {
      const err = error as Error;
      logger.error({ err }, 'Git pull failed');
      return {
        success: false,
        message: err.message || 'Git pull failed',
        output: err.message,
      };
    }
  }

  /**
   * Execute npm install to update dependencies.
   */
  private async npmInstall(): Promise<StepResult> {
    try {
      logger.debug('Executing npm install');
      const { stdout, stderr } = await execAsync('npm install', {
        cwd: this.workingDir,
        timeout: 300000, // 5 minute timeout
      });

      const output = (stdout + stderr).trim();
      logger.debug({ output: output.slice(-500) }, 'NPM install completed');

      return {
        success: true,
        message: '安装依赖成功',
        output: output.slice(-500), // Keep last 500 chars
      };
    } catch (error) {
      const err = error as Error;
      logger.error({ err }, 'NPM install failed');
      return {
        success: false,
        message: err.message || 'NPM install failed',
        output: err.message,
      };
    }
  }

  /**
   * Execute npm run build to rebuild the project.
   */
  private async npmBuild(): Promise<StepResult> {
    try {
      logger.debug('Executing npm run build');
      const { stdout, stderr } = await execAsync('npm run build', {
        cwd: this.workingDir,
        timeout: 300000, // 5 minute timeout
      });

      const output = (stdout + stderr).trim();
      logger.debug({ output: output.slice(-500) }, 'NPM build completed');

      return {
        success: true,
        message: '构建成功',
        output: output.slice(-500), // Keep last 500 chars
      };
    } catch (error) {
      const err = error as Error;
      logger.error({ err }, 'NPM build failed');
      return {
        success: false,
        message: err.message || 'NPM build failed',
        output: err.message,
      };
    }
  }

  /**
   * Execute pm2 restart to restart the service.
   */
  private async pm2Restart(): Promise<StepResult> {
    try {
      logger.debug('Executing pm2 restart');
      const { stdout, stderr } = await execAsync('npm run pm2:restart', {
        cwd: this.workingDir,
        timeout: 60000, // 1 minute timeout
      });

      const output = (stdout + stderr).trim();
      logger.debug({ output }, 'PM2 restart completed');

      return {
        success: true,
        message: '重启服务成功',
        output,
      };
    } catch (error) {
      const err = error as Error;
      logger.error({ err }, 'PM2 restart failed');
      return {
        success: false,
        message: err.message || 'PM2 restart failed',
        output: err.message,
      };
    }
  }

  /**
   * Check if the current directory is a valid disclaude installation.
   */
  async isValidInstallation(): Promise<boolean> {
    try {
      const packagePath = path.join(this.workingDir, 'package.json');
      const content = await fs.readFile(packagePath, 'utf-8');
      const pkg = JSON.parse(content);
      return pkg.name === 'disclaude';
    } catch {
      return false;
    }
  }
}

// Singleton instance for convenience
let defaultInstance: UpgradeService | null = null;

/**
 * Get the default UpgradeService instance.
 */
export function getUpgradeService(): UpgradeService {
  if (!defaultInstance) {
    defaultInstance = new UpgradeService();
  }
  return defaultInstance;
}
