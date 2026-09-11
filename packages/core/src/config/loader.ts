/**
 * Configuration file loader for Disclaude core.
 *
 * This module handles loading and parsing YAML configuration files.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
import type {
  DisclaudeConfig,
  LoadedConfig,
  ConfigFileInfo,
  ConfigValidationError,
} from './types.js';
import { resolveAgentPreset, validateAgentPresets } from './agent-presets.js';

const logger = createLogger('ConfigLoader');

/**
 * Config file names to search for, in priority order.
 */
const CONFIG_FILE_NAMES = ['disclaude.config.yaml', 'disclaude.config.yml'] as const;

/**
 * Set by executable bootstraps before importing @disclaude/core. This avoids
 * the Config static fields observing a default config before CLI --config is
 * parsed (Issue #4654).
 */
export const EXPLICIT_CONFIG_PATH_ENV = 'DISCLAUDE_CONFIG_PATH';

/**
 * Search paths for configuration files.
 */
const SEARCH_PATHS = [
  process.env.HOME ? resolve(process.env.HOME, '.disclaude') : '',
  // Legacy migration fallbacks. New installs should use ~/.disclaude or --config.
  process.cwd(),
  // If workspace directory is configured, also search parent directory
  process.env.WORKSPACE_DIR ? resolve(process.env.WORKSPACE_DIR, '..') : '',
  // Import meta URL directory (for bundled executables)
  import.meta.url ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : '',
  import.meta.url ? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') : '',
].filter(Boolean) as string[];

/**
 * Find configuration file by searching standard locations.
 *
 * @returns ConfigFileInfo with path and existence status
 */
