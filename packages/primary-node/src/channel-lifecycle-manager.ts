/**
 * Channel Lifecycle Manager - Combines ChannelManager with descriptor-based wiring.
 *
 * Part of Issue #1594 (Phase 2): Abstract channel wiring into descriptors.
 *
 * This module provides:
 * - WiredChannelDescriptor: extends ChannelDescriptor with wiring hooks
 * - ChannelLifecycleManager: creates, wires, and manages channel lifecycle
 * - createChannelCallbacks: capability-driven callback factory
 * - createDefaultMessageHandler: shared message handling logic
 *
 * @module channel-lifecycle-manager
 */

import {
  createLogger,
  type IChannel,
  type ChannelConfig,
  type MessageHandler,
  type ControlHandler,
  type ChannelCapabilities,
  type ControlHandlerContext,
  type IncomingMessage,
  type FileRef,
} from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import { ChannelManager } from './channel-manager.js';
import { PrimaryAgentPool } from './primary-agent-pool.js';
import type { PrimaryNode } from './primary-node.js';

const logger = createLogger('ChannelLifecycleManager');

// ============================================================================
// Types
// ============================================================================

/**
 * Context provided to channel wiring functions.
 */
export interface ChannelSetupContext {
  agentPool: PrimaryAgentPool;
  controlHandler: ControlHandler;
  /** Raw control handler context — needed by Feishu for passive mode setup */
  controlHandlerContext?: ControlHandlerContext;
  primaryNode: PrimaryNode;
}

/**
 * Options for capability-driven callback creation.
 */
export interface CallbackOptions {
  /** Whether to send a 'done' signal when task completes (REST sync mode) */
  sendDoneSignal?: boolean;
}

/**
 * Options for default message handler creation.
 */
export interface MessageHandlerOptions {
  /** Custom attachment conversion function */
  convertAttachments?: (message: IncomingMessage) => FileRef[] | undefined;
  /** Whether to send 'done' signal on error */
  sendDoneSignalOnError?: boolean;
}

/**
 * A wired channel descriptor that includes both factory and wiring logic.
 *
 * Unlike the core ChannelDescriptor (which only handles instantiation),
 * this includes all the channel-specific wiring needed for Primary Node:
 * - How to create PilotCallbacks for this channel
 * - How to handle incoming messages
 * - Post-registration setup (e.g., passive mode, IPC handlers)
 */
export interface WiredChannelDescriptor<TConfig extends ChannelConfig = ChannelConfig> {
  /** Unique channel type identifier (e.g. 'rest', 'feishu') */
  type: string;
  /** Human-readable name */
  name: string;
  /** Factory function to create channel instance */
  factory: (config: TConfig) => IChannel;
  /** Default capabilities for this channel type */
  defaultCapabilities: ChannelCapabilities;

  // === Wiring hooks (Issue #1594 Phase 2) ===

  /**
   * Create PilotCallbacks for this channel.
   * Wraps channel.sendMessage() into the agent interface.
   */
  createCallbacks: (channel: IChannel, context: ChannelSetupContext) => PilotCallbacks;

  /**
   * Create message handler for this channel.
   * Processes incoming messages through agentPool.
   * Receives the callbacks created by createCallbacks for consistency.
   *
   * If not provided, createDefaultMessageHandler is used with the callbacks.
   */
  createMessageHandler?: (channel: IChannel, context: ChannelSetupContext, callbacks: PilotCallbacks) => MessageHandler;

  /**
   * Options for the default message handler (used when createMessageHandler is not provided).
   */
  messageHandlerOptions?: MessageHandlerOptions;

  /**
   * Post-registration setup.
   * For things like passive mode configuration, IPC handler registration, etc.
   */
  setup?: (channel: IChannel, context: ChannelSetupContext) => void | Promise<void>;
}

// ============================================================================
// Capability-Driven Callback Factory
// ============================================================================

/**
 * Create PilotCallbacks that wrap channel.sendMessage() into the agent interface.
 *
 * Uses channel capabilities to determine behavior:
 * - `supportsFile` → enable/disable file sending
 * - `sendDoneSignal` option → differentiates REST (sync) vs Feishu (async) mode
 *
 * @param channel - The channel instance to wrap
 * @param options - Callback behavior options
 */
export function createChannelCallbacks(
  channel: IChannel,
  options: CallbackOptions = {}
): PilotCallbacks {
  const { sendDoneSignal = false } = options;
  const channelId = channel.id;

  return {
    sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
      await channel.sendMessage({
        chatId,
        type: 'text',
        text,
        threadId: parentMessageId,
      });
    },

    sendCard: async (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
      await channel.sendMessage({
        chatId,
        type: 'card',
        card,
        description,
        threadId: parentMessageId,
      });
    },

    sendFile: async (chatId: string, filePath: string) => {
      const caps = channel.getCapabilities();
      if (caps.supportsFile) {
        await channel.sendMessage({
          chatId,
          type: 'file',
          filePath,
        });
      } else {
        logger.warn({ channelId, chatId, filePath }, 'File sending not supported by this channel');
      }
    },

    onDone: async (chatId: string, parentMessageId?: string) => {
      if (sendDoneSignal) {
        await channel.sendMessage({
          chatId,
          type: 'done',
          threadId: parentMessageId,
        });
      }
      logger.info({ channelId, chatId }, 'Task completed');
    },
  };
}

// ============================================================================
// Default Message Handler
// ============================================================================

/**
 * Create a default message handler that processes incoming messages through agentPool.
 *
 * Shared flow:
 * 1. Extract message data (chatId, content, messageId, userId, metadata)
 * 2. Get or create agent from pool using channel callbacks
 * 3. Optionally convert attachments (e.g., Feishu images/files)
 * 4. Process message through agent
 * 5. On error, send error message back to channel
 *
 * @param channel - The channel instance
 * @param context - Setup context with agentPool and controlHandler
 * @param callbacks - PilotCallbacks for this channel (created by descriptor)
 * @param options - Message handler options
 */
