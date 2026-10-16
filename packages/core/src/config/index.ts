/**
 * Configuration management for Disclaude core.
 *
 * This module provides centralized configuration management with support for:
 * - YAML configuration files (disclaude.config.yaml)
 *
 * All configuration is read from the config file.
 */
import path from 'path';
import { existsSync, readFileSync } from 'fs';
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
  AgentPresets,
  DebugConfig,
  SessionTimeoutConfig,
} from './types.js';
import { resolveAgentPreset } from './agent-presets.js';
import { resolveConfiguredAgents, validateResolvedAgent } from './resolved-agents.js';
import { resolveCodexModelSetting, resolveCodexReasoningEffort } from './codex-settings.js';
import { channelCredentialErrors, resolveChannelCredential } from './channel-credentials.js';
import { type BaseAgentConfig, type AgentRuntimeContext, setRuntimeContext } from '../agents/types.js';

// Re-export sub-modules
export * from './types.js';
export * from './loader.js';
export * from './agent-presets.js';
export * from './resolved-agents.js';
export * from './channel-credentials.js';

export { loadRuntimeEnv, setRuntimeEnv, deleteRuntimeEnv } from './runtime-env.js';

const logger = createLogger('Config');

// Load configuration file (use preloaded config if available from CLI --config)
const fileConfig = getPreloadedConfig() || loadConfigFile();
const fileConfigOnly = getConfigFromFile(fileConfig);
// Register private variable names for subprocess filtering without resolving them on imports.
channelCredentialErrors(fileConfigOnly);
const resolvedAgents = resolveConfiguredAgents(fileConfigOnly);
const agentPresets = resolvedAgents.ok ? resolvedAgents.presets : {};
const defaultSelection = Object.keys(agentPresets).length ? resolveAgentPreset(agentPresets) : undefined;
const defaultAgent = defaultSelection?.ok ? defaultSelection.preset : undefined;
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
  const source = getPreloadedConfig() ?? fileConfigOnly;
  const errors = channelCredentialErrors(source);
  if (errors.length) {throw new Error(errors.join('; '));}
  // Prefer preloaded config (set via --config CLI flag) over the default
  // config loaded at module import time. This ensures applyGlobalEnv()
  // reads from the correct config file when --config is used.
  const preloaded = getPreloadedConfig();
  const env =
    preloaded && validateConfig(preloaded)
      ? getConfigFromFile(preloaded).env || {}
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
      'Applied global env vars to process.env'
    );
  } else if (skipped > 0) {
    logger.debug(
      { skipped, keys: Object.keys(env) },
      'Skipped global env vars (already set in process.env)'
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
  private static readonly WORKSPACE_DIR = Config.resolveWorkspaceDir(
    Config.RAW_WORKSPACE_DIR,
    Config.RESOLVED_VIA_CONFIG
  );

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
          'workspace.dir resolved inside git repo; falling back to cwd-relative path. ' +
            'Consider setting DISCLAUDE_WORKSPACE_DIR env var or using an absolute path.'
        );
        return cwdRelativeDir;
      }
    }

    return configRelativeDir;
  }

  // Feishu/Lark configuration (from config file)
  static get FEISHU_APP_ID(): string {return resolveChannelCredential(fileConfigOnly, 'feishu', 'appId');}
  static get FEISHU_APP_SECRET(): string {return resolveChannelCredential(fileConfigOnly, 'feishu', 'appSecret');}
  static readonly FEISHU_CLI_CHAT_ID = fileConfigOnly.channels?.feishu?.cliChatId || '';
  // Issue #4400 / #4208: gray-rollout flag for native streaming replies.
  // Plumbed through to FeishuChannelConfig.streamingCard in resolveChannelConfigs.
  // Issue #4510 (part 2): the 'p2p' scope enum was removed — streaming is
  // narrowed to single chats by the ChatAgent gate. A leftover non-boolean
  // value (e.g. `streamingCard: 'p2p'` from the part-1 rollout) would
  // otherwise silently disable streaming, so warn and treat it as off.
  static readonly FEISHU_STREAMING_CARD = (() => {
    const raw = fileConfigOnly.channels?.feishu?.streamingCard;
    if (raw !== undefined && typeof raw !== 'boolean') {
      logger.warn(
        { streamingCard: raw },
        "channels.feishu.streamingCard must be a boolean — the 'p2p' scope was removed in #4510 part 2 " +
          '(p2p-first narrowing is built-in). Treating this value as false.'
      );
      return false;
    }
    return raw ?? false;
  })();

  // DSH composition and home; API connections come from the bound LLM.
  static readonly DSH_MODE = defaultAgent?.mode ?? 'standard';
  static readonly DSH_HOME = defaultAgent?.dshHome || process.env.DSH_HOME || '';
  static readonly AGENT_BACKEND = defaultAgent?.agentBackend;

  private static readonly CODEX_MODEL_SETTING = resolveCodexModelSetting({
    environment: process.env.CODEX_MODEL?.trim() || fileConfigOnly.env?.CODEX_MODEL,
    configured: defaultAgent?.agentBackend === 'codex' ? defaultAgent.model : undefined,
  });
  static readonly CODEX_MODEL = this.CODEX_MODEL_SETTING.value ?? '';
  static readonly CODEX_MODEL_SOURCE = this.CODEX_MODEL_SETTING.source;
  private static readonly CODEX_REASONING_EFFORT_SETTING = resolveCodexReasoningEffort({
    environment: process.env.CODEX_REASONING_EFFORT?.trim() || fileConfigOnly.env?.CODEX_REASONING_EFFORT,
    configured: defaultAgent?.reasoningEffort,
  });
  static readonly CODEX_REASONING_EFFORT = this.CODEX_REASONING_EFFORT_SETTING.value;
  static readonly CODEX_REASONING_EFFORT_SOURCE = this.CODEX_REASONING_EFFORT_SETTING.source;
  static readonly CLAUDE_MODEL = this.AGENT_BACKEND === 'codex' ? this.CODEX_MODEL : defaultAgent?.model ?? '';
  static readonly CODEX_SANDBOX = defaultAgent?.codexSandbox;
  static readonly FULL_ACCESS = defaultAgent?.fullAccess;
  static readonly CODEX_NETWORK_ACCESS = defaultAgent?.codexNetworkAccess;
  static readonly CODEX_MAX_ACTIVE_SESSIONS = defaultAgent?.codex?.maxActiveSessions;
  static readonly CODEX_MAX_CONCURRENT_RUNS = defaultAgent?.codex?.maxConcurrentRuns;
  static readonly CODEX_TRANSPORT = defaultAgent?.codex?.transport ?? 'exec';

  // Logging configuration
  static readonly LOG_LEVEL = fileConfigOnly.logging?.level || 'info';
  static readonly LOG_FILE = fileConfigOnly.logging?.file;
  static readonly LOG_PRETTY = fileConfigOnly.logging?.pretty ?? true;
  static readonly LOG_ROTATE = fileConfigOnly.logging?.rotate ?? false;
  static readonly SDK_DEBUG = fileConfigOnly.logging?.sdkDebug ?? true;

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
      // Prebuilt Git distributions preserve packages/core/dist but keep shared
      // resources at the release root. Do not depend on the caller's cwd.
      let ancestor = moduleDir;
      while (path.dirname(ancestor) !== ancestor) {
        if (existsSync(path.join(ancestor, 'release-source.json')) &&
            existsSync(path.join(ancestor, dirName))) {
          return path.join(ancestor, dirName);
        }
        // Both npm's bundled core and a source checkout keep shared resources
        // at the enclosing disclaude package, independent of execution cwd.
        if (existsSync(path.join(ancestor, 'bin', 'disclaude.js')) &&
            existsSync(path.join(ancestor, dirName))) {
          try {
            const manifest = JSON.parse(readFileSync(path.join(ancestor, 'package.json'), 'utf8'));
            if (manifest.name === 'disclaude') {return path.join(ancestor, dirName);}
          } catch {
            // An unrelated or malformed ancestor is not an installation root.
          }
        }
        ancestor = path.dirname(ancestor);
      }
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
    if (preloaded) {
      return getConfigFromFile(preloaded);
    }
    return fileConfigOnly;
  }

  /** Resolved presets shared by the session pool, preflight and construction. */
  static getAgentPresets(): AgentPresets | undefined {
    const resolved = resolveConfiguredAgents(this.getRawConfig());
    if (!resolved.ok) { throw new Error(resolved.errors.join('\n')); }
    if (!Object.keys(resolved.presets).length) { return undefined; }
    const selected = resolveAgentPreset(resolved.presets);
    if (selected.ok && selected.preset.agentBackend === 'codex') {
      resolved.presets[selected.name] = { ...selected.preset, model: this.CODEX_MODEL,
        reasoningEffort: this.CODEX_REASONING_EFFORT };
    }
    return resolved.presets;
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
      logger.debug(
        { workspaceDir: overrideDir, source: 'environment-variable' },
        'Using workspace directory'
      );
      return overrideDir;
    }

    const workspaceDir = this.WORKSPACE_DIR;
    logger.debug(
      { workspaceDir, source: this.CONFIG_LOADED ? 'config-file' : 'default' },
      'Using workspace directory'
    );
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
   * Get the builtins root directory — the common parent of the builtin
   * `skills/` and `agents/` directories.
   *
   * Used as the local-plugin path so the SDK loads builtin skills + agents
   * in place (Issue #4224), replacing the copy-on-start materialization.
   *
   * @returns Absolute path to the builtins root directory
   */
  static getBuiltinsDir(): string {
    // getBuiltinDir('skills') = <builtins-root>/skills, so its dirname is the
    // builtins root. Reuses getBuiltinDir's bundling/cwd-fallback logic.
    return path.dirname(this.getBuiltinDir('skills'));
  }

  /** Get the validated default runtime and its bound LLM connection. */
  static getAgentConfig(): BaseAgentConfig {
    if (!resolvedAgents.ok) { throw new Error(resolvedAgents.errors.join('\n')); }
    const selected = resolveAgentPreset(this.getAgentPresets() ?? {});
    if (!selected.ok) { throw new Error(selected.error); }
    const error = validateResolvedAgent(selected.preset);
    if (error) { throw new Error(error); }
    const {preset} = selected;
    return {
      apiKey: preset.apiKey, model: preset.model,
      apiProtocol: preset.apiProtocol, apiBaseUrl: preset.apiBaseUrl,
      agentBackend: preset.agentBackend, permissionMode: preset.permissionMode,
      env: preset.env, credentialEnvKeys: preset.credentialEnvKeys,
      llm: preset.llm, reasoningEffort: preset.reasoningEffort,
      maxConcurrentSessions: preset.maxConcurrentSessions,
      settings: preset,
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
    return defaultAgent?.enableAgentTeams ?? false;
  }

  /** Explicit policy; absence leaves Claude's SDK-owned policy unchanged. */
  static getAutoCompactWindow(): number | 'auto' | undefined {
    return defaultAgent?.autoCompactWindow;
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
  static getSessionTimeoutConfig(): (SessionTimeoutConfig & { enabled: boolean }) | null {
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
    return defaultAgent?.sdkTimeoutMs ?? 300_000;
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
  overrides?: Partial<AgentRuntimeContext>
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
