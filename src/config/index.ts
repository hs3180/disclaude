/**
 * Configuration management for Disclaude.
 *
 * This module provides centralized configuration management with support for:
 * - YAML configuration files (disclaude.config.yaml)
 *
 * All configuration is read from the config file.
 */
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { loadConfigFile, getConfigFromFile, validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

// Export constants and types
export * from './constants.js';
export * from './tool-configuration.js';
export * from './types.js';
export * from './loader.js';

const logger = createLogger('Config');

// Load configuration file
const fileConfig = loadConfigFile();
const fileConfigOnly = validateConfig(fileConfig) ? getConfigFromFile(fileConfig) : {};
const configLoaded = fileConfig._fromFile;

/**
 * Application configuration class with static properties.
 *
 * All configuration is read from disclaude.config.yaml file.
 */
export class Config {
  // Configuration file metadata
  static readonly CONFIG_LOADED = configLoaded;
  static readonly CONFIG_SOURCE = fileConfig._source;

  // Workspace configuration
  static readonly WORKSPACE_DIR = fileConfigOnly.workspace?.dir || process.cwd();

  // Feishu/Lark configuration (from config file)
  static readonly FEISHU_APP_ID = fileConfigOnly.feishu?.appId || '';
  static readonly FEISHU_APP_SECRET = fileConfigOnly.feishu?.appSecret || '';
  static readonly FEISHU_CLI_CHAT_ID = fileConfigOnly.feishu?.cliChatId || '';

  // GLM configuration (from config file)
  static readonly GLM_API_KEY = fileConfigOnly.glm?.apiKey || '';
  static readonly GLM_MODEL = fileConfigOnly.glm?.model || fileConfigOnly.agent?.model || 'glm-4.7';
  static readonly GLM_API_BASE_URL = fileConfigOnly.glm?.apiBaseUrl || 'https://open.bigmodel.cn/api/anthropic';

  // Anthropic Claude configuration (from env for fallback)
  static readonly ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
  static readonly CLAUDE_MODEL = fileConfigOnly.agent?.model || 'claude-3-5-sonnet-20241022';

  // Logging configuration
  static readonly LOG_LEVEL = fileConfigOnly.logging?.level || 'info';
  static readonly LOG_FILE = fileConfigOnly.logging?.file;
  static readonly LOG_PRETTY = fileConfigOnly.logging?.pretty ?? true;
  static readonly LOG_ROTATE = fileConfigOnly.logging?.rotate ?? false;

  /**
   * Get the raw configuration object.
   *
   * @returns Complete configuration from file
   */
  static getRawConfig(): DisclaudeConfig {
    return fileConfigOnly;
  }

  /**
   * Get the workspace directory.
   *
   * @returns Absolute path to the workspace directory
   */
  static getWorkspaceDir(): string {
    const workspaceDir = this.WORKSPACE_DIR;
    logger.debug({ workspaceDir, source: this.CONFIG_LOADED ? 'config-file' : 'default' }, 'Using workspace directory');
    return workspaceDir;
  }

  /**
   * Resolve a path relative to the workspace directory.
   *
   * @param relativePath - Path relative to workspace
   * @returns Absolute path
   */
  static resolveWorkspace(relativePath: string): string {
    return path.resolve(this.getWorkspaceDir(), relativePath);
  }

  /**
   * Get agent configuration based on available API keys.
   * Prefers GLM if configured, otherwise falls back to Anthropic.
   *
   * @returns Agent configuration with API key and model
   * @throws Error if no API key is configured
   */
  static getAgentConfig(): {
    apiKey: string;
    model: string;
    apiBaseUrl?: string;
    provider: 'anthropic' | 'glm';
  } {
    // Prefer GLM if configured
    if (this.GLM_API_KEY) {
      logger.debug({ provider: 'GLM', model: this.GLM_MODEL }, 'Using GLM API configuration');
      return {
        apiKey: this.GLM_API_KEY,
        model: this.GLM_MODEL,
        apiBaseUrl: this.GLM_API_BASE_URL,
        provider: 'glm',
      };
    }

    // Fallback to Anthropic
    if (this.ANTHROPIC_API_KEY) {
      logger.debug({ provider: 'Anthropic', model: this.CLAUDE_MODEL }, 'Using Anthropic API configuration');
      return {
        apiKey: this.ANTHROPIC_API_KEY,
        model: this.CLAUDE_MODEL,
        provider: 'anthropic',
      };
    }

    const error = new Error('No API key configured. Set glm.apiKey in disclaude.config.yaml or ANTHROPIC_API_KEY env var');
    logger.error({ err: error }, 'Configuration error');
    throw error;
  }

  /**
   * Check if a configuration file was loaded.
   *
   * @returns true if config file was found and loaded
   */
  static hasConfigFile(): boolean {
    return this.CONFIG_LOADED;
  }

  /**
   * Get tool configuration from config file.
   *
   * @returns Tool configuration or undefined
   */
  static getToolConfig(): DisclaudeConfig['tools'] {
    return fileConfigOnly.tools;
  }

  /**
   * Get logging configuration.
   *
   * @returns Logging configuration object
   */
  static getLoggingConfig(): {
    level: string;
    file?: string;
    pretty: boolean;
    rotate: boolean;
  } {
    return {
      level: this.LOG_LEVEL,
      file: this.LOG_FILE,
      pretty: this.LOG_PRETTY,
      rotate: this.LOG_ROTATE,
    };
  }
}
