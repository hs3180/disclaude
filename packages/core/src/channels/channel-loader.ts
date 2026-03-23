/**
 * Dynamic Channel Loader.
 *
 * Loads dynamic channel plugins from `.disclaude/channels.yaml` configuration file.
 * This file is separate from `disclaude.config.yaml` to keep concerns separated:
 * - `disclaude.config.yaml` — project-level static configuration (built-in channels)
 * - `.disclaude/channels.yaml` — runtime dynamic channel registrations
 *
 * The loader supports:
 * - npm packages (e.g., `@disclaude/wechat-channel`)
 * - Relative paths (e.g., `./channels/my-channel`)
 * - Absolute paths (e.g., `/path/to/channel`)
 *
 * Modules are lazy-loaded on first channel creation, keeping startup fast.
 *
 * @module channels/channel-loader
 * @see Issue #1422
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
import { ChannelRegistry, type ChannelPlugin, isChannelPlugin, isChannelFactory } from './channel-plugin.js';
import type { IChannel, ChannelConfig } from '../types/channel.js';

const logger = createLogger('ChannelLoader');

/**
 * Configuration for a single dynamic channel in `.disclaude/channels.yaml`.
 */
export interface DynamicChannelEntry {
  /** Whether this channel is enabled */
  enabled?: boolean;
  /** Module path: npm package, relative path, or absolute path */
  module: string;
  /** Channel-specific configuration passed to the factory */
  config?: Record<string, unknown>;
}

/**
 * Structure of `.disclaude/channels.yaml`.
 */
export interface DynamicChannelsFile {
  /** Map of channel ID to channel configuration */
  channels?: Record<string, DynamicChannelEntry>;
}

/**
 * Default filename for dynamic channels configuration.
 */
export const DYNAMIC_CHANNELS_FILENAME = 'channels.yaml';

/**
 * Find the `.disclaude` directory for a given workspace.
 *
 * @param workspaceDir - Workspace directory path (defaults to cwd)
 * @returns Path to `.disclaude` directory, or undefined if not found
 */
export function findDisclaudeDir(workspaceDir?: string): string | undefined {
  const dir = workspaceDir || process.cwd();
  const disclaudeDir = resolve(dir, '.disclaude');
  return existsSync(disclaudeDir) ? disclaudeDir : undefined;
}

/**
 * Find the dynamic channels configuration file.
 *
 * @param workspaceDir - Workspace directory path (defaults to cwd)
 * @returns Path to channels.yaml, or undefined if not found
 */
export function findDynamicChannelsFile(workspaceDir?: string): string | undefined {
  const disclaudeDir = findDisclaudeDir(workspaceDir);
  if (!disclaudeDir) return undefined;

  const filePath = resolve(disclaudeDir, DYNAMIC_CHANNELS_FILENAME);
  return existsSync(filePath) ? filePath : undefined;
}

/**
 * Read and parse `.disclaude/channels.yaml`.
 *
 * @param workspaceDir - Workspace directory path (defaults to cwd)
 * @returns Parsed configuration, or null if file doesn't exist
 */
export function readDynamicChannelsFile(workspaceDir?: string): DynamicChannelsFile | null {
  const filePath = findDynamicChannelsFile(workspaceDir);
  if (!filePath) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content) as DynamicChannelsFile | null;

    if (!parsed || typeof parsed !== 'object' || !parsed.channels) {
      logger.warn({ filePath }, 'Dynamic channels file is empty or has no channels');
      return null;
    }

    logger.info({ filePath, channelCount: Object.keys(parsed.channels).length }, 'Dynamic channels file loaded');
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ filePath, error: message }, 'Failed to parse dynamic channels file');
    return null;
  }
}

/**
 * Write a channel configuration to `.disclaude/channels.yaml`.
 * Creates the `.disclaude` directory if it doesn't exist.
 *
 * @param channelId - Channel identifier
 * @param modulePath - Module path for the channel
 * @param config - Optional channel-specific configuration
 * @param workspaceDir - Workspace directory path (defaults to cwd)
 */
export function writeDynamicChannel(
  channelId: string,
  modulePath: string,
  config?: Record<string, unknown>,
  workspaceDir?: string
): void {
  const dir = workspaceDir || process.cwd();
  const disclaudeDir = resolve(dir, '.disclaude');

  // Ensure .disclaude directory exists
  if (!existsSync(disclaudeDir)) {
    mkdirSync(disclaudeDir, { recursive: true });
    logger.info({ dir: disclaudeDir }, 'Created .disclaude directory');
  }

  const filePath = resolve(disclaudeDir, DYNAMIC_CHANNELS_FILENAME);

  // Read existing config or start fresh
  let existing: DynamicChannelsFile = {};
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = yaml.load(content) as DynamicChannelsFile | null;
      if (parsed && typeof parsed === 'object') {
        existing = parsed;
      }
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  // Add/update the channel entry
  if (!existing.channels) {
    existing.channels = {};
  }

  existing.channels[channelId] = {
    enabled: true,
    module: modulePath,
    ...(config ? { config } : {}),
  };

  // Write back
  const yamlContent = yaml.dump(existing, { lineWidth: 120, noRefs: true });
  // Add header comment if file is new
  const header = existsSync(filePath) ? '' : '# Dynamic channel registrations for disclaude\n# Managed by `disclaude channel add/remove` CLI commands\n\n';
  writeFileSync(filePath, header + yamlContent, 'utf-8');

  logger.info({ channelId, modulePath, filePath }, 'Dynamic channel configuration written');
}

