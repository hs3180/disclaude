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
  // Relative paths are resolved against the config file's directory.
  //
  // When the config file is inside a git repo and the relative path resolves
  // to a directory inside that repo, the resolved path is likely wrong — it
  // points to the repo's internal workspace/ instead of the production workspace.
  // In that case, fall back to resolving against process.cwd() (Issue #3902).
  private static readonly CONFIG_DIR = fileConfig._source
    ? path.dirname(fileConfig._source)
    : process.cwd();
  private static readonly RAW_WORKSPACE_DIR = fileConfigOnly.workspace?.dir || Config.CONFIG_DIR;
  private static readonly RESOLVED_VIA_CONFIG = path.isAbsolute(Config.RAW_WORKSPACE_DIR)
    ? Config.RAW_WORKSPACE_DIR
    : path.resolve(Config.CONFIG_DIR, Config.RAW_WORKSPACE_DIR);
  // Private: use getWorkspaceDir() for all access. This ensures callers
  // consistently go through the env-var override path (DISCLAUDE_WORKSPACE_DIR).
  private static readonly WORKSPACE_DIR = Config.resolveWorkspaceDir(Config.RAW_WORKSPACE_DIR, Config.RESOLVED_VIA_CONFIG);

  /**
   * Determine the correct workspace directory.
   *
   * Resolution strategy (for relative paths only; absolute paths pass through):
   *
   * 1. Resolve relative path against config file's directory (config-relative).
   * 2. If config is inside a git repo (.git/ exists in config dir) **and**
   *    the config-relative result points inside that repo, the path is likely
   *    wrong — it resolves to the repo's internal directory instead of the
   *    production workspace. Fall back to resolving against process.cwd().
   * 3. If config-relative and cwd-relative resolve to the same path (e.g.
   *    process.cwd() == config dir), no fallback is needed.
   *
   * **Note**: In production (Docker), this fallback is bypassed entirely when
   * `DISCLAUDE_WORKSPACE_DIR` env var is set — getWorkspaceDir() returns the
   * env var value directly. The git-repo detection here serves as a defensive
   * fallback for development environments without the env var.
   *
   * @param rawDir - The raw workspace.dir value from config (may be relative or absolute)
   * @param configRelativeDir - rawDir resolved against the config file's directory
   * @returns The resolved absolute workspace directory path
   */
  private static resolveWorkspaceDir(rawDir: string, configRelativeDir: string): string {
    if (path.isAbsolute(rawDir)) {
      return rawDir;
    }

    // Check if config file is inside a git repo
    const configDir = Config.CONFIG_DIR;
    const gitDir = path.join(configDir, '.git');
    if (existsSync(gitDir) && configRelativeDir.startsWith(configDir + path.sep)) {
      // Config is in a git repo and the resolved dir is inside that repo.
      // This is likely wrong — try resolving against cwd instead.
      const cwdRelativeDir = path.resolve(process.cwd(), rawDir);
      if (cwdRelativeDir !== configRelativeDir) {
        logger.warn(
          {
            configRelativeDir,
            cwdRelativeDir,
            configSource: Config.CONFIG_SOURCE,
          },
          'workspace.dir resolved inside git repo; falling back to cwd-relative path. '
          + 'Consider setting DISCLAUDE_WORKSPACE_DIR env var or using an absolute path.',
        );
        return cwdRelativeDir;
      }
    }

    return configRelativeDir;
  }

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

          // Tier model configuration (Issue #3059)
          private static readonly CLAUDE_HIGH_MODEL = fileConfigOnly.agent?.highModel || '';
          private static readonly CLAUDE_LOW_MODEL = fileConfigOnly.agent?.lowModel || '';
          private static readonly CLAUDE_MULTIMODAL_MODEL = fileConfigOnly.agent?.multimodalModel || '';
          private static readonly GLM_HIGH_MODEL = fileConfigOnly.glm?.highModel || '';
          private static readonly GLM_LOW_MODEL = fileConfigOnly.glm?.lowModel || '';
          private static readonly GLM_MULTIMODAL_MODEL = fileConfigOnly.glm?.multimodalModel || '';

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
   * Supports environment variable override via `DISCLAUDE_WORKSPACE_DIR`.
   * When set, the env var takes precedence over config file and defaults.
   * This enables test isolation without modifying production code interfaces.
   *
   * @returns Absolute path to the workspace directory
   * @see Issue #3414
   */
  static getWorkspaceDir(): string {
    // Allow override via environment variable for test isolation
    if (process.env.DISCLAUDE_WORKSPACE_DIR && process.env.DISCLAUDE_WORKSPACE_DIR.trim() !== '') {
      const overrideDir = path.resolve(process.env.DISCLAUDE_WORKSPACE_DIR);
      logger.debug({ workspaceDir: overrideDir, source: 'environment-variable' }, 'Using workspace directory');
      return overrideDir;
    }

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

      // Issue #3706: Warn when GLM + Agent Teams is enabled.
      // GLM models proxied through Anthropic-compatible API may not properly
      // support tool_use blocks for in-process team workers, causing idle loops.
      if (this.isAgentTeamsEnabled()) {
        logger.warn(
          { provider: 'GLM', model: this.GLM_MODEL, enableAgentTeams: true },
          'GLM + Agent Teams enabled: GLM models may not emit tool_use blocks for '
          + 'in-process team workers. If workers are stuck in idle loops, try '
          + 'disabling Agent Teams or using Anthropic models for workers.'
        );
      }

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
   * Resolve a model name for the given tier.
   *
   * Resolution priority: tier-specific model → default model (fallback).
   *
   * @param tier - Model tier (high, low, multimodal)
   * @returns Model identifier string, or undefined if tier is not set
   * @see Issue #3059
   */
  static getModelForTier(tier: 'high' | 'low' | 'multimodal'): string | undefined {
    // Check GLM tier models first (if GLM is configured)
    if (this.GLM_API_KEY) {
      const glmTierMap: Record<string, string> = {
        high: this.GLM_HIGH_MODEL,
        low: this.GLM_LOW_MODEL,
        multimodal: this.GLM_MULTIMODAL_MODEL,
      };
      const tierModel = glmTierMap[tier];
      if (tierModel) {
        logger.debug({ provider: 'GLM', tier, model: tierModel }, 'Using GLM tier model');
        return tierModel;
      }
      // Fallback to GLM default model
      logger.debug({ provider: 'GLM', tier, fallback: this.GLM_MODEL }, 'Tier model not set, using GLM default');
      return this.GLM_MODEL || undefined;
    }

    // Anthropic tier models
    const anthropicTierMap: Record<string, string> = {
      high: this.CLAUDE_HIGH_MODEL,
      low: this.CLAUDE_LOW_MODEL,
      multimodal: this.CLAUDE_MULTIMODAL_MODEL,
    };
    const tierModel = anthropicTierMap[tier];
    if (tierModel) {
      logger.debug({ provider: 'Anthropic', tier, model: tierModel }, 'Using Anthropic tier model');
      return tierModel;
    }
    // Fallback to Anthropic default model
    logger.debug({ provider: 'Anthropic', tier, fallback: this.CLAUDE_MODEL }, 'Tier model not set, using Anthropic default');
    return this.CLAUDE_MODEL || undefined;
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
   * When enabled, passes teammateMode to SDK via Settings (SDK 0.3.177+).
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
