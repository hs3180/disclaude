/**
 * Configuration management for Disclaude.
 *
 * This module provides centralized configuration management with support for:
 * - YAML configuration files (disclaude.config.yaml)
 *
 * All configuration is read from the config file.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import { loadConfigFile, getConfigFromFile, validateConfig } from './loader.js';
import type { DisclaudeConfig, ConfigValidationError } from './types.js';

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
  // Resolve to absolute path to ensure getWorkspaceDir() always returns absolute path
  private static readonly RAW_WORKSPACE_DIR = fileConfigOnly.workspace?.dir || process.cwd();
  static readonly WORKSPACE_DIR = path.isAbsolute(Config.RAW_WORKSPACE_DIR)
    ? Config.RAW_WORKSPACE_DIR
    : path.resolve(process.cwd(), Config.RAW_WORKSPACE_DIR);

  // Feishu/Lark configuration (from config file)
  static readonly FEISHU_APP_ID = fileConfigOnly.feishu?.appId || '';
  static readonly FEISHU_APP_SECRET = fileConfigOnly.feishu?.appSecret || '';
  static readonly FEISHU_CLI_CHAT_ID = fileConfigOnly.feishu?.cliChatId || '';

  // GLM configuration (from config file)
  // No fallback defaults - model must be explicitly configured
  static readonly GLM_API_KEY = fileConfigOnly.glm?.apiKey || '';
  static readonly GLM_MODEL = fileConfigOnly.glm?.model || '';
  static readonly GLM_API_BASE_URL = fileConfigOnly.glm?.apiBaseUrl || 'https://open.bigmodel.cn/api/anthropic';

  // Anthropic Claude configuration (from env for fallback)
  static readonly ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
  static readonly CLAUDE_MODEL = fileConfigOnly.agent?.model || '';

  // Logging configuration
  static readonly LOG_LEVEL = fileConfigOnly.logging?.level || 'info';
  static readonly LOG_FILE = fileConfigOnly.logging?.file;
  static readonly LOG_PRETTY = fileConfigOnly.logging?.pretty ?? true;
  static readonly LOG_ROTATE = fileConfigOnly.logging?.rotate ?? false;

  // Skills configuration - loaded from package installation directory
  static readonly SKILLS_DIR = Config.getBuiltinSkillsDir();

  /**
   * Get the built-in skills directory from package installation.
   * Skills are bundled with the package and loaded from the install location.
   *
   * After bundling, import.meta.url points to the entry point file:
   * - cli-entry.js (bundled): dist/cli-entry.js -> skills (one level up)
   * - index.js (module): dist/config/index.js -> skills (two levels up)
   *
   * When bundled as CommonJS, import.meta.url is undefined, so we use __dirname.
   *
   * @returns Absolute path to the skills directory
   */
  private static getBuiltinSkillsDir(): string {
    // In CommonJS bundling, import.meta.url is undefined
    // Use process.cwd() as fallback and resolve from install directory
    if (typeof import.meta.url === 'undefined') {
      // When bundled as CJS, we're in /app and skills is at /app/skills
      return '/app/skills';
    }

    const moduleUrl = fileURLToPath(import.meta.url);
    const moduleDir = path.dirname(moduleUrl);

    // Detect if we're in a bundled file (cli-entry.js) or module (index.js)
    // Bundled files are directly in dist/, modules are in dist/config/
    const isBundled = path.basename(moduleDir) === 'dist';

    if (isBundled) {
      // dist/cli-entry.js -> dist/ -> ../skills
      return path.join(moduleDir, '..', 'skills');
    } else {
      // dist/config/index.js -> dist/ -> ../../skills
      return path.join(moduleDir, '..', '..', 'skills');
    }
  }

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
   * Get the skills directory.
   *
   * @returns Absolute path to the skills directory
   */
  static getSkillsDir(): string {
    return this.SKILLS_DIR;
  }

  /**
   * Validate required configuration fields.
   * Ensures all required fields are present before returning config.
   *
   * @throws Error if required configuration is missing
   */
  private static validateRequiredConfig(): void {
    const errors: ConfigValidationError[] = [];

    // GLM configuration validation
    if (this.GLM_API_KEY) {
      if (!this.GLM_MODEL) {
        errors.push({
          field: 'glm.model',
          message: 'glm.model is required when GLM API key is configured',
        });
      }
    }

    // Anthropic configuration validation
    if (this.ANTHROPIC_API_KEY) {
      if (!this.CLAUDE_MODEL) {
        errors.push({
          field: 'agent.model',
          message: 'agent.model is required when ANTHROPIC_API_KEY is set',
        });
      }
    }

    // At least one API key must be configured
    if (!this.GLM_API_KEY && !this.ANTHROPIC_API_KEY) {
      errors.push({
        field: 'apiKey',
        message: 'No API key configured. Set glm.apiKey in disclaude.config.yaml',
      });
    }

    if (errors.length > 0) {
      const messages = errors.map(e => `  ❌ ${e.field}: ${e.message}`).join('\n');
      logger.error({ errors }, 'Configuration validation failed');
      throw new Error(
        `Configuration validation failed:\n\n${messages}\n\n` +
        `Please update your disclaude.config.yaml file:\n` +
        `  glm:\n` +
        `    apiKey: \"your-key\"\n` +
        `    model: \"glm-5\"`
      );
    }
  }

  /**
   * Get agent configuration based on available API keys.
   * Prefers GLM if configured, otherwise falls back to Anthropic.
   *
   * @returns Agent configuration with API key and model
   * @throws Error if no API key is configured or model is missing
   */
  static getAgentConfig(): {
    apiKey: string;
    model: string;
    apiBaseUrl?: string;
    provider: 'anthropic' | 'glm';
  } {
    // Validate required configuration first
    this.validateRequiredConfig();

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
    logger.debug({ provider: 'Anthropic', model: this.CLAUDE_MODEL }, 'Using Anthropic API configuration');
    return {
      apiKey: this.ANTHROPIC_API_KEY,
      model: this.CLAUDE_MODEL,
      provider: 'anthropic',
    };
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
   * Get MCP servers configuration from config file.
   *
   * @returns MCP servers configuration or undefined
   */
  static getMcpServersConfig(): Record<string, import('./types.js').McpServerConfig> | undefined {
    return fileConfigOnly.tools?.mcpServers;
  }

  /**
   * Get transport configuration.
   *
   * @returns Transport configuration object
   */
  static getTransportConfig(): import('./types.js').TransportConfig {
    return fileConfigOnly.transport || { type: 'local' };
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

  /**
   * Get global environment variables from config file.
   * These will be passed to all agent processes.
   *
   * @returns Global environment variables object
   */
  static getGlobalEnv(): Record<string, string> {
    return fileConfigOnly.env || {};
  }
}
