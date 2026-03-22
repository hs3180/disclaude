/**
 * Channel Loader - Dynamically loads channel plugins from configuration.
 *
 * Supports:
 * - Built-in channel registrations (rest, feishu)
 * - Local module paths (resolved from config file directory)
 * - npm package modules
 *
 * Uses lazy-loading for dynamic modules: the factory function triggers
 * module loading on first invocation, keeping the initial setup fast.
 *
 * @module channels/channel-loader
 * @see Issue #1422
 */

import { resolve, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import {
  type ChannelPlugin,
  type DynamicChannelConfig,
  type ExtendedChannelsConfig,
  type ResolvedChannel,
} from './channel-plugin.js';

const logger = createLogger('ChannelLoader');

/**
 * Result of channel loading.
 */
export interface ChannelLoadResult {
  /** Successfully loaded channels */
  loaded: ResolvedChannel[];

  /** Failed channel load attempts */
  failed: Array<{
    name: string;
    error: string;
  }>;

  /** Skipped channels (disabled in config) */
  skipped: string[];
}

/**
 * Channel Loader - Loads and registers channels from configuration.
 *
 * Dynamic channels use lazy-loading: the module is imported on the first
 * call to the factory function, not during initial configuration loading.
 * This keeps startup fast and allows graceful error handling.
 *
 * @example
 * ```typescript
 * const loader = new ChannelLoader({ baseDir: configDir });
 *
 * // Register built-in channels
 * loader.registerBuiltin('rest', (config) => new RestChannel(config), 'builtin:rest');
 * loader.registerBuiltin('feishu', (config) => new FeishuChannel(config), 'builtin:feishu');
 *
 * // Load from config
 * const result = loader.load(config.channels);
 *
 * for (const channel of result.loaded) {
 *   try {
 *     const instance = channel.factory(channelConfig);
 *     primaryNode.registerChannel(instance);
 *   } catch (error) {
 *     logger.error({ name: channel.name, error }, 'Failed to create channel');
 *   }
 * }
 * ```
 */
export class ChannelLoader {
  private readonly baseDir: string;
  private readonly builtinFactories: Map<string, {
    factory: ResolvedChannel['factory'];
    source: string;
  }>;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || process.cwd();
    this.builtinFactories = new Map();
  }

  /**
   * Register a built-in channel factory.
   *
   * Built-in channels don't require a `module` field in config.
   * When a channel name in config matches a registered builtin,
   * the builtin factory is used directly without dynamic loading.
   *
   * @param name - Channel name (matches config key, e.g., 'rest', 'feishu')
   * @param factory - Factory function to create channel instance
   * @param source - Source description for logging/debugging
   */
  registerBuiltin(
    name: string,
    factory: ResolvedChannel['factory'],
    source: string
  ): void {
    this.builtinFactories.set(name, { factory, source });
    logger.debug({ name, source }, 'Built-in channel registered with loader');
  }

  /**
   * Get the names of registered built-in channels.
   *
   * @returns Array of builtin channel names
   */
  getBuiltinNames(): string[] {
    return Array.from(this.builtinFactories.keys());
  }

  /**
   * Load channels from configuration and return a populated registry.
   *
   * Processing order for each channel in config:
   * 1. Skip if `enabled: false`
   * 2. If matches a registered builtin (no `module` field) → use builtin factory
   * 3. If `module` field is present → create lazy-loading factory
   * 4. Otherwise → skip (unknown channel without module)
   *
   * @param channelsConfig - Channels section from disclaude.config.yaml
   * @returns ChannelLoadResult with loaded, failed, and skipped channels
   */
  load(channelsConfig?: ExtendedChannelsConfig): ChannelLoadResult {
    const result: ChannelLoadResult = {
      loaded: [],
      failed: [],
      skipped: [],
    };

    if (!channelsConfig) {
      logger.debug('No channels configuration found');
      return result;
    }

    for (const [name, channelConfig] of Object.entries(channelsConfig)) {
      // Skip empty/undefined configs
      if (!channelConfig) {
        result.skipped.push(name);
        continue;
      }

      // Check if explicitly disabled
      if (channelConfig.enabled === false) {
        logger.debug({ name }, 'Channel disabled in config, skipping');
        result.skipped.push(name);
        continue;
      }

      try {
        const resolved = this.resolveChannel(name, channelConfig);
        if (resolved) {
          result.loaded.push(resolved);
          logger.info({ name, source: resolved.source, isDynamic: resolved.isDynamic }, 'Channel resolved');
        } else {
          result.skipped.push(name);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ name, error: message }, 'Failed to resolve channel');
        result.failed.push({ name, error: message });
      }
    }

    logger.info(
      {
        loaded: result.loaded.length,
        failed: result.failed.length,
        skipped: result.skipped.length,
      },
      'Channel loading complete'
    );

    return result;
  }

  /**
   * Resolve a single channel from its configuration.
   *
   * @param name - Channel name from config
   * @param config - Channel-specific configuration
   * @returns Resolved channel or null if should be skipped
   */
  private resolveChannel(name: string, config: DynamicChannelConfig): ResolvedChannel | null {
    // Case 1: Built-in channel (no module specified, matches a registered builtin)
    if (!config.module && this.builtinFactories.has(name)) {
      const builtin = this.builtinFactories.get(name)!;
      return {
        name,
        enabled: config.enabled !== false,
        isDynamic: false,
        factory: builtin.factory,
        source: builtin.source,
      };
    }

    // Case 2: Dynamic channel (module specified)
    if (config.module) {
      return this.createLazyChannel(name, config);
    }

    // Case 3: Unknown channel without module - skip silently
    logger.debug({ name, builtins: Array.from(this.builtinFactories.keys()) },
      'Channel has no module and is not a builtin, skipping');
    return null;
  }

  /**
   * Create a lazy-loading channel entry for a dynamic module.
   *
   * The module is not loaded during this call. Instead, the returned
   * factory function will load the module on first invocation and cache
   * the result for subsequent calls.
   *
   * @param name - Channel name from config
   * @param config - Channel-specific configuration
   * @returns Resolved channel with lazy-loading factory
   */
  private createLazyChannel(name: string, config: DynamicChannelConfig): ResolvedChannel {
    const modulePath = this.resolveModulePath(config.module!);

    logger.debug({ name, modulePath }, 'Creating lazy-loading channel entry');

    let cachedFactory: ResolvedChannel['factory'] | null = null;
    let loadError: Error | null = null;

    const lazyFactory: ResolvedChannel['factory'] = (channelConfig) => {
      if (loadError) {
        throw loadError;
      }
      if (cachedFactory) {
        return cachedFactory(channelConfig);
      }

      try {
        // Use require() for synchronous loading of compiled JS modules
        // This works because:
        // 1. TypeScript is compiled to JS before runtime
        // 2. require() handles both .js files and npm packages
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(modulePath) as Record<string, unknown>;
        const plugin = this.extractPlugin(name, mod, config.module!);
        cachedFactory = plugin.createChannel;
        logger.info({ name, modulePath }, 'Dynamic channel module loaded');
        return cachedFactory(channelConfig);
      } catch (error) {
        loadError = new Error(
          `Failed to load channel module '${config.module}' for '${name}': ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
        throw loadError;
      }
    };

    return {
      name,
      enabled: config.enabled !== false,
      isDynamic: true,
      factory: lazyFactory,
      source: `dynamic:${config.module}`,
    };
  }

  /**
   * Resolve a module path to a resolvable identifier.
   *
   * - Absolute path: return as-is
   * - Relative path (starts with ./ or ../): resolve relative to baseDir
   * - Package name: return as-is for Node.js module resolution
   *
   * @param modulePath - Module path from config
   * @returns Resolved module path
   */
  private resolveModulePath(modulePath: string): string {
    if (isAbsolute(modulePath)) {
      return modulePath;
    }

    if (modulePath.startsWith('.') || modulePath.startsWith('..')) {
      const resolved = resolve(this.baseDir, modulePath);
      if (!existsSync(resolved)) {
        logger.warn(
          { modulePath, resolved, baseDir: this.baseDir },
          'Resolved module path does not exist on filesystem'
        );
      }
      return resolved;
    }

    // npm package name - return as-is for Node.js module resolution
    return modulePath;
  }

  /**
   * Extract a ChannelPlugin from a loaded module's exports.
   *
   * Supports multiple export formats (tried in order):
   * 1. Named export `channelPlugin` (ChannelPlugin interface)
   * 2. Named export `createChannel` (ChannelFactory - wrapped in plugin)
   * 3. Default export (ChannelPlugin or ChannelFactory)
   *
   * @param name - Channel name (for error messages and default plugin id)
   * @param mod - Loaded module exports object
   * @param modulePath - Module path (for error messages)
   * @returns Extracted ChannelPlugin
   * @throws Error if no valid export format is found
   */
  private extractPlugin(name: string, mod: Record<string, unknown>, modulePath: string): ChannelPlugin {
    // 1. Try named export: channelPlugin
    if (this.isChannelPlugin(mod.channelPlugin)) {
      return mod.channelPlugin;
    }

    // 2. Try named export: createChannel (wrap in minimal plugin)
    if (typeof mod.createChannel === 'function') {
      return {
        id: name,
        name: name,
        createChannel: mod.createChannel as ResolvedChannel['factory'],
      };
    }

    // 3. Try default export
    if (mod.default != null) {
      const def = mod.default;

      if (this.isChannelPlugin(def)) {
        return def;
      }

      if (typeof def === 'function') {
        return {
          id: name,
          name: name,
          createChannel: def as ResolvedChannel['factory'],
        };
      }
    }

    throw new Error(
      `Module '${modulePath}' does not export a valid channel plugin. ` +
      `Expected: 'channelPlugin' (ChannelPlugin), 'createChannel' (ChannelFactory), or default export. ` +
      `Got exports: ${Object.keys(mod).join(', ') || '(empty)'}`
    );
  }

  /**
   * Type guard: check if a value conforms to the ChannelPlugin interface.
   *
   * Minimum requirements: `id` (string) and `createChannel` (function).
   *
   * @param value - Value to check
   * @returns true if value is a valid ChannelPlugin
   */
  private isChannelPlugin(value: unknown): value is ChannelPlugin {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.id === 'string' &&
      typeof obj.createChannel === 'function'
    );
  }
}
