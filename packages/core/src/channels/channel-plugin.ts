/**
 * Channel Plugin types and registry for dynamic channel registration.
 *
 * This module provides the plugin infrastructure for dynamically loading
 * channel implementations at runtime, supporting:
 * - Built-in channels (rest, feishu)
 * - Local module paths
 * - npm package modules
 *
 * @module channels/channel-plugin
 * @see Issue #1422
 */

import { createLogger } from '../utils/logger.js';
import type { IChannel, ChannelFactory, ChannelConfig } from '../types/channel.js';
import type { DynamicChannelConfig } from '../config/types.js';

const logger = createLogger('ChannelRegistry');

// Re-export DynamicChannelConfig for convenience
export type { DynamicChannelConfig } from '../config/types.js';

/**
 * Extended channels configuration that supports both static and dynamic channels.
 */
export interface ExtendedChannelsConfig {
  [channelName: string]: DynamicChannelConfig | undefined;
}

/**
 * A Channel Plugin provides a factory function to create channel instances.
 *
 * Plugin modules must export a `createChannel` function or a default export
 * that conforms to this interface.
 *
 * @example
 * ```typescript
 * // my-channel-plugin.ts
 * import type { ChannelPlugin } from '@disclaude/core';
 *
 * export const channelPlugin: ChannelPlugin = {
 *   id: 'my-channel',
 *   name: 'My Custom Channel',
 *   version: '1.0.0',
 *   createChannel: (config) => new MyChannel(config),
 * };
 *
 * export default channelPlugin;
 * ```
 */
export interface ChannelPlugin {
  /** Unique plugin identifier */
  id: string;

  /** Human-readable plugin name */
  name: string;

  /** Plugin version */
  version?: string;

  /** Plugin description */
  description?: string;

  /** Factory function to create channel instance */
  createChannel: ChannelFactory;
}

/**
 * Resolved channel entry after plugin loading.
 */
export interface ResolvedChannel {
  /** Channel name (from config key) */
  name: string;

  /** Whether this channel is enabled */
  enabled: boolean;

  /** Whether this channel uses a dynamically loaded plugin */
  isDynamic: boolean;

  /** Factory function to create the channel */
  factory: ChannelFactory;

  /** Plugin metadata (if dynamically loaded) */
  plugin?: ChannelPlugin;

  /** Source of the factory: 'builtin' or the module path */
  source: string;
}

/**
 * Channel Registry - Manages channel plugin registration and lookup.
 *
 * Similar to the SDK Provider registry pattern, this provides a central
 * registry for channel plugins that can be looked up by name.
 *
 * @example
 * ```typescript
 * const registry = new ChannelRegistry();
 *
 * // Register a built-in channel
 * registry.register('feishu', factory, 'builtin');
 *
 * // Register a dynamic plugin
 * registry.registerPlugin(plugin);
 *
 * // Look up a channel
 * const entry = registry.get('feishu');
 * if (entry) {
 *   const channel = entry.factory(config);
 * }
 * ```
 */
export class ChannelRegistry {
  private channels: Map<string, ResolvedChannel> = new Map();

  /**
   * Register a channel factory.
   *
   * @param name - Channel name (used as config key)
   * @param factory - Factory function to create channel instance
   * @param source - Source description for logging
   * @param plugin - Optional plugin metadata
   * @param enabled - Whether this channel is enabled by default
   */
  register(
    name: string,
    factory: ChannelFactory,
    source: string,
    plugin?: ChannelPlugin,
    enabled: boolean = true
  ): void {
    if (this.channels.has(name)) {
      logger.warn({ name, existingSource: this.channels.get(name)!.source }, 'Overwriting registered channel');
    }

    this.channels.set(name, {
      name,
      enabled,
      isDynamic: !!plugin,
      factory,
      plugin,
      source,
    });

    logger.debug({ name, source, enabled }, 'Channel registered');
  }

  /**
   * Register a channel plugin.
   *
   * Convenience method that extracts the factory from a ChannelPlugin.
   *
   * @param plugin - Channel plugin to register
   * @param enabled - Whether this channel is enabled by default
   */
  registerPlugin(plugin: ChannelPlugin, enabled: boolean = true): void {
    this.register(plugin.id, plugin.createChannel, `plugin:${plugin.id}@${plugin.version || 'unknown'}`, plugin, enabled);
  }

  /**
   * Get a registered channel by name.
   *
   * @param name - Channel name
   * @returns Resolved channel entry or undefined
   */
  get(name: string): ResolvedChannel | undefined {
    return this.channels.get(name);
  }

  /**
   * Check if a channel is registered.
   *
   * @param name - Channel name
   * @returns true if registered
   */
  has(name: string): boolean {
    return this.channels.has(name);
  }

  /**
   * Get all registered channel names.
   *
   * @returns Array of registered channel names
   */
  getNames(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get all registered channels.
   *
   * @returns Array of all resolved channel entries
   */
  getAll(): ResolvedChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get all enabled channels.
   *
   * @returns Array of enabled resolved channel entries
   */
  getEnabled(): ResolvedChannel[] {
    return this.getAll().filter((ch) => ch.enabled);
  }

  /**
   * Create a channel instance from a registered channel.
   *
   * @param name - Channel name
   * @param config - Channel configuration
   * @returns IChannel instance
   * @throws Error if channel is not registered
   */
  createChannel(name: string, config: ChannelConfig = {}): IChannel {
    const entry = this.get(name);
    if (!entry) {
      throw new Error(`Channel '${name}' is not registered. Available channels: ${this.getNames().join(', ')}`);
    }
    return entry.factory(config);
  }

  /**
   * Remove a registered channel.
   *
   * @param name - Channel name
   * @returns true if channel was found and removed
   */
  unregister(name: string): boolean {
    return this.channels.delete(name);
  }

  /**
   * Clear all registered channels.
   */
  clear(): void {
    this.channels.clear();
  }

  /**
   * Get the number of registered channels.
   *
   * @returns Number of registered channels
   */
  size(): number {
    return this.channels.size;
  }
}
