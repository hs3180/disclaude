/**
 * Configuration management for Disclaude core.
 *
 * This module provides centralized configuration management with support for:
 * - YAML configuration files (disclaude.config.yaml)
 *
 * All configuration is read from the config file.
 */
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import {
  loadConfigFile,
  getConfigFromFile,
  validateConfig,
  getPreloadedConfig,
} from './loader.js';
import type {
  DisclaudeConfig,
  ConfigValidationError,
  TransportConfig,
  McpServerConfig,
  DebugConfig,
  SessionTimeoutConfig,
} from './types.js';
import { type AgentRuntimeContext, setRuntimeContext } from '../agents/types.js';

// Re-export sub-modules
export * from './types.js';
export * from './loader.js';
export * from './tool-configuration.js';
export { loadRuntimeEnv, setRuntimeEnv, deleteRuntimeEnv } from './runtime-env.js';

const logger = createLogger('Config');

// Load configuration file (use preloaded config if available from CLI --config)
const fileConfig = getPreloadedConfig() || loadConfigFile();
const fileConfigOnly = validateConfig(fileConfig) ? getConfigFromFile(fileConfig) : {};
const configLoaded = fileConfig._fromFile;

/**
 * Apply global environment variables from config file to process.env.
 *
 * Injects env vars defined in disclaude.config.yaml's `env:` section into
 * the main process's process.env. This ensures Skills, MCP servers, and
 * other main-process components can access configured environment variables.
 *
 * System environment variables take precedence — config values will NOT
 * override existing process.env entries.
 *
 * Must be called AFTER setLoadedConfig() so that the preloaded config
 * (set via --config CLI flag) is available and takes precedence over
 * the default config loaded at module import time.
 *
 * @see Issue #1618
 */