export function findConfigFile(): ConfigFileInfo {
  const explicitPath = process.env[EXPLICIT_CONFIG_PATH_ENV];
  if (explicitPath) {
    const filePath = resolve(explicitPath);
    return { path: filePath, exists: existsSync(filePath) };
  }

  for (const searchPath of SEARCH_PATHS) {
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = resolve(searchPath, fileName);
      if (existsSync(filePath)) {
        if (searchPath !== SEARCH_PATHS[0]) {
          logger.warn(
            { filePath, preferredDirectory: SEARCH_PATHS[0] },
            'Using legacy config location; move it to ~/.disclaude/disclaude.config.yaml'
          );
        }
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
  const { _source, _fromFile, ...restConfig } = fileConfig;
  return restConfig;
}

/**
 * Pre-loaded configuration storage.
 * Set via CLI --config argument before the Config class is loaded.
 */
let preloadedConfig: LoadedConfig | null = null;

/**
 * Set pre-loaded configuration via CLI --config argument.
 * This allows the configuration to be set before the Config class is loaded.
 *
 * @param config - Pre-loaded configuration
 */
export function setLoadedConfig(config: LoadedConfig | null): void {
  preloadedConfig = config;
  if (config) {
    logger.debug({ source: config._source }, 'Pre-loaded configuration set');
  }
}

/**
 * Get pre-loaded configuration if set.
 *
 * @returns Pre-loaded configuration or null
 */
export function getPreloadedConfig(): LoadedConfig | null {
  return preloadedConfig;
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

  // Reject obsolete role settings rather than silently treating them as active.
  const obsoleteRoleKeys = ['primaryNode', 'primary', 'worker', 'nodeType', 'nodeId', 'nodeName', 'enableLocalExec'];
  const obsoleteKey = obsoleteRoleKeys.find((key) => Object.hasOwn(config, key));
  if (obsoleteKey) {
    logger.error({ key: obsoleteKey }, 'Execution-node role configuration has been removed. Use disclaude start with agent/channels configuration; see docs/migrations/0.5.1-service.md.');
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

  if (
    config.agent?.autoCompactWindow !== undefined &&
    (!Number.isInteger(config.agent.autoCompactWindow) || config.agent.autoCompactWindow < 0)
  ) {
    logger.error('agent.autoCompactWindow must be a non-negative integer');
    return false;
  }

  // S01: validate named backend/model presets without changing the legacy
  // single-agent fallback path. Runtime selection is layered on afterwards.
  if (config.agents !== undefined) {
    const result = validateAgentPresets(config.agents);
    if (!result.ok) {
      logger.error({ errors: result.errors }, 'Invalid named agent presets');
      return false;
    }
  }

  // Codex authenticates and selects models through the ChatGPT subscription,
  // not through disclaude's GLM/Anthropic API configuration. Keep accepting
  // legacy provider fields for migration, but make the ignored settings
  // explicit so a deployment cannot silently use a different model backend.
  if (config.agent?.agentBackend === 'codex') {
    if (config.agent.provider || config.glm?.apiKey || config.glm?.model) {
      logger.warn(
        {
          provider: config.agent.provider,
          hasGlmApiKey: Boolean(config.glm?.apiKey),
          hasGlmModel: Boolean(config.glm?.model),
        },
        'agentBackend: codex uses the ChatGPT OAuth session; agent.provider and glm settings are ignored'
      );
    }
    if (config.agent.model && !isCodexModel(config.agent.model)) {
      logger.error(
        `agent.model must be a Codex/ChatGPT model (expected gpt-5.x or newer, got "${config.agent.model}")`
      );
      return false;
    }
  }

  // Issue #4388: validate agent.agentBackend (agent SDK runtime selection).
  // 'codex' added in #4629 (S1 of #4627).
  if (config.agent?.agentBackend !== undefined) {
    const allowed = ['claude', 'pi', 'codex', 'deepseek'] as const;
    if (!allowed.includes(config.agent.agentBackend)) {
      logger.error(
        `agent.agentBackend must be one of: ${allowed.join(', ')} (got "${config.agent.agentBackend}"). ` +
          'It selects the agent runtime (claude-code, pi.dev, Codex CLI, or DeepSeek harness), separate from the model-layer provider.'
      );
      return false;
    }
  }

  // Issue #4631 (S4 of #4627): validate agent.codexSandbox — the explicit
  // codex exec sandbox override. Same UX as the agentBackend check above.
  if (config.agent?.codexSandbox !== undefined) {
    const allowedSandbox = ['read-only', 'workspace-write', 'danger-full-access'] as const;
    if (!allowedSandbox.includes(config.agent.codexSandbox)) {
      logger.error(
        `agent.codexSandbox must be one of: ${allowedSandbox.join(', ')} (got "${config.agent.codexSandbox}"). ` +
          'It is the codex exec sandbox level, only meaningful with agentBackend: codex.'
      );
      return false;
    }
  }

  if (
    config.agent?.fullAccess !== undefined &&
    typeof config.agent.fullAccess !== 'boolean'
  ) {
    logger.error(
      `agent.fullAccess must be a boolean (got ${String(config.agent.fullAccess)}). ` +
        'Set it to true only when the unrestricted Codex sandbox is explicitly intended.'
    );
    return false;
  }
  if (
    config.agent?.fullAccess === true &&
    config.agent.codexSandbox !== undefined &&
    config.agent.codexSandbox !== 'danger-full-access'
  ) {
    logger.error(
      'agent.fullAccess: true conflicts with agent.codexSandbox: ' +
        `"${config.agent.codexSandbox}". Remove codexSandbox or set it to "danger-full-access".`
    );
    return false;
  }

  if (
    config.agent?.codexNetworkAccess !== undefined &&
    typeof config.agent.codexNetworkAccess !== 'boolean'
  ) {
    logger.error(
      `agent.codexNetworkAccess must be a boolean (got ${String(config.agent.codexNetworkAccess)}). ` +
        'It controls outbound network access for Codex workspace-write runs.'
    );
    return false;
  }

  // Issue #4634 (S7 of #4627): validate agent.codex governance caps —
  // non-positive values are rejected at load time (fail closed).
  if (config.agent?.codex !== undefined) {
    const { maxActiveSessions, maxConcurrentRuns, execTimeoutMs } = config.agent.codex;
    if (
      config.agent.codex.transport !== undefined &&
      config.agent.codex.transport !== 'exec' &&
      config.agent.codex.transport !== 'app-server'
    ) {
      logger.error(
        `agent.codex.transport must be "exec" or "app-server" (got ${String(config.agent.codex.transport)})`
      );
      return false;
    }
    for (const [name, value] of [
      ['maxActiveSessions', maxActiveSessions],
      ['maxConcurrentRuns', maxConcurrentRuns],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        logger.error(
          `agent.codex.${name} must be a positive number (got ${value}). ` +
            'It bounds concurrent codex sessions/runs per process.'
        );
        return false;
      }
    }
    if (execTimeoutMs !== undefined && (!Number.isFinite(execTimeoutMs) || execTimeoutMs < 0)) {
      logger.error(
        `agent.codex.execTimeoutMs must be a non-negative number (got ${execTimeoutMs}). ` +
          'Use 0 to disable the Codex runner wall-clock timeout.'
      );
      return false;
    }
  }

  // Validate logging config if present
  if (config.logging?.level && typeof config.logging.level !== 'string') {
    logger.error('logging.level must be a string');
    return false;
  }

  return true;
}

/** Return whether a model identifier is supported by the Codex CLI backend. */
export function isCodexModel(model: string): boolean {
  // `gpt-5` itself is an API model name and is explicitly rejected by the
  // Codex ChatGPT route; Codex model aliases carry a suffix (for example
  // `gpt-5.1-codex`).
  return /^gpt-(?:[5-9]|[1-9]\d+)(?:[.-].+)/i.test(model.trim());
}

/**
 * Validate required configuration fields.
 * Called early to provide clear error messages about missing required fields.
 *
 * @param config - Configuration to validate
 * @returns validation result with errors if any
 */
export function validateRequiredConfig(config: DisclaudeConfig): {
  valid: boolean;
  errors: ConfigValidationError[];
} {
  const errors: ConfigValidationError[] = [];
  const selected = config.agents ? resolveAgentPreset(config.agents) : undefined;
  const preset = selected?.ok ? selected.preset : undefined;
  const backend = preset?.agentBackend ?? config.agent?.agentBackend;
  const provider = preset?.provider ?? config.agent?.provider ?? (config.anthropic ? 'anthropic' : undefined);
  const model = preset?.model || config.agent?.model || config.anthropic?.model;
  if (backend === 'codex') {
    return { valid: true, errors };
  }
  // A canonical API service block is independent of the model vendor.
  if (config.anthropic && provider !== 'glm') {
    if (!(config.anthropic.apiKey ?? process.env.ANTHROPIC_API_KEY)) {
      errors.push({ field: 'anthropic.apiKey', message: 'anthropic.apiKey or ANTHROPIC_API_KEY is required' });
    }
    if (!model) {
      errors.push({ field: 'anthropic.model', message: 'anthropic.model or agent.model is required' });
    }
    return { valid: errors.length === 0, errors };
  }

  const explicitlyUsesGlm = provider === 'glm';

  if (explicitlyUsesGlm && !config.glm?.apiBaseUrl) {
    errors.push({
      field: 'glm.apiBaseUrl',
      message:
        'glm.apiBaseUrl is required for the selected GLM provider; configure a supported Anthropic-compatible proxy endpoint',
    });
  }

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
  if (process.env.ANTHROPIC_API_KEY && !model) {
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
