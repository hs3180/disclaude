/**
 * Configuration file loader for Disclaude.
 *
 * This module handles loading and parsing YAML configuration files.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
import type { DisclaudeConfig, LoadedConfig, ConfigFileInfo, ConfigValidationError } from './types.js';

const logger = createLogger('ConfigLoader');

/**
 * Configuration file names to search for, in priority order.
 */
const CONFIG_FILE_NAMES = [
  'disclaude.config.yaml',
  'disclaude.config.yml',
] as const;

/**
 * Search paths for configuration files.
 */
const SEARCH_PATHS = [
  process.cwd(), // Current working directory
  // If workspace directory is configured, also search parent directory
  process.env.WORKSPACE_DIR ? resolve(process.env.WORKSPACE_DIR, '..') : '',
  // Import meta URL directory (for bundled executables)
  import.meta.url ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : '',
  import.meta.url ? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') : '',
  process.env.HOME || '', // Home directory
].filter(Boolean);

/**
 * Find the configuration file in the search paths.
 *
 * @returns ConfigFileInfo with path and existence status
 */
export function findConfigFile(): ConfigFileInfo {
  for (const searchPath of SEARCH_PATHS) {
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = resolve(searchPath, fileName);
      if (existsSync(filePath)) {
        logger.debug({ filePath }, 'Found configuration file');
        return { path: filePath, exists: true };
      }
    }
  }

  logger.debug('No configuration file found, using defaults');
  return { path: '', exists: false };
}

/**
 * Load and parse the configuration file.
 *
 * @param filePath - Path to the configuration file (optional, will search if not provided)
 * @returns LoadedConfig object
 *
 * @example
 * ```typescript
 * const config = loadConfigFile();
 * if (config._fromFile) {
 *   console.log(`Loaded from ${config._source}`);
 * }
 * ```
 */
export function loadConfigFile(filePath?: string): LoadedConfig {
  const fileInfo = filePath
    ? { path: resolve(filePath), exists: existsSync(resolve(filePath)) }
    : findConfigFile();

  if (!fileInfo.exists) {
    return { _fromFile: false };
  }

  try {
    const content = readFileSync(fileInfo.path, 'utf-8');
    const parsed = yaml.load(content) as DisclaudeConfig | null | undefined;

    if (!parsed || typeof parsed !== 'object') {
      logger.warn({ path: fileInfo.path }, 'Configuration file is empty or invalid');
      return { _fromFile: false };
    }

    logger.info(
      { path: fileInfo.path, keys: Object.keys(parsed) },
      'Configuration file loaded successfully'
    );

    return {
      ...parsed,
      _source: fileInfo.path,
      _fromFile: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ path: fileInfo.path, error: errorMessage }, 'Failed to parse configuration file');
    return { _fromFile: false };
  }
}

/**
 * Get configuration from file only (no environment variable merging).
 *
 * Configuration is read directly from disclaude.config.yaml.
 * For sensitive values like API keys, store them in the config file.
 *
 * @param fileConfig - Configuration loaded from file
 * @returns Configuration object from file
 */
export function getConfigFromFile(fileConfig: LoadedConfig): DisclaudeConfig {
  const { _source, _fromFile, ...config } = fileConfig;
  return config;
}

/**
 * Validate configuration structure.
 *
 * Performs basic validation to ensure the configuration is well-formed.
 * For now, this is a simple check. In the future, could use a schema validator.
 *
 * @param config - Configuration to validate
 * @returns true if valid, false otherwise
 */
export function validateConfig(config: DisclaudeConfig): boolean {
  // Basic validation - ensure config is an object
  if (!config || typeof config !== 'object') {
    logger.error('Configuration must be an object');
    return false;
  }

  // Validate workspace config if present
  if (config.workspace?.dir && typeof config.workspace.dir !== 'string') {
    logger.error('workspace.dir must be a string');
    return false;
  }

  // Validate agent config if present
  if (config.agent?.model && typeof config.agent.model !== 'string') {
    logger.error('agent.model must be a string');
    return false;
  }

  // Validate logging config if present
  if (config.logging?.level && typeof config.logging.level !== 'string') {
    logger.error('logging.level must be a string');
    return false;
  }

  return true;
}

/**
 * Validate required configuration fields.
 * Called early to provide clear error messages about missing required fields.
 *
 * @param config - Configuration to validate
 * @returns Validation result with errors if any
 */
export function validateRequiredConfig(config: DisclaudeConfig): {
  valid: boolean;
  errors: ConfigValidationError[];
} {
  const errors: ConfigValidationError[] = [];

  // If GLM API key is configured, model must also be configured
  if (config.glm?.apiKey && !config.glm?.model) {
    errors.push({
      field: 'glm.model',
      message: 'glm.model is required when glm.apiKey is set',
    });
  }

  // If GLM model is configured, API key must also be configured
  if (config.glm?.model && !config.glm?.apiKey) {
    errors.push({
      field: 'glm.apiKey',
      message: 'glm.apiKey is required when glm.model is set',
    });
  }

  // If Anthropic API key is configured (from env), agent.model should be set
  if (process.env.ANTHROPIC_API_KEY && !config.agent?.model) {
    errors.push({
      field: 'agent.model',
      message: 'agent.model is required when ANTHROPIC_API_KEY env var is set',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
