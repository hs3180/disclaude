/**
 * Environment loader utility - .bashrc-like mechanism for Disclaude.
 *
 * This module provides functionality to load bash initialization scripts
 * from the working directory before the main service starts.
 *
 * Supported script files (executed in priority order):
 * 1. `.disclauderc` - Project-specific environment initialization
 * 2. `.env.sh` - Generic shell environment setup
 *
 * Use cases:
 * - Activating conda environments
 * - Setting custom PATH variables
 * - Loading environment-specific configurations
 * - Running shell-specific initialization logic
 *
 * @example
 * ```bash
 * # .disclauderc example
 * # Activate conda environment
 * source ~/anaconda/anaconda3/bin/activate falcon
 *
 * # Add custom binaries to PATH
 * export PATH="$HOME/custom/bin:$PATH"
 *
 * # Set custom variables
 * export CUSTOM_VAR="value"
 * ```
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('EnvLoader');

/**
 * Get the project root directory from the module URL.
 *
 * This function determines the project root based on the entry point location:
 * - When running from dist/cli-entry.js, the project root is one level up
 * - When running from dist/config/index.js, the project root is two levels up
 *
 * @returns Absolute path to the project root directory
 */
export function getProjectRoot(): string {
  const moduleUrl = fileURLToPath(import.meta.url);
  const moduleDir = dirname(moduleUrl);

  // Detect if we're in a bundled file (cli-entry.js level) or module
  // We need to go up from src/utils/env-loader.js -> src/ -> project root
  // Or from dist/utils/env-loader.js -> dist/ -> project root
  return resolve(moduleDir, '..', '..');
}

/**
 * Script file names to look for, in priority order.
 * First found script will be executed; others are ignored.
 */
const SCRIPT_NAMES = ['.disclauderc', '.env.sh'] as const;

/**
 * Result of environment loading operation.
 */
interface EnvLoadResult {
  success: boolean;
  scriptName: string | null;
  scriptPath: string | null;
  envCount: number;
  error?: string;
}

/**
 * Find and execute the first available bash initialization script.
 *
 * Scripts are searched in the project root directory. The first script found
 * (based on SCRIPT_NAMES priority) is executed in a bash shell, and environment
 * variables are captured and merged into the current process.
 *
 * The script is executed with the project root as the working directory,
 * allowing it to access project-specific files and configurations.
 *
 * Execution behavior:
 * - Scripts are run with `bash -c "cd <projectRoot> && source <script>; env"`
 * - Only environment variables (lines containing '=') are captured
 * - Existing process.env variables are NOT overwritten
 * - Script execution errors are logged but don't stop the application
 *
 * @returns Promise<EnvLoadResult> Result object with execution details
 *
 * @example
 * ```typescript
 * const result = await loadEnvironmentScripts();
 * if (result.success) {
 *   console.log(`Loaded ${result.envCount} variables from ${result.scriptName}`);
 * }
 * ```
 */
export async function loadEnvironmentScripts(): Promise<EnvLoadResult> {
  const projectRoot = getProjectRoot();

  logger.debug({ projectRoot, scriptNames: SCRIPT_NAMES }, 'Looking for environment scripts in project root');

  // Find the first available script
  const scriptName = SCRIPT_NAMES.find((name) => {
    const path = resolve(projectRoot, name);
    const exists = existsSync(path);
    logger.debug({ scriptName: name, path, exists }, 'Checking script file');
    return exists;
  });

  if (!scriptName) {
    logger.debug('No environment scripts found in project root');
    return {
      success: false,
      scriptName: null,
      scriptPath: null,
      envCount: 0,
    };
  }

  const scriptPath = resolve(projectRoot, scriptName);
  logger.info({ scriptPath, projectRoot }, 'Found environment script in project root, executing...');

  try {
    const envVars = await executeBashScript(scriptPath, projectRoot);

    // Merge environment variables into process.env
    let mergedCount = 0;
    const totalVars = Object.keys(envVars).length;

    for (const [key, value] of Object.entries(envVars)) {
      // Don't overwrite existing environment variables
      if (!process.env[key]) {
        process.env[key] = value;
        mergedCount++;
      }
    }

    logger.info(
      {
        scriptPath,
        totalVars,
        mergedVars: mergedCount,
        skippedVars: totalVars - mergedCount,
      },
      'Environment script loaded successfully'
    );

    return {
      success: true,
      scriptName,
      scriptPath,
      envCount: mergedCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ scriptPath, error: errorMessage }, 'Failed to execute environment script');

    return {
      success: false,
      scriptName,
      scriptPath,
      envCount: 0,
      error: errorMessage,
    };
  }
}