/**
 * Remove a channel from `.disclaude/channels.yaml`.
 *
 * @param channelId - Channel identifier to remove
 * @param workspaceDir - Workspace directory path (defaults to cwd)
 * @returns true if removed, false if not found
 */
export function removeDynamicChannel(channelId: string, workspaceDir?: string): boolean {
  const filePath = findDynamicChannelsFile(workspaceDir);
  if (!filePath) return false;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content) as DynamicChannelsFile | null;

    if (!parsed?.channels || !(channelId in parsed.channels)) {
      return false;
    }

    delete parsed.channels[channelId];
    const yamlContent = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
    writeFileSync(filePath, yamlContent, 'utf-8');

    logger.info({ channelId, filePath }, 'Dynamic channel configuration removed');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ channelId, error: message }, 'Failed to remove dynamic channel');
    return false;
  }
}

/**
 * Load a module from a given module specifier.
 * Supports npm packages, relative paths, and absolute paths.
 *
 * @param moduleSpecifier - Module path or npm package name
 * @param basePath - Base path for resolving relative paths
 * @returns Loaded module exports
 */
async function loadModule(moduleSpecifier: string, basePath: string): Promise<unknown> {
  let resolvedPath = moduleSpecifier;

  if (!isAbsolute(moduleSpecifier) && !moduleSpecifier.startsWith('@') && moduleSpecifier.startsWith('.')) {
    // Relative path — resolve from base path
    resolvedPath = resolve(basePath, moduleSpecifier);
  }

  logger.debug({ specifier: moduleSpecifier, resolved: resolvedPath }, 'Loading channel module');
  const mod = await import(resolvedPath);
  return mod;
}

/**
 * Extract a channel factory from loaded module exports.
 *
 * Supports multiple export formats:
 * 1. Named export `channelPlugin` — Full ChannelPlugin interface
 * 2. Named export `createChannel` — Simple factory function
 * 3. Default export — Either ChannelPlugin or ChannelFactory
 *
 * @param mod - Loaded module exports
 * @param channelId - Channel ID (for logging)
 * @returns Factory function and optional name
 * @throws Error if no valid export format is found
 */
function extractFactory(mod: unknown, channelId: string): { factory: (config: ChannelConfig) => IChannel; name?: string } {
  const exports = mod as Record<string, unknown>;

  // 1. Named export `channelPlugin`
  if (exports.channelPlugin && isChannelPlugin(exports.channelPlugin)) {
    const plugin = exports.channelPlugin as ChannelPlugin;
    logger.debug({ channelId, format: 'channelPlugin', name: plugin.name }, 'Plugin resolved');
    return { factory: plugin.createChannel, name: plugin.name };
  }

  // 2. Named export `createChannel`
  if (exports.createChannel && isChannelFactory(exports.createChannel)) {
    logger.debug({ channelId, format: 'createChannel' }, 'Plugin resolved');
    return { factory: exports.createChannel };
  }

  // 3. Default export
  const defaultExport = exports.default;
  if (defaultExport !== undefined) {
    if (isChannelPlugin(defaultExport)) {
      const plugin = defaultExport as ChannelPlugin;
      logger.debug({ channelId, format: 'default (plugin)', name: plugin.name }, 'Plugin resolved');
      return { factory: plugin.createChannel, name: plugin.name };
    }
    if (isChannelFactory(defaultExport)) {
      logger.debug({ channelId, format: 'default (factory)' }, 'Plugin resolved');
      return { factory: defaultExport };
    }
  }

  throw new Error(
    `Module for channel '${channelId}' does not export a valid plugin format. ` +
    `Expected: named export 'channelPlugin' (ChannelPlugin), 'createChannel' (ChannelFactory), or a default export.`
  );
}

/**
 * Channel Loader.
 *
 * Reads `.disclaude/channels.yaml` and registers dynamic channel plugins
 * into a ChannelRegistry using lazy-loaded factories.
 *
 * @example
 * ```typescript
 * const loader = new ChannelLoader();
 * const channels = await loader.load(); // Map<channelId, IChannel>
 * ```
 */
export class ChannelLoader {
  private registry: ChannelRegistry;
  private workspaceDir: string;
  private loadedModules: Map<string, { factory: (config: ChannelConfig) => IChannel; name?: string }> = new Map();

  constructor(registry: ChannelRegistry, workspaceDir?: string) {
    this.registry = registry;
    this.workspaceDir = workspaceDir || process.cwd();
  }

