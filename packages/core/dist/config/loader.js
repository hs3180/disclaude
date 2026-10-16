/**
 * Configuration file loader for Disclaude core.
 *
 * This module handles loading and parsing YAML configuration files.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
import { resolveAgentPreset } from './agent-presets.js';
import { resolveConfiguredAgents, validateResolvedAgent } from './resolved-agents.js';
import { isCodexReasoningEffort } from './codex-settings.js';
import { channelCredentialErrors } from './channel-credentials.js';
const logger = createLogger('ConfigLoader');
// This discovery entry is also used before Config statics initialize in the CLI.
import { discoverConfigFile, EXPLICIT_CONFIG_PATH_ENV } from './discovery.js';
export { EXPLICIT_CONFIG_PATH_ENV } from './discovery.js';
export function findConfigFile() {
    const result = discoverConfigFile();
    if (result.exists && !process.env[EXPLICIT_CONFIG_PATH_ENV]
        && dirname(result.path) !== resolve(process.env.HOME || '', '.disclaude')) {
        logger.warn({ filePath: result.path }, 'Using legacy config location; move it to ~/.disclaude/disclaude.config.yaml');
    }
    return result;
}
/**
 * Load and parse the configuration file.
 *
 * @param filePath - Path to the configuration file (optional, will search if not provided)
 * @returns LoadedConfig object
 */
export function loadConfigFile(filePath) {
    const fileInfo = filePath
        ? { path: resolve(filePath), exists: existsSync(resolve(filePath)) }
        : findConfigFile();
    if (!fileInfo.exists) {
        return { _fromFile: false };
    }
    try {
        const content = readFileSync(fileInfo.path, 'utf-8');
        const parsed = yaml.load(content);
        if (!parsed || typeof parsed !== 'object') {
            logger.warn({ path: fileInfo.path }, 'Configuration file is empty or invalid');
            return { _fromFile: false };
        }
        logger.info({ path: fileInfo.path, keys: Object.keys(parsed) }, 'Configuration file loaded successfully');
        return {
            ...parsed,
            _source: fileInfo.path,
            _fromFile: true,
        };
    }
    catch (error) {
        // YAML parser errors can include literal source lines containing old secrets.
        logger.warn({ path: fileInfo.path, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Failed to parse configuration file');
        return { _fromFile: false };
    }
}
/**
 * Get configuration from file only (no environment variable merging).
 *
 * Configuration is read directly from disclaude.config.yaml.
 * API credentials are resolved through environment variable references.
 *
 * @param fileConfig - Configuration loaded from file
 * @returns Configuration object from file
 */
export function getConfigFromFile(fileConfig) {
    const { _source, _fromFile, ...restConfig } = fileConfig;
    return restConfig;
}
/**
 * Pre-loaded configuration storage.
 * Set via CLI --config argument before the Config class is loaded.
 */
let preloadedConfig = null;
/**
 * Set pre-loaded configuration via CLI --config argument.
 * This allows the configuration to be set before the Config class is loaded.
 *
 * @param config - Pre-loaded configuration
 */
export function setLoadedConfig(config) {
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
export function getPreloadedConfig() {
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
export function validateConfig(config) {
    // Basic validation - ensure config is an object
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        logger.error('Configuration must be an object');
        return false;
    }
    // Reject obsolete role settings rather than silently treating them as active.
    const channelErrors = channelCredentialErrors(config);
    if (channelErrors.length) {
        logger.error({ errors: channelErrors }, 'Invalid channel credential configuration');
        return false;
    }
    const obsoleteRoleKeys = ['primaryNode', 'primary', 'worker', 'nodeType', 'nodeId', 'nodeName', 'enableLocalExec', 'transport', 'runMode'];
    const obsoleteKey = obsoleteRoleKeys.find((key) => Object.hasOwn(config, key));
    if (obsoleteKey) {
        logger.error({ key: obsoleteKey }, 'Execution-node role configuration has been removed. Use disclaude start with agents/llms/channels configuration and remove obsolete role settings.');
        return false;
    }
    if (config.workspace?.dir !== undefined && typeof config.workspace.dir !== 'string') {
        logger.error('workspace.dir must be a string');
        return false;
    }
    const resolved = resolveConfiguredAgents(config);
    if (!resolved.ok) {
        logger.error({ errors: resolved.errors }, 'Invalid agent configuration');
        return false;
    }
    const selected = Object.keys(resolved.presets).length ? resolveAgentPreset(resolved.presets) : undefined;
    if (selected?.ok && selected.preset.agentBackend === 'codex') {
        const model = process.env.CODEX_MODEL?.trim() || config.env?.CODEX_MODEL;
        const effort = process.env.CODEX_REASONING_EFFORT?.trim() || config.env?.CODEX_REASONING_EFFORT;
        if (model && !isCodexModel(model)) {
            logger.error('CODEX_MODEL is invalid');
            return false;
        }
        if (effort && !isCodexReasoningEffort(effort)) {
            logger.error('CODEX_REASONING_EFFORT is invalid');
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
/** Check identifier shape; Codex validates availability for the signed-in account. */
export function isCodexModel(model) {
    return /^gpt-\d+(?:[.-].+)/i.test(model.trim());
}
/**
 * Validate required configuration fields.
 * Called early to provide clear error messages about missing required fields.
 *
 * @param config - Configuration to validate
 * @returns validation result with errors if any
 */
export function validateRequiredConfig(config) {
    const resolved = resolveConfiguredAgents(config);
    if (!resolved.ok) {
        return { valid: false, errors: resolved.errors.map(message => ({ field: 'agents/llms', message })) };
    }
    const selected = resolveAgentPreset(resolved.presets);
    const error = selected.ok ? validateResolvedAgent(selected.preset) : selected.error;
    return { valid: !error, errors: error ? [{ field: 'agents/llms', message: error }] : [] };
}
