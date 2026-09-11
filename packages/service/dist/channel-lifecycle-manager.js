/**
 * Channel Lifecycle Manager - Descriptor-based channel wiring.
 *
 * Issue #1594 Phase 2: Abstract channel-specific wiring logic from cli.ts
 * into WiredChannelDescriptor instances. This reduces cli.ts channel setup
 * from ~220 lines to ~15 lines.
 *
 * Architecture:
 * ```
 * cli.ts → lifecycleManager.createAndWire(descriptor, config)
 *        → descriptor.factory(config) → channel instance
 *        → descriptor.createCallbacks(channel, context) → callback factory
 *        → descriptor.createMessageHandler(channel, wiredContext) → handler
 *        → channelManager.setupHandlers(channel, handler, controlHandler)
 *        → descriptor.setup?(channel, config, context) → post-registration
 * ```
 *
 * @module channel-lifecycle-manager
 */
// ============================================================================
// ChannelLifecycleManager
// ============================================================================
/**
 * ChannelLifecycleManager - Manages channel creation, wiring, and lifecycle.
 *
 * Combines ChannelManager (instance tracking + lifecycle) with
 * WiredChannelDescriptor (channel-specific wiring logic).
 *
 * Supports two usage patterns:
 * 1. Direct: `createAndWire(descriptor, config)` — pass descriptor directly
 * 2. Type-based: `createAndWireByType('rest', config)` — lookup by type string
 *
 * Issue #1594 Phase 3: Type-based creation enables config-driven channel
 * instantiation without hard-coded channel imports in cli.ts.
 *
 * Usage:
 * ```typescript
 * const manager = new ChannelLifecycleManager(channelManager, context);
 * manager.registerWiredDescriptor(REST_WIRED_DESCRIPTOR);
 * manager.registerWiredDescriptor(FEISHU_WIRED_DESCRIPTOR);
 *
 * // Config-driven: iterate over channel configs
 * for (const { type, config } of channelConfigs) {
 *   await manager.createAndWireByType(type, config);
 * }
 * await manager.startAll();
 * ```
 */
export class ChannelLifecycleManager {
    channelManager;
    context;
    wiredDescriptors = new Map();
    constructor(channelManager, context) {
        this.channelManager = channelManager;
        this.context = context;
    }
    /**
     * Register a wired channel descriptor for type-based lookup.
     *
     * After registration, channels can be created via `createAndWireByType()`
     * using the descriptor's type string, without importing the descriptor directly.
     *
     * @param descriptor - The wired descriptor to register
     * @throws {Error} if a descriptor with the same type is already registered
     */
    registerWiredDescriptor(descriptor) {
        if (this.wiredDescriptors.has(descriptor.type)) {
            throw new Error(`Wired channel descriptor "${descriptor.type}" is already registered. ` +
                'Use hasWiredDescriptor() to check before registering.');
        }
        this.wiredDescriptors.set(descriptor.type, descriptor);
    }
    /**
     * Check if a wired descriptor is registered for the given type.
     */
    hasWiredDescriptor(type) {
        return this.wiredDescriptors.has(type);
    }
    /**
     * Get a registered wired descriptor by type.
     */
    getWiredDescriptor(type) {
        return this.wiredDescriptors.get(type);
    }
    /**
     * Get all registered wired descriptor types.
     */
    getRegisteredTypes() {
        return Array.from(this.wiredDescriptors.keys());
    }
    /**
     * Create, register, and wire a channel using its descriptor.
     *
     * @param descriptor - The wired descriptor defining the channel
     * @param config - Channel-specific configuration
     * @returns The created and wired channel instance
     */
    async createAndWire(descriptor, config) {
        const channel = descriptor.factory(config);
        // Register with ChannelManager
        this.channelManager.register(channel);
        // Create callbacks factory from descriptor hook
        const callbacks = descriptor.createCallbacks(channel, this.context);
        // Create enriched context with channel and callbacks
        const wiredContext = {
            ...this.context,
            channel,
            callbacks,
        };
        // Create message handler from descriptor hook
        const messageHandler = descriptor.createMessageHandler(channel, wiredContext);
        // Wire handlers via ChannelManager
        this.channelManager.setupHandlers(channel, messageHandler, this.context.controlHandler);
        // Run post-registration setup hook
        if (descriptor.setup) {
            await descriptor.setup(channel, config, this.context);
        }
        return channel;
    }
    /**
     * Create, register, and wire a channel by type string.
     *
     * Looks up the registered WiredChannelDescriptor by type and delegates
     * to createAndWire(). This enables config-driven channel creation where
     * cli.ts doesn't need to import specific descriptors.
     *
     * Issue #1594 Phase 3: Config-driven channel instantiation.
     *
     * @param type - Channel type identifier (e.g., 'rest', 'feishu')
     * @param config - Channel-specific configuration
     * @returns The created and wired channel instance
     * @throws {Error} if the channel type is not registered
     */
    async createAndWireByType(type, config) {
        const descriptor = this.wiredDescriptors.get(type);
        if (!descriptor) {
            const available = Array.from(this.wiredDescriptors.keys()).sort().join(', ');
            throw new Error(`Unknown channel type "${type}". Registered types: [${available}]`);
        }
        // Type assertion is safe: the descriptor's factory handles config validation
        return await this.createAndWire(descriptor, config);
    }
    /**
     * Start all registered channels.
     * Delegates to ChannelManager.startAll().
     */
    async startAll() {
        await this.channelManager.startAll();
    }
    /**
     * Stop all registered channels.
     * Delegates to ChannelManager.stopAll().
     */
    async stopAll() {
        await this.channelManager.stopAll();
    }
    /**
     * Get the underlying ChannelManager.
     */
    getChannelManager() {
        return this.channelManager;
    }
}
