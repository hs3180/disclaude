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

import type {
  IChannel,
  ChannelConfig,
  ChannelDescriptor,
  MessageHandler,
  ControlHandler,
  FeishuApiHandlers,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import type { Logger } from 'pino';
import { ChannelManager } from './channel-manager.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal interface for PrimaryNode access in channel setup hooks.
 * PrimaryNode satisfies this interface structurally (duck typing).
 */
export interface IPrimaryNodeForSetup {
  getInteractiveContextStore(): {
    generatePrompt(
      messageId: string,
      chatId: string,
      actionValue: string,
      actionText?: string,
      actionType?: string,
      formData?: Record<string, unknown>
    ): string | undefined;
  };
  registerFeishuHandlers(handlers: FeishuApiHandlers): void;
}

/**
 * Context passed to descriptor wiring hooks.
 * Provides shared dependencies needed for channel setup.
 */
export interface ChannelSetupContext {
  /** Agent pool for creating chat agents */
  agentPool: {
    getOrCreateChatAgent: (chatId: string, callbacks: PilotCallbacks) => unknown;
  };
  /** Unified control handler for all channels */
  controlHandler: ControlHandler;
  /** Control handler context (for adding passive mode etc.) */
  controlHandlerContext: {
    passiveMode?: {
      isEnabled: (chatId: string) => boolean;
      setEnabled: (chatId: string, enabled: boolean) => void;
    };
  };
  /** Logger instance */
  logger: Logger;
  /** PrimaryNode reference for Feishu-specific setup */
  primaryNode: IPrimaryNodeForSetup;
}

/**
 * Internal context enriched with channel-specific data.
 * Passed to createMessageHandler hook.
 */
export interface WiredContext extends ChannelSetupContext {
  /** The channel instance */
  channel: IChannel;
  /**
   * Callback factory for creating PilotCallbacks.
   * Called per-message to match current agent pool usage pattern.
   */
  callbacks: (chatId: string) => PilotCallbacks;
}

/**
 * WiredChannelDescriptor - Extended ChannelDescriptor with wiring hooks.
 *
 * In addition to the core descriptor fields (type, name, factory, capabilities),
 * this includes hooks for:
 * - Creating PilotCallbacks (wraps channel.sendMessage into agent interface)
 * - Creating message handlers (processes incoming messages through agentPool)
 * - Post-registration setup (passive mode, IPC handlers, etc.)
 */
export interface WiredChannelDescriptor<TConfig extends ChannelConfig = ChannelConfig>
  extends ChannelDescriptor<TConfig> {
  /**
   * Create a PilotCallbacks factory for this channel.
   *
   * The returned function takes a chatId and returns PilotCallbacks.
   * This pattern allows callbacks to capture channel-specific behavior
   * while being created per-message for agent pool compatibility.
   */
  createCallbacks: (
    channel: IChannel,
    context: ChannelSetupContext
  ) => (chatId: string) => PilotCallbacks;

  /**
   * Create a message handler for incoming messages.
   *
   * Receives a WiredContext that includes the channel and callbacks factory.
   * The handler should extract message data, get/create an agent, and process.
   */
  createMessageHandler: (channel: IChannel, context: WiredContext) => MessageHandler;

  /**
   * Post-registration setup hook.
   *
   * Called after the channel is registered and handlers are wired,
   * but before the channel starts. Use for:
   * - Setting up passive mode adapters
   * - Configuring action prompt resolvers
   * - Registering IPC handlers
   */
  setup?: (
    channel: IChannel,
    config: TConfig,
    context: ChannelSetupContext
  ) => void | Promise<void>;
}

// ============================================================================
// ChannelLifecycleManager
// ============================================================================

/**
 * ChannelLifecycleManager - Manages channel creation, wiring, and lifecycle.
 *
 * Combines ChannelManager (instance tracking + lifecycle) with
 * WiredChannelDescriptor (channel-specific wiring logic).
 *
 * Usage:
 * ```typescript
 * const manager = new ChannelLifecycleManager(channelManager, context);
 * const channel = await manager.createAndWire(REST_DESCRIPTOR, restConfig);
 * await manager.startAll();
 * ```
 */
export class ChannelLifecycleManager {
  private readonly channelManager: ChannelManager;
  private readonly context: ChannelSetupContext;

  constructor(channelManager: ChannelManager, context: ChannelSetupContext) {
    this.channelManager = channelManager;
    this.context = context;
  }

  /**
   * Create, register, and wire a channel using its descriptor.
   *
   * @param descriptor - The wired descriptor defining the channel
   * @param config - Channel-specific configuration
   * @returns The created and wired channel instance
   */
  async createAndWire<TConfig extends ChannelConfig>(
    descriptor: WiredChannelDescriptor<TConfig>,
    config: TConfig
  ): Promise<IChannel> {
    const channel = descriptor.factory(config);

    // Register with ChannelManager
    this.channelManager.register(channel);

    // Create callbacks factory from descriptor hook
    const callbacks = descriptor.createCallbacks(channel, this.context);

    // Create enriched context with channel and callbacks
    const wiredContext: WiredContext = {
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
   * Start all registered channels.
   * Delegates to ChannelManager.startAll().
   */
  async startAll(): Promise<void> {
    await this.channelManager.startAll();
  }

  /**
   * Stop all registered channels.
   * Delegates to ChannelManager.stopAll().
   */
  async stopAll(): Promise<void> {
    await this.channelManager.stopAll();
  }

  /**
   * Get the underlying ChannelManager.
   */
  getChannelManager(): ChannelManager {
    return this.channelManager;
  }
}
