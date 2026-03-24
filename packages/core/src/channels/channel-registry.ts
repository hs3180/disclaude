/**
 * Channel Registry.
 *
 * Provides a central registry for channel type descriptors, enabling
 * configuration-driven dynamic channel creation instead of hard-coded imports.
 *
 * Built-in channels (RestChannel, FeishuChannel) and future plugin channels
 * register their descriptors here. The registry supports:
 * - Registration of channel type descriptors
 * - Lookup by channel type
 * - Factory-based channel instantiation
 * - Duplicate registration detection
 *
 * @module channels/channel-registry
 */

import { createLogger } from '../utils/logger.js';
import type {
  ChannelDescriptor,
  ChannelConfig,
  IChannel,
} from '../types/channel.js';

const logger = createLogger('ChannelRegistry');

/**
 * Error thrown when attempting to register a duplicate channel type.
 */
export class ChannelRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelRegistryError';
  }
}

/**
 * Channel Registry.
 *
 * Manages channel type descriptors and provides factory methods for
 * creating channel instances. This decouples channel type registration
 * from channel instantiation.
 *
 * @example
 * ```typescript
 * const registry = new ChannelRegistry();
 *
 * // Register a channel type
 * registry.register({
 *   type: 'rest',
 *   name: 'REST API',
 *   factory: (config) => new RestChannel(config),
 *   defaultCapabilities: { ... },
 * });
 *
 * // Create a channel instance
 * const channel = registry.create('rest', { port: 3000 });
 * ```
 */
export class ChannelRegistry {
  private readonly descriptors: Map<string, ChannelDescriptor> = new Map();

  /**
   * Register a channel type descriptor.
   *
   * @param descriptor - Channel descriptor to register
   * @throws {ChannelRegistryError} If a descriptor with the same type is already registered
   */
  register(descriptor: ChannelDescriptor): void {
    if (this.descriptors.has(descriptor.type)) {
      throw new ChannelRegistryError(
        `Channel type "${descriptor.type}" is already registered. ` +
        `Use has() to check before registering, or unregister() first.`
      );
    }

    this.descriptors.set(descriptor.type, descriptor);
    logger.info(
      { type: descriptor.type, name: descriptor.name },
      'Channel type registered'
    );
  }

  /**
   * Unregister a channel type descriptor.
   *
   * @param type - Channel type identifier to unregister
   * @returns true if the descriptor was found and removed, false otherwise
   */
  unregister(type: string): boolean {
    const removed = this.descriptors.delete(type);
    if (removed) {
      logger.info({ type }, 'Channel type unregistered');
    }
    return removed;
  }

  /**
   * Get a registered channel descriptor.
   *
   * @param type - Channel type identifier
   * @returns Channel descriptor or undefined if not registered
   */
  get(type: string): ChannelDescriptor | undefined {
    return this.descriptors.get(type);
  }

  /**
   * Check if a channel type is registered.
   *
   * @param type - Channel type identifier
   * @returns true if the type is registered
   */
  has(type: string): boolean {
    return this.descriptors.has(type);
  }

  /**
   * Get all registered channel descriptors.
   *
   * @returns Array of all registered channel descriptors
   */
  getAll(): ChannelDescriptor[] {
    return Array.from(this.descriptors.values());
  }

  /**
   * Get all registered channel type identifiers.
   *
   * @returns Array of registered channel type strings
   */
  getTypes(): string[] {
    return Array.from(this.descriptors.keys());
  }

  /**
   * Create a channel instance from a registered descriptor.
   *
   * @param type - Channel type identifier
   * @param config - Channel configuration
   * @returns Created channel instance
   * @throws {ChannelRegistryError} If the channel type is not registered
   */
  create(type: string, config: ChannelConfig): IChannel {
    const descriptor = this.descriptors.get(type);

    if (!descriptor) {
      throw new ChannelRegistryError(
        `Channel type "${type}" is not registered. ` +
        `Available types: [${this.getTypes().join(', ')}]`
      );
    }

    logger.debug({ type, configKeys: Object.keys(config) }, 'Creating channel instance');
    return descriptor.factory(config);
  }

  /**
   * Get the number of registered channel types.
   *
   * @returns Number of registered descriptors
   */
  get size(): number {
    return this.descriptors.size;
  }
}