export function applyGlobalEnv(): void {
  // Prefer preloaded config (set via --config CLI flag) over the default
  // config loaded at module import time. This ensures applyGlobalEnv()
  // reads from the correct config file when --config is used.
  const preloaded = getPreloadedConfig();
  const env = (preloaded && validateConfig(preloaded))
    ? (getConfigFromFile(preloaded).env || {})
    : Config.getGlobalEnv();

  let applied = 0;
  let skipped = 0;

  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = String(value);
      applied++;
    } else {
      skipped++;
    }
  }

  if (applied > 0) {
    logger.info(
      { applied, skipped, keys: Object.keys(env) },
      'Applied global env vars to process.env',
    );
  } else if (skipped > 0) {
    logger.debug(
      { skipped, keys: Object.keys(env) },
      'Skipped global env vars (already set in process.env)',
    );
  }
}

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
  // Resolve to absolute path to ensure getWorkspaceDir() always returns absolute path.
  // Relative paths are resolved against the config file's directory (not process.cwd()).
  private static readonly CONFIG_DIR = fileConfig._source
    ? path.dirname(fileConfig._source)
    : process.cwd();
  private static readonly RAW_WORKSPACE_DIR = fileConfigOnly.workspace?.dir || Config.CONFIG_DIR;
  static readonly WORKSPACE_DIR = path.isAbsolute(Config.RAW_WORKSPACE_DIR)
    ? Config.RAW_WORKSPACE_DIR
    : path.resolve(Config.CONFIG_DIR, Config.RAW_WORKSPACE_DIR);

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
          static readonly SDK_DEBUG = fileConfigOnly.logging?.sdkDebug ?? true;

          // Skills configuration - loaded from package installation directory
          static readonly SKILLS_DIR = Config.getBuiltinDir('skills');

          // Agents configuration - loaded from package installation directory
          static readonly AGENTS_DIR = Config.getBuiltinDir('agents');

  /**
   * Get a built-in resource directory from package installation.
   * Shared resolution logic for skills, agents, and other bundled resources.
   *
   * After bundling, import.meta.url points to the entry point file:
   * - cli-entry.js (bundled): dist/cli-entry.js -> <dirName> (one level up)
   * - index.js (module): dist/config/index.js -> <dirName> (two levels up)
   *
   * When bundled as CommonJS, import.meta.url is undefined, so we use __dirname.
   *
   * @param dirName - Directory name to resolve (e.g. 'skills', 'agents')
   * @returns Absolute path to the directory
   */
  private static getBuiltinDir(dirName: string): string {
    // In CommonJS bundling, import.meta.url is undefined
    // Use process.cwd() as fallback and resolve from install directory
    if (typeof import.meta.url === 'undefined') {
      return path.join('/app', dirName);
    }

    const moduleUrl = fileURLToPath(import.meta.url);
    const moduleDir = path.dirname(moduleUrl);

    // Detect if we're in a bundled file (cli-entry.js) or module (index.js)
    // Bundled files are directly in dist/, modules are in dist/config/
    const isBundled = path.basename(moduleDir) === 'dist';

    let resolvedDir: string;
    if (isBundled) {
      // dist/cli-entry.js -> dist/ -> ../<dirName>
      resolvedDir = path.resolve(moduleDir, '..', dirName);
    } else {
      // dist/config/index.js -> dist/ -> ../../<dirName>
      resolvedDir = path.resolve(moduleDir, '..', '..', dirName);
    }

    // In monorepo layout, the resolved path may point inside a package
    // (e.g. /app/packages/core/<dirName>) where the resource doesn't exist.
    // Fall back to <cwd>/<dirName> in that case.
    if (!existsSync(resolvedDir)) {
      const cwdDir = path.resolve(process.cwd(), dirName);
      if (existsSync(cwdDir)) {
        return cwdDir;
      }
    }

    return resolvedDir;
  }

  /**
   * Get the raw configuration object.
   * Returns preloaded config if set via CLI --config, otherwise returns default loaded config.
   *
   * @returns Complete configuration from file
   */
  static getRawConfig(): DisclaudeConfig {
    // Check for preloaded config first (set via CLI --config)
    const preloaded = getPreloadedConfig();
    if (preloaded && validateConfig(preloaded)) {
      return getConfigFromFile(preloaded);
    }
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
   * Get the agents directory.
   *
   * @returns Absolute path to the agents directory
   */
  static getAgentsDir(): string {
    return this.AGENTS_DIR;
  }

  /**
   * Validate required configuration fields.
   * Ensures all required fields are present before returning config.
   *
   * Validation priority (config file takes precedence over environment variables):
   * 1. If agent.provider is explicitly set, validate only that provider's config
   * 2. If GLM is configured (apiKey in config file), validate GLM config
   * 3. Otherwise, if Anthropic env var exists, validate Anthropic config
   *
   * @throws Error if required configuration is missing
   */
  private static validateRequiredConfig(): void {
    const errors: ConfigValidationError[] = [];

    // Get provider preference from config file
    const provider = fileConfigOnly.agent?.provider;

    // Determine which provider to validate based on config priority
    if (provider === 'glm') {
      // User explicitly chose GLM - only validate GLM config
      if (!this.GLM_API_KEY) {
        errors.push({
          field: 'glm.apiKey',
          message: 'glm.apiKey is required when agent.provider is "glm"',
        });
      }
      if (!this.GLM_MODEL) {
        errors.push({
          field: 'glm.model',
          message: 'glm.model is required when using GLM provider',
        });
      }
    } else if (provider === 'anthropic') {
      // User explicitly chose Anthropic - only validate Anthropic config
      if (!this.ANTHROPIC_API_KEY) {
        errors.push({
          field: 'ANTHROPIC_API_KEY',
          message: 'ANTHROPIC_API_KEY environment variable is required when agent.provider is "anthropic"',
        });
      }
      if (!this.CLAUDE_MODEL) {
        errors.push({
          field: 'agent.model',
          message: 'agent.model is required when using Anthropic provider',
        });
      }
    } else if (this.GLM_API_KEY) {
      // No explicit provider, but GLM is configured in config file - validate GLM
      if (!this.GLM_MODEL) {
        errors.push({
          field: 'glm.model',
          message: 'glm.model is required when GLM API key is configured',
        });
      }
    } else if (this.ANTHROPIC_API_KEY) {
      // Fallback to Anthropic (from environment variable)
      if (!this.CLAUDE_MODEL) {
        errors.push({
          field: 'agent.model',
          message: 'agent.model is required when using Anthropic (ANTHROPIC_API_KEY is set)',
        });
      }
    } else {
      // No provider configured at all
      errors.push({
        field: 'apiKey',
        message: 'No API key configured. Set glm.apiKey in disclaude.config.yaml or ANTHROPIC_API_KEY environment variable',
      });
    }

    if (errors.length > 0) {
      const messages = errors.map(e => `  ❌ ${e.field}: ${e.message}`).join('\n');
      logger.error({ errors }, 'Configuration validation failed');
      throw new Error(
        `Configuration validation failed:\n\n${messages}\n\n` +
        'Please update your disclaude.config.yaml file:\n' +
        '  glm:\n' +
        '    apiKey: "your-key"\n' +
        '    model: "glm-5"'
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
  static getMcpServersConfig(): Record<string, McpServerConfig> | undefined {
    return fileConfigOnly.tools?.mcpServers;
  }

  /**
   * Get transport configuration.
   *
   * @returns Transport configuration object
   */
  static getTransportConfig(): TransportConfig {
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
    sdkDebug: boolean;
  } {
    return {
      level: this.LOG_LEVEL,
      file: this.LOG_FILE,
      pretty: this.LOG_PRETTY,
      rotate: this.LOG_ROTATE,
      sdkDebug: this.SDK_DEBUG,
    };
  }

  /**
   * Get global environment variables from config file.
   * These will be passed to all agent processes.
   *
   * Prefers preloaded config (set via --config CLI flag) over the default
   * config loaded at module import time, consistent with applyGlobalEnv().
   *
   * @see Issue #1839
   * @returns Global environment variables object
   */
  static getGlobalEnv(): Record<string, string> {
    const preloaded = getPreloadedConfig();
    if (preloaded && validateConfig(preloaded)) {
      return getConfigFromFile(preloaded).env || {};
    }
    return fileConfigOnly.env || {};
  }

  /**
   * Get debug configuration for filtered message forwarding.
   * @see Issue #597
   *
   * @returns Debug configuration object
   */
  static getDebugConfig(): DebugConfig {
    return fileConfigOnly.messaging?.debug || {};
  }

  /**
   * Check if Agent Teams mode is enabled.
   * When enabled, sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 for SDK subprocess.
   *
   * @returns true if Agent Teams mode is enabled
   */
  static isAgentTeamsEnabled(): boolean {
    return fileConfigOnly.agent?.enableAgentTeams ?? false;
  }

  /**
   * Get session restoration configuration.
   * Controls how chat history is loaded when agent starts or resets.
   * @see Issue #1213
   *
   * @returns Session restoration configuration with defaults
   */
  static getSessionRestoreConfig(): {
    historyDays: number;
    maxContextLength: number;
  } {
    const config = fileConfigOnly.sessionRestore || {};
    return {
      historyDays: config.historyDays ?? 7,
      maxContextLength: config.maxContextLength ?? 4000,
    };
  }

  /**
   * Get session timeout configuration.
   * Controls automatic cleanup of idle sessions.
   * @see Issue #1313
   *
   * @returns Session timeout configuration with defaults, or null if disabled
   */
  static getSessionTimeoutConfig(): SessionTimeoutConfig & { enabled: boolean } | null {
    const timeoutConfig = fileConfigOnly.sessionRestore?.sessionTimeout;
    if (!timeoutConfig || timeoutConfig.enabled === false) {
      return null;
    }
    return {
      enabled: true,
      idleMinutes: timeoutConfig.idleMinutes ?? 30,
      maxSessions: timeoutConfig.maxSessions ?? 100,
      checkIntervalMinutes: timeoutConfig.checkIntervalMinutes ?? 5,
    };
  }

  /**
   * Get SDK HTTP request timeout in milliseconds.
   * This sets the ANTHROPIC_TIMEOUT env var for the SDK subprocess,
   * preventing infinite hangs when TCP connections to the API proxy stall.
   * @see Issue #2992
   *
   * @returns Timeout in milliseconds (default: 300000 = 5 minutes)
   */
  static getSdkTimeoutMs(): number {
    return fileConfigOnly.agent?.sdkTimeoutMs ?? 300_000;
  }
}

// ============================================================================
// Runtime Context Factory (Issue #1839)
// ============================================================================

/**
 * Create a default AgentRuntimeContext wired to Config static methods.
 *
 * This eliminates duplicated setRuntimeContext() calls across CLI entry points.
 * Platform-specific methods (sendMessage, sendCard, etc.) can be passed via overrides.
 *
 * @example
 * ```typescript
 * import { createDefaultRuntimeContext } from '@disclaude/core';
 *
 * // Basic usage (config-only context)
 * createDefaultRuntimeContext();
 *
 * // With platform overrides
 * createDefaultRuntimeContext({
 *   sendMessage: (chatId, text) => channel.send(chatId, text),
 *   sendCard: (chatId, card) => channel.sendCard(chatId, card),
 * });
 * ```
 *
 * @param overrides - Optional platform-specific method overrides
 * @returns AgentRuntimeContext wired to Config
 * @see Issue #1839
 */
export function createDefaultRuntimeContext(
  overrides?: Partial<AgentRuntimeContext>,
): AgentRuntimeContext {
  const ctx: AgentRuntimeContext = {
    getWorkspaceDir: () => Config.getWorkspaceDir(),
    getAgentConfig: () => Config.getAgentConfig(),
    getLoggingConfig: () => Config.getLoggingConfig(),
    getGlobalEnv: () => Config.getGlobalEnv(),
    isAgentTeamsEnabled: () => Config.isAgentTeamsEnabled(),
    ...overrides,
  };
  setRuntimeContext(ctx);
  return ctx;
}