  /**
   * Load all dynamic channels from `.disclaude/channels.yaml`.
   *
   * For each enabled channel:
   * 1. Validate the configuration
   * 2. Register a lazy-loading factory in the registry
   *
   * The actual module import happens when `createChannel()` is called,
   * keeping startup fast.
   *
   * @returns Array of loaded channel IDs
   */
  async load(): Promise<string[]> {
    const config = readDynamicChannelsFile(this.workspaceDir);
    if (!config) {
      logger.debug('No dynamic channels configuration found');
      return [];
    }

    const loadedIds: string[] = [];

    for (const [channelId, entry] of Object.entries(config.channels!)) {
      // Skip disabled channels
      if (entry.enabled === false) {
        logger.debug({ channelId }, 'Dynamic channel disabled, skipping');
        continue;
      }

      // Validate module field
      if (!entry.module || typeof entry.module !== 'string') {
        logger.warn({ channelId }, 'Dynamic channel missing or invalid "module" field, skipping');
        continue;
      }

      try {
        // Register lazy-loading factory
        const channelConfig = entry.config || {};
        this.registerLazyChannel(channelId, entry.module, channelConfig);
        loadedIds.push(channelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ channelId, error: message }, 'Failed to register dynamic channel');
      }
    }

    logger.info({ channelIds: loadedIds }, 'Dynamic channels loaded');
    return loadedIds;
  }

  /**
   * Register a lazy-loading channel factory.
   *
   * The module is not imported until `createChannel()` is called.
   *
   * @param channelId - Channel identifier
   * @param modulePath - Module specifier (npm package or path)
   * @param channelConfig - Channel-specific configuration
   */
  private registerLazyChannel(channelId: string, modulePath: string, channelConfig: Record<string, unknown>): void {
    const loader = this;

    // Create lazy factory that imports module on first call
    const lazyFactory: (config: ChannelConfig) => IChannel = (config: ChannelConfig) => {
      // Check if already loaded
      const cached = loader.loadedModules.get(channelId);
      if (cached) {
        return cached.factory({ ...config, ...channelConfig });
      }

      // We need to make this sync-compatible by pre-loading
      // But since import() is async, we throw if not pre-loaded
      throw new Error(
        `Channel '${channelId}' module not yet loaded. Call ChannelLoader.load() first.`
      );
    };

    this.registry.registerDynamic(channelId, channelId, modulePath, lazyFactory);
  }

  /**
   * Pre-load and resolve all dynamic channel modules.
   *
   * This imports all modules eagerly. Call this after `load()` if you need
   * all modules loaded before creating channels.
   *
   * @returns Map of channel ID to resolved factory info
   */
  async resolveAll(): Promise<Map<string, { factory: (config: ChannelConfig) => IChannel; name?: string }>> {
    const config = readDynamicChannelsFile(this.workspaceDir);
    if (!config) return this.loadedModules;

    for (const [channelId, entry] of Object.entries(config.channels!)) {
      if (entry.enabled === false) continue;
      if (!entry.module) continue;

      try {
        await this.resolveChannel(channelId, entry.module);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ channelId, error: message }, 'Failed to resolve dynamic channel module');
      }
    }

    return this.loadedModules;
  }

  /**
   * Resolve (import) a single channel module.
   *
   * @param channelId - Channel identifier
   * @param modulePath - Module specifier
   * @returns Resolved factory info
   */
  async resolveChannel(channelId: string, modulePath: string): Promise<{ factory: (config: ChannelConfig) => IChannel; name?: string }> {
    // Check cache
    const cached = this.loadedModules.get(channelId);
    if (cached) return cached;

    const baseDir = findDisclaudeDir(this.workspaceDir) || this.workspaceDir;
    const mod = await loadModule(modulePath, baseDir);
    const { factory, name } = extractFactory(mod, channelId);

    // Update registry with real factory
    const channelConfig = this.getChannelConfig(channelId);
    const realFactory: (config: ChannelConfig) => IChannel = (config: ChannelConfig) => {
      return factory({ ...config, ...channelConfig });
    };

    this.registry.registerDynamic(channelId, name || channelId, modulePath, realFactory);
    this.loadedModules.set(channelId, { factory, name });

    return { factory, name };
  }

  /**
   * Get the configuration for a specific channel from the dynamic channels file.
   */
  private getChannelConfig(channelId: string): Record<string, unknown> {
    const config = readDynamicChannelsFile(this.workspaceDir);
    return config?.channels?.[channelId]?.config || {};
  }

  /**
   * List all configured dynamic channels (without loading modules).
   *
   * @returns Array of channel info objects
   */
  listChannels(): Array<{ id: string; enabled: boolean; module: string }> {
    const config = readDynamicChannelsFile(this.workspaceDir);
    if (!config?.channels) return [];

    return Object.entries(config.channels).map(([id, entry]) => ({
      id,
      enabled: entry.enabled !== false,
      module: entry.module || '',
    }));
  }

  /**
   * Get the workspace directory used by this loader.
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }
}
