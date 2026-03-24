/**
 * Channel Registry.
 *
 * Manages channel type descriptors for dynamic channel creation.
 * Decouples channel type registration from channel instantiation,
 * enabling configuration-driven dynamic channel creation instead of
 * hard-coded imports.
 *
 * Key design decisions:
 * - Duplicate registration throws ChannelRegistryError (use has() for safe checks)
 * - create() validates type exists with descriptive error listing available types
 * - Backward compatible: purely additive, no changes to existing code paths
 *
 * @module channels/channel-registry
 */

import type {
  ChannelConfig,
  ChannelCapabilities,
  ChannelDescriptor,
  IChannel,
} from '../types/channel.js';

/**
 * Error thrown by ChannelRegistry for registration and creation failures.
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
 * Provides a central registry for channel type descriptors.
 * Channels are registered with a descriptor containing metadata,
 * factory function, and default capabilities.
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
 * // Check availability
 * registry.has('rest'); // true
 *
 * // Create an instance
 * const channel = registry.create('rest', { port: 3000 });
 * ```
 */
export class ChannelRegistry {
  private readonly descriptors = new Map<string, ChannelDescriptor>();

  /**
   * Register a channel type descriptor.
   *
   * @param descriptor - Channel descriptor to register
   * @throws {ChannelRegistryError} if a descriptor with the same type is already registered
   */
  register(descriptor: ChannelDescriptor): void {
    if (this.descriptors.has(descriptor.type)) {
      throw new ChannelRegistryError(
        `Channel type "${descriptor.type}" is already registered. Use has() to check before registering.`
      );
    }

    this.descriptors.set(descriptor.type, descriptor);
  }

  /**
   * Get a channel descriptor by type.
   *
   * @param type - Channel type identifier
   * @returns Channel descriptor or undefined if not found
   */
  get(type: string): ChannelDescriptor | undefined {
    return this.descriptors.get(type);
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
   * Check if a channel type is registered.
   *
   * @param type - Channel type identifier
   * @returns true if the channel type is registered
   */
  has(type: string): boolean {
    return this.descriptors.has(type);
  }

  /**
   * Create a channel instance by type.
   *
   * @param type - Channel type identifier
   * @param config - Channel configuration
   * @returns Created channel instance
   * @throws {ChannelRegistryError} if the channel type is not registered
   */
  create(type: string, config: ChannelConfig = {}): IChannel {
    const descriptor = this.descriptors.get(type);

    if (!descriptor) {
      const available = Array.from(this.descriptors.keys()).sort().join(', ');
      throw new ChannelRegistryError(
        `Unknown channel type "${type}". Available types: [${available}]`
      );
    }

    return descriptor.factory(config);
  }

  /**
   * Get the default capabilities for a channel type.
   *
   * @param type - Channel type identifier
   * @returns Default capabilities for the channel type
   * @throws {ChannelRegistryError} if the channel type is not registered
   */
  getCapabilities(type: string): ChannelCapabilities {
    const descriptor = this.descriptors.get(type);

    if (!descriptor) {
      const available = Array.from(this.descriptors.keys()).sort().join(', ');
      throw new ChannelRegistryError(
        `Unknown channel type "${type}". Available types: [${available}]`
      );
    }

    return descriptor.defaultCapabilities;
  }

  /**
   * Unregister a channel type.
   *
   * Useful for testing or dynamic reconfiguration.
   *
   * @param type - Channel type identifier
   * @returns true if the channel type was found and removed, false otherwise
   */
  unregister(type: string): boolean {
    return this.descriptors.delete(type);
  }
}
