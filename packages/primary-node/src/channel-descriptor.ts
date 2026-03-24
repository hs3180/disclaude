/**
 * Channel Descriptor - Declarative channel wiring and lifecycle management.
 *
 * This module provides:
 * - `ChannelDescriptor`: Declarative description of how to create, wire, and set up a channel
 * - `ChannelLifecycleManager`: Orchestrates channel creation, wiring, and lifecycle
 *
 * Part of Issue #1594: Unify fragmented channel management architecture.
 *
 * @module @disclaude/primary-node/channel-descriptor
 */

import {
  createLogger,
  type IChannel,
  type MessageHandler,
  type ControlHandler,
  type IncomingMessage,
  type FileRef,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import { ChannelManager } from './channel-manager.js';

const logger = createLogger('ChannelLifecycleManager');

// ============================================================================
// Types
// ============================================================================

/**
 * Factory function that creates PilotCallbacks for a specific chatId.
 * Each call produces fresh callbacks that close over the channel instance.
 */
export type PilotCallbacksFactory = (chatId: string) => PilotCallbacks;

/**
 * Minimal interface for agent pool operations needed by channel descriptors.
 * This avoids tight coupling to PrimaryAgentPool concrete type.
 */
export interface IAgentPoolForWiring {
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): {
    processMessage(
      chatId: string,
      content: string,
      messageId: string,
      userId: string | undefined,
      fileRefs: FileRef[] | undefined,
      chatHistoryContext: string | undefined,
    ): void;
  };
}

/**
 * Minimal interface for PrimaryNode operations needed by channel descriptors.
 */
export interface IPrimaryNodeForWiring {
  registerFeishuHandlers(handlers: unknown): void;
}

/**
 * Context provided to channel descriptor hooks during setup.
 * Contains all shared services that descriptors may need.
 */
export interface ChannelSetupContext {
  /** Agent pool for creating/getting chat agents */
  agentPool: IAgentPoolForWiring;
  /** Unified control handler */
  controlHandler: ControlHandler;
  /** Control handler context (for passive mode etc.) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  controlHandlerContext: any;
  /** Primary node reference (for IPC handler registration) */
  primaryNode: IPrimaryNodeForWiring;
  /** Logger instance */
  logger: ReturnType<typeof createLogger>;
}

/**
 * Describes how to create, wire, and set up a communication channel.
 *
 * A descriptor encapsulates all channel-specific logic that was previously
 * hardcoded in cli.ts, including:
 * - Channel instantiation (factory)
 * - PilotCallbacks creation (createCallbacks)
 * - Message handling (createMessageHandler or default handler)
 * - Attachment extraction (extractAttachments)
 * - Post-registration setup (setup)
 *
 * @typeParam TConfig - Channel-specific configuration type
 */
export interface ChannelDescriptor<TConfig = unknown> {
  /** Channel type identifier (e.g., 'rest', 'feishu') */
  readonly type: string;
  /** Display name for logging */
  readonly name: string;
  /** Factory function to create channel instance */
  readonly factory: (config: TConfig) => IChannel;

  /**
   * Create PilotCallbacks factory for this channel.
   * The returned factory is called per-message to get fresh callbacks.
   */
  readonly createCallbacks: (channel: IChannel, context: ChannelSetupContext) => PilotCallbacksFactory;

  /**
   * Whether to send 'done' signal on completion/error (default: false).
   * REST channels use this for synchronous mode signaling.
   */
  readonly sendDoneSignal?: boolean;

  /**
   * Extract file attachments from incoming message.
   * Channels that support file attachments should implement this.
   */
  readonly extractAttachments?: (message: IncomingMessage) => FileRef[] | undefined;

  /**
   * Optional custom message handler.
   * If not provided, ChannelLifecycleManager uses a default handler that:
   * 1. Creates callbacks via createCallbacks factory
   * 2. Gets/creates chat agent
   * 3. Extracts attachments (if extractAttachments provided)
   * 4. Processes message through agent
   * 5. Handles errors (with optional done signal)
   */
  readonly createMessageHandler?: (channel: IChannel, context: ChannelSetupContext) => MessageHandler;

  /**
   * Optional post-registration setup hook.
   * Used for channel-specific initialization like passive mode, IPC handlers, etc.
   * Called after channel is registered and handlers are wired.
   */
  readonly setup?: (channel: IChannel, context: ChannelSetupContext) => void | Promise<void>;
}

// ============================================================================
// ChannelLifecycleManager
// ============================================================================

