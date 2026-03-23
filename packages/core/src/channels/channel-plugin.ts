/**
 * Dynamic Channel Plugin System.
 *
 * Provides interfaces and registry for runtime-discoverable channel plugins.
 * Dynamic channels are configured via `.disclaude/channels.yaml` (NOT disclaude.config.yaml),
 * keeping the core config clean and separating concerns between built-in and dynamic channels.
 *
 * Plugin modules can be loaded from:
 * - npm packages (e.g., `@disclaude/wechat-channel`)
 * - Relative paths (e.g., `./channels/my-channel`)
 * - Absolute paths (e.g., `/path/to/channel`)
 *
 * Supported plugin export formats:
 * 1. Named export `channelPlugin` — Full ChannelPlugin interface
 * 2. Named export `createChannel` — Simple factory function
 * 3. Default export — Either ChannelPlugin or ChannelFactory
 *
 * @module channels/channel-plugin
 * @see Issue #1422
 */

import { createLogger } from '../utils/logger.js';
import type { IChannel, ChannelConfig } from '../types/channel.js';

const logger = createLogger('ChannelPlugin');

/**
 * Channel plugin descriptor.
 *
 * A complete plugin definition with metadata and a factory function.
 * Plugins can export this as a named `channelPlugin` export or as a default export.
 */
export interface ChannelPlugin {
  /** Unique channel identifier */
  id: string;
  /** Human-readable channel name */
  name: string;
  /** Plugin version (semver) */
  version: string;
  /** Plugin description */
  description?: string;
  /** Plugin author */
  author?: string;
  /** Factory function to create a channel instance */
  createChannel: (config: ChannelConfig) => IChannel;
}

/**
 * Channel factory function type.
 * A simpler plugin format: just a function that creates a channel.
 */
export type ChannelFactory = (config: ChannelConfig) => IChannel;

/**
 * Type guard: check if a value is a ChannelPlugin (has `id` and `createChannel`).
 */
export function isChannelPlugin(value: unknown): value is ChannelPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.createChannel === 'function'
  );
}

/**
 * Type guard: check if a value is a ChannelFactory (just a function).
 */
export function isChannelFactory(value: unknown): value is ChannelFactory {
  return typeof value === 'function';
}

/**
 * Resolved channel entry stored in the registry.
 */
interface RegistryEntry {
  /** Channel ID */
  id: string;
  /** Channel name (for display) */
  name?: string;
  /** Factory function to create a channel instance */
  factory: ChannelFactory;
  /** Source of this channel ('builtin' or 'dynamic') */
  source: 'builtin' | 'dynamic';
  /** Module path (for dynamic channels) */
  modulePath?: string;
}

/**
 * Channel Registry.
 *
 * Central registry for channel plugins. Supports registration of both
 * built-in channels (pre-registered) and dynamically loaded plugins.
 *
 * @example
 * ```typescript
 * const registry = new ChannelRegistry();
 *
 * // Register a built-in channel
 * registry.registerBuiltin('rest', 'REST API', (config) => new RestChannel(config));
 *
 * // Register a dynamic plugin
 * registry.registerPlugin(plugin);
 *
 * // Create a channel instance
 * const channel = registry.createChannel('rest', config);
 * ```
 */
export class ChannelRegistry {
  private entries: Map<string, RegistryEntry> = new Map();

  /**
   * Register a built-in channel with a factory function.
   *
   * @param id - Unique channel identifier
   * @param name - Human-readable channel name
   * @param factory - Factory function to create channel instances
   */
  registerBuiltin(id: string, name: string, factory: ChannelFactory): void {
    this.entries.set(id, { id, name, factory, source: 'builtin' });
    logger.debug({ channelId: id, name }, 'Built-in channel registered');
  }

  /**
   * Register a ChannelPlugin instance.
   *
   * @param plugin - Channel plugin descriptor
   */
  registerPlugin(plugin: ChannelPlugin): void {
    this.entries.set(plugin.id, {
      id: plugin.id,
      name: plugin.name,
      factory: plugin.createChannel,
      source: 'dynamic',
    });
    logger.debug(
      { channelId: plugin.id, name: plugin.name, version: plugin.version },
      'Dynamic channel plugin registered'
    );
  }

  /**
   * Register a dynamic channel with a lazy-loading factory.
   *
   * @param id - Unique channel identifier
   * @param name - Human-readable channel name
   * @param modulePath - Module path to lazy-load
   * @param factory - Factory function (may be lazy)
   */
  registerDynamic(id: string, name: string, modulePath: string, factory: ChannelFactory): void {
    this.entries.set(id, { id, name, factory, source: 'dynamic', modulePath });
    logger.debug({ channelId: id, name, modulePath }, 'Dynamic channel registered');
  }

  /**
   * Get a channel factory by ID.
   *
   * @param channelId - Channel identifier
   * @returns Factory function or undefined if not found
   */
  getFactory(channelId: string): ChannelFactory | undefined {
    return this.entries.get(channelId)?.factory;
  }

  /**
   * Create a channel instance by ID.
   *
   * @param channelId - Channel identifier
   * @param config - Channel configuration
   * @returns IChannel instance
   * @throws Error if channel not found
   */
  createChannel(channelId: string, config: ChannelConfig): IChannel {
    const entry = this.entries.get(channelId);
    if (!entry) {
      throw new Error(`Channel '${channelId}' not found in registry`);
    }
    return entry.factory(config);
  }

  /**
   * Check if a channel is registered.
   */
  has(channelId: string): boolean {
    return this.entries.has(channelId);
  }

  /**
   * Get all registered channel IDs.
   */
  getIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Get all registered entries.
   */
  getAll(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get all dynamic (non-builtin) channel entries.
   */
  getDynamic(): RegistryEntry[] {
    return this.getAll().filter((e) => e.source === 'dynamic');
  }

  /**
   * Get all builtin channel entries.
   */
  getBuiltin(): RegistryEntry[] {
    return this.getAll().filter((e) => e.source === 'builtin');
  }

  /**
   * Remove a channel from the registry.
   *
   * @param channelId - Channel identifier
   * @returns true if removed, false if not found
   */
  remove(channelId: string): boolean {
    const removed = this.entries.delete(channelId);
    if (removed) {
      logger.debug({ channelId }, 'Channel removed from registry');
    }
    return removed;
  }

  /**
   * Clear all entries from the registry.
   */
  clear(): void {
    this.entries.clear();
    logger.debug('Channel registry cleared');
  }

  /**
   * Get the number of registered channels.
   */
  get size(): number {
    return this.entries.size;
  }
}