export function createDefaultMessageHandler(
  channel: IChannel,
  context: ChannelSetupContext,
  callbacks: PilotCallbacks,
  options: MessageHandlerOptions = {}
): MessageHandler {
  const {
    convertAttachments,
    sendDoneSignalOnError = false,
  } = options;

  const channelId = channel.id;

  return async (message: IncomingMessage) => {
    const { chatId, content, messageId, userId, metadata } = message;
    logger.info(
      { channelId, chatId, messageId, contentLength: content.length, hasAttachments: !!message.attachments },
      'Processing message'
    );

    const agent = context.agentPool.getOrCreateChatAgent(chatId, callbacks);

    // Extract context
    const senderOpenId = userId;
    const chatHistoryContext = metadata?.chatHistoryContext as string | undefined;

    // Convert attachments (channel-specific, e.g., Feishu images/files)
    const fileRefs = convertAttachments?.(message);

    try {
      agent.processMessage(chatId, content, messageId, senderOpenId, fileRefs, chatHistoryContext);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ channelId, err: error, chatId, messageId }, 'Failed to process message');

      await channel.sendMessage({
        chatId,
        type: 'text',
        text: `❌ Error: ${errorMsg}`,
      });

      if (sendDoneSignalOnError) {
        await channel.sendMessage({
          chatId,
          type: 'done',
        });
      }
    }
  };
}

// ============================================================================
// Channel Lifecycle Manager
// ============================================================================

/**
 * Channel Lifecycle Manager.
 *
 * Combines ChannelManager (instance tracking + lifecycle) with
 * descriptor-based wiring (callbacks, message handlers, setup).
 *
 * Usage:
 * ```typescript
 * const manager = new ChannelLifecycleManager({
 *   channelManager: primaryNode.getChannelManager(),
 *   agentPool,
 *   controlHandler,
 *   primaryNode,
 * });
 *
 * manager.registerDescriptor(restDescriptor);
 * manager.registerDescriptor(feishuDescriptor);
 *
 * const channel = await manager.createAndWire('rest', restConfig);
 * await manager.startAll();
 * ```
 */
export class ChannelLifecycleManager {
  private readonly channelManager: ChannelManager;
  private readonly descriptors = new Map<string, WiredChannelDescriptor>();
  private readonly context: ChannelSetupContext;

  constructor(options: {
    channelManager: ChannelManager;
    agentPool: PrimaryAgentPool;
    controlHandler: ControlHandler;
    controlHandlerContext?: ControlHandlerContext;
    primaryNode: PrimaryNode;
  }) {
    this.channelManager = options.channelManager;
    this.context = {
      agentPool: options.agentPool,
      controlHandler: options.controlHandler,
      controlHandlerContext: options.controlHandlerContext,
      primaryNode: options.primaryNode,
    };
  }

  /**
   * Register a wired channel descriptor.
   */
  registerDescriptor(descriptor: WiredChannelDescriptor): void {
    if (this.descriptors.has(descriptor.type)) {
      logger.warn({ type: descriptor.type }, 'Descriptor already registered, replacing');
    }
    this.descriptors.set(descriptor.type, descriptor);
    logger.info({ type: descriptor.type, name: descriptor.name }, 'Channel descriptor registered');
  }

  /**
   * Get a registered descriptor by type.
   */
  getDescriptor(type: string): WiredChannelDescriptor | undefined {
    return this.descriptors.get(type);
  }

  /**
   * Get all registered descriptor types.
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.descriptors.keys());
  }

  /**
   * Create, wire, and register a channel instance.
   *
   * Steps:
   * 1. Create channel instance via descriptor factory
   * 2. Create callbacks and message handler via descriptor hooks
   * 3. Wire handlers via ChannelManager
   * 4. Register with ChannelManager
   * 5. Run post-registration setup (if defined)
   *
   * @param type - Channel type (must match a registered descriptor)
   * @param config - Channel configuration
   * @returns The created and wired channel instance
   */
  async createAndWire<TConfig extends ChannelConfig>(
    type: string,
    config: TConfig
  ): Promise<IChannel> {
    const descriptor = this.descriptors.get(type);
    if (!descriptor) {
      const available = this.getRegisteredTypes().join(', ');
      throw new Error(`Unknown channel type: "${type}". Registered types: [${available}]`);
    }

    logger.info({ type, name: descriptor.name }, 'Creating and wiring channel');

    // 1. Create channel instance
    const channel = descriptor.factory(config);

    // 2. Create callbacks
    const callbacks = descriptor.createCallbacks(channel, this.context);

    // 3. Create message handler (custom or default)
    const messageHandler = descriptor.createMessageHandler
      ? descriptor.createMessageHandler(channel, this.context, callbacks)
      : createDefaultMessageHandler(channel, this.context, callbacks, descriptor.messageHandlerOptions);

    // 4. Wire handlers via ChannelManager
    this.channelManager.setupHandlers(channel, messageHandler, this.context.controlHandler);

    // 5. Register with ChannelManager
    this.channelManager.register(channel);

    // 6. Post-registration setup (e.g., passive mode, IPC handlers)
    if (descriptor.setup) {
      await descriptor.setup(channel, this.context);
    }

    logger.info(
      { channelId: channel.id, type, name: descriptor.name },
      'Channel created, wired, and registered'
    );

    return channel;
  }

  /**
   * Start all registered channels.
   */
  async startAll(): Promise<void> {
    await this.channelManager.startAll();
  }

  /**
   * Stop all registered channels.
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