/**
 * Manages channel lifecycle using declarative ChannelDescriptor wiring.
 *
 * Combines ChannelManager (instance tracking + lifecycle) with descriptor-based
 * channel creation and wiring. Replaces ~300 lines of channel-specific code
 * in cli.ts with a declarative descriptor pattern.
 *
 * Usage:
 * ```typescript
 * const lifecycleManager = new ChannelLifecycleManager(channelManager, context);
 * await lifecycleManager.createAndWire(restDescriptor, restConfig);
 * await lifecycleManager.createAndWire(feishuDescriptor, feishuConfig);
 * await lifecycleManager.startAll();
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
   * Create a channel from a descriptor, register it, wire handlers, and run setup.
   *
   * @param descriptor - Channel descriptor defining creation and wiring logic
   * @param config - Channel-specific configuration
   * @returns The created and wired channel instance
   */
  async createAndWire<TConfig>(
    descriptor: ChannelDescriptor<TConfig>,
    config: TConfig
  ): Promise<IChannel> {
    // 1. Create channel instance from factory
    const channel = descriptor.factory(config);
    logger.info({ channelType: descriptor.type, channelId: channel.id }, 'Creating channel from descriptor');

    // 2. Register with ChannelManager
    this.channelManager.register(channel);

    // 3. Create message handler (custom or default)
    const messageHandler = descriptor.createMessageHandler
      ? descriptor.createMessageHandler(channel, this.context)
      : this.createDefaultMessageHandler(descriptor as ChannelDescriptor, channel);

    // 4. Wire handlers via ChannelManager
    this.channelManager.setupHandlers(channel, messageHandler, this.context.controlHandler);

    // 5. Post-registration setup (passive mode, IPC handlers, etc.)
    if (descriptor.setup) {
      await descriptor.setup(channel, this.context);
    }

    logger.info({ channelType: descriptor.type, channelId: channel.id }, 'Channel wired successfully');
    return channel;
  }

  /**
   * Create default message handler for a channel descriptor.
   *
   * The default handler:
   * 1. Creates PilotCallbacks via the descriptor's factory
   * 2. Gets or creates a chat agent from the agent pool
   * 3. Extracts attachments if the descriptor supports it
   * 4. Processes the message through the agent
   * 5. Handles errors with an error message (and optional done signal)
   */
  private createDefaultMessageHandler(descriptor: ChannelDescriptor, channel: IChannel): MessageHandler {
    return async (message: IncomingMessage): Promise<void> => {
      const { chatId, content, messageId, userId, metadata } = message;
      logger.info(
        { chatId, messageId, contentLength: content.length, channelType: descriptor.type },
        'Processing message'
      );

      // Create callbacks for this message
      const callbacksFactory = descriptor.createCallbacks(channel, this.context);
      const callbacks = callbacksFactory(chatId);

      // Get or create agent
      const agent = this.context.agentPool.getOrCreateChatAgent(chatId, callbacks);

      // Extract chat history context
      const chatHistoryContext = metadata?.chatHistoryContext as string | undefined;

      // Extract attachments if supported by this channel
      const fileRefs = descriptor.extractAttachments
        ? descriptor.extractAttachments(message)
        : undefined;

      try {
        agent.processMessage(chatId, content, messageId, userId, fileRefs, chatHistoryContext);
      } catch (error) {
        logger.error({ err: error, chatId, messageId }, 'Failed to process message');
        const errorMsg = error instanceof Error ? error.message : String(error);
        await channel.sendMessage({
          chatId,
          type: 'text',
          text: `❌ Error: ${errorMsg}`,
        });
        // Send done signal for synchronous channels (e.g., REST)
        if (descriptor.sendDoneSignal) {
          await channel.sendMessage({ chatId, type: 'done' });
        }
      }
    };
  }

  // ============================================================================
  // ChannelManager delegation
  // ============================================================================

  /** Get the underlying ChannelManager for advanced operations. */
  getChannelManager(): ChannelManager {
    return this.channelManager;
  }

  /** Get a registered channel by ID. */
  get(channelId: string): IChannel | undefined {
    return this.channelManager.get(channelId);
  }

  /** Get all registered channels. */
  getAll(): IChannel[] {
    return this.channelManager.getAll();
  }

  /** Check if a channel is registered. */
  has(channelId: string): boolean {
    return this.channelManager.has(channelId);
  }

  /** Start all registered channels. */
  async startAll(): Promise<void> {
    return this.channelManager.startAll();
  }

  /** Stop all registered channels. */
  async stopAll(): Promise<void> {
    return this.channelManager.stopAll();
  }

  /** Broadcast a message to all registered channels. */
  async broadcast(message: Parameters<ChannelManager['broadcast']>[0]): Promise<void> {
    return this.channelManager.broadcast(message);
  }

  /** Get status info for all channels. */
  getStatusInfo(): ReturnType<ChannelManager['getStatusInfo']> {
    return this.channelManager.getStatusInfo();
  }
}