/**
 * Execute a bash script and capture environment variables.
 *
 * The script is sourced in a bash shell with the project root as the working directory,
 * and all environment variables are captured and returned as a key-value object.
 *
 * @param scriptPath - Absolute or relative path to the bash script
 * @param workingDir - Directory to execute the script from (usually project root)
 * @returns Promise<Record<string, string>> Object containing environment variables
 * @throws Error if script execution fails
 *
 * @private
 */
function executeBashScript(scriptPath: string, workingDir: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    // Use bash to change to project directory, source the script, and print all environment variables
    // We use `env` command to list all variables after sourcing
    const bash = spawn('bash', ['-lc', `cd "${workingDir}" && source "${scriptPath}" && env`], {
      cwd: workingDir,
      env: { ...process.env }, // Pass current environment
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    // Track if promise was already resolved/rejected to prevent double resolution
    let settled = false;

    const cleanup = () => {
      // Remove all listeners to prevent memory leaks
      bash.stdout?.removeAllListeners();
      bash.stderr?.removeAllListeners();
      bash.removeAllListeners();
    };

    bash.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    bash.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    bash.on('close', (code) => {
      if (settled) return;
      settled = true;

      cleanup();

      if (code !== 0) {
        reject(new Error(`Script exited with code ${code}: ${stderr}`));
        return;
      }

      // Parse environment variables from output
      // Format: KEY=value (one per line)
      const envVars: Record<string, string> = {};
      const lines = stdout.split('\n');

      for (const line of lines) {
        const eqIndex = line.indexOf('=');
        if (eqIndex > 0) {
          // Extract key and value
          const key = line.substring(0, eqIndex);
          const value = line.substring(eqIndex + 1);

          // Filter out bash internal variables and functions
          if (
            !key.startsWith('_') && // Skip bash internals
            !key.includes('PWD') && // Skip working directory (already set)
            !key.includes('SHLVL') && // Skip shell level
            key !== 'HOSTNAME' && // Skip hostname (irrelevant)
            !value.includes('\n') && // Skip multi-line functions
            !value.includes('() {') // Skip function definitions
          ) {
            envVars[key] = value;
          }
        }
      }

      resolve(envVars);
    });

    bash.on('error', (error) => {
      if (settled) return;
      settled = true;

      cleanup();
      reject(new Error(`Failed to spawn bash: ${error.message}`));
    });
  });
}

/**
 * Manually load environment from a specific script path.
 *
 * This function bypasses the automatic script discovery and loads
 * environment variables from a specific script file.
 *
 * @param scriptPath - Absolute path to the bash script
 * @returns Promise<EnvLoadResult> Result object with execution details
 *
 * @example
 * ```typescript
 * const result = await loadEnvironmentFromPath('/custom/path/setup.sh');
 * ```
 */
export async function loadEnvironmentFromPath(scriptPath: string): Promise<EnvLoadResult> {
  logger.debug({ scriptPath }, 'Loading environment from specific path');

  try {
    const projectRoot = getProjectRoot();
    const envVars = await executeBashScript(scriptPath, projectRoot);

    let mergedCount = 0;
    for (const [key, value] of Object.entries(envVars)) {
      if (!process.env[key]) {
        process.env[key] = value;
        mergedCount++;
      }
    }

    logger.info(
      {
        scriptPath,
        totalVars: envVars.length,
        mergedVars: mergedCount,
      },
      'Environment loaded from custom path'
    );

    return {
      success: true,
      scriptName: scriptPath.split('/').pop() || scriptPath,
      scriptPath,
      envCount: mergedCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ scriptPath, error: errorMessage }, 'Failed to load environment from path');

    return {
      success: false,
      scriptName: scriptPath.split('/').pop() || scriptPath,
      scriptPath,
      envCount: 0,
      error: errorMessage,
    };
  }
}
