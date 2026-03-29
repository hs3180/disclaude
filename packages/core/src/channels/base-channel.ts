/**
 * Base Channel Implementation.
 *
 * Provides common functionality for all channel implementations.
 * Extends EventEmitter for event-driven architecture.
 *
 * Features:
 * - State management (starting, running, stopping, stopped, error)
 * - Message and control handler registration
 * - Lifecycle management (start, stop, isHealthy)
 * - Error handling utilities
 *
 * @module channels/base-channel
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import {
  DEFAULT_CHANNEL_CAPABILITIES,
  type IChannel,
  type ChannelConfig,
  type ChannelStatus,
  type OutgoingMessage,
  type MessageHandler,
  type ControlHandler,
  type ControlResponse,
  type ChannelCapabilities,
} from '../types/channel.js';

const logger = createLogger('BaseChannel');

/**
 * Abstract base class for all channels.
 *
 * Provides common functionality:
 * - State management with status transitions
 * - Handler registration (message, control)
 * - Lifecycle methods with validation
 * - Error handling utilities
 *
 * Subclasses must implement:
 * - `doStart()`: Platform-specific startup logic
 * - `doStop()`: Platform-specific cleanup logic
 * - `doSendMessage()`: Platform-specific message sending
 * - `checkHealth()`: Platform-specific health check
 *
 * @example
 * ```typescript
 * class MyChannel extends BaseChannel<MyChannelConfig> {
 *   protected async doStart(): Promise<void> {
 *     // Connect to platform
 *   }
 *
 *   protected async doStop(): Promise<void> {
 *     // Disconnect from platform
 *   }
 *
 *   protected async doSendMessage(message: OutgoingMessage): Promise<string | void> {
 *     // Send via platform API
 *   }
 *
 *   protected checkHealth(): boolean {
 *     return this.isConnected;
 *   }
 * }
 * ```
 */
export abstract class BaseChannel<TConfig extends ChannelConfig = ChannelConfig>
  extends EventEmitter
  implements IChannel
{
  /** Unique channel identifier */
  readonly id: string;

  /** Human-readable channel name */
  readonly name: string;

  /** Channel configuration */
  protected readonly config: TConfig;

  /** Current channel status */
  private _status: ChannelStatus = 'stopped';

  /** Registered message handler */
  protected messageHandler?: MessageHandler;

  /** Registered control handler */
  protected controlHandler?: ControlHandler;

  /**
   * Create a new channel instance.
   *
   * @param config - Channel configuration
   * @param defaultId - Default channel ID if not specified in config
   * @param name - Human-readable channel name
   */
  constructor(config: TConfig, defaultId: string, name: string) {
    super();
    this.config = config;
    this.id = config.id || defaultId;
    this.name = name;

    logger.debug({ id: this.id, name: this.name }, 'Channel instance created');
  }

  /**
   * Get current channel status.
   */
  get status(): ChannelStatus {
    return this._status;
  }

  /**
   * Check if channel is currently running.
   */
  protected get isRunning(): boolean {
    return this._status === 'running';
  }

  /**
   * Register a handler for incoming messages.
   * Only one handler can be registered at a time.
   *
   * @param handler - Function to handle incoming messages
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
    logger.debug({ id: this.id }, 'Message handler registered');
  }

  /**
   * Register a handler for control commands.
   * Only one handler can be registered at a time.
   *
   * @param handler - Function to handle control commands
   */
  onControl(handler: ControlHandler): void {
    this.controlHandler = handler;
    logger.debug({ id: this.id }, 'Control handler registered');
  }

  /**
   * Send a message through this channel.
   * Delegates to platform-specific implementation.
   *
   * @param message - Message to send
   * @returns The platform message ID if available, void otherwise
   */
  async sendMessage(message: OutgoingMessage): Promise<string | void> {
    if (!this.isRunning) {
      throw new Error(`Channel ${this.id} is not running (status: ${this._status})`);
    }

    try {
      const messageId = await this.doSendMessage(message);
      logger.debug(
        { id: this.id, chatId: message.chatId, type: message.type, messageId },
        'Message sent'
      );
      return messageId;
    } catch (error) {
      logger.error(
        { err: error, id: this.id, chatId: message.chatId },
        'Failed to send message'
      );
      throw error;
    }
  }

  /**
   * Start the channel.
   * Manages state transitions and calls platform-specific startup.
   */
  async start(): Promise<void> {
    if (this._status === 'running') {
      logger.warn({ id: this.id }, 'Channel already running');
      return;
    }

    if (this._status === 'starting') {
      logger.warn({ id: this.id }, 'Channel is already starting');
      return;
    }

    logger.info({ id: this.id }, 'Starting channel');
    this._status = 'starting';

    try {
      await this.doStart();
      this._status = 'running';
      this.emit('started');
      logger.info({ id: this.id }, 'Channel started successfully');
    } catch (error) {
      this._status = 'error';
      this.emit('error', error);
      logger.error({ err: error, id: this.id }, 'Failed to start channel');
      throw error;
    }
  }

  /**
   * Stop the channel.
   * Manages state transitions and calls platform-specific cleanup.
   */
  async stop(): Promise<void> {
    if (this._status === 'stopped') {
      logger.debug({ id: this.id }, 'Channel already stopped');
      return;
    }

    if (this._status === 'stopping') {
      logger.warn({ id: this.id }, 'Channel is already stopping');
      return;
    }

    logger.info({ id: this.id }, 'Stopping channel');
    this._status = 'stopping';

    try {
      await this.doStop();
      this._status = 'stopped';
      this.emit('stopped');
      logger.info({ id: this.id }, 'Channel stopped successfully');
    } catch (error) {
      this._status = 'error';
      this.emit('error', error);
      logger.error({ err: error, id: this.id }, 'Failed to stop channel');
      throw error;
    }
  }

  /**
   * Check if the channel is healthy.
   * Combines base health check with platform-specific check.
   */
  isHealthy(): boolean {
    return this._status === 'running' && this.checkHealth();
  }

  /**
   * Update status (for subclasses to use).
   *
   * @param status - New status
   */
  protected setStatus(status: ChannelStatus): void {
    const oldStatus = this._status;
    this._status = status;
    logger.debug({ id: this.id, oldStatus, newStatus: status }, 'Status changed');
  }

  /**
   * Emit an incoming message to the registered handler.
   * Utility method for subclasses.
   *
   * @param message - Message to emit
   */
  protected async emitMessage(
    message: Parameters<MessageHandler>[0]
  ): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(message);
    } else {
      logger.warn(
        { id: this.id, messageId: message.messageId },
        'No message handler registered'
      );
    }
  }

  /**
   * Emit a control command to the registered handler.
   * Utility method for subclasses.
   *
   * @param command - Control command to emit
   * @returns Response from the control handler
   */
  protected emitControl(
    command: Parameters<ControlHandler>[0]
  ): Promise<ControlResponse> {
    if (this.controlHandler) {
      return this.controlHandler(command);
    }
    logger.warn({ id: this.id, type: command.type }, 'No control handler registered');
    return Promise.resolve({ success: false, error: 'No control handler registered' });
  }

  // Abstract methods for subclasses to implement

  /**
   * Platform-specific startup logic.
   * Called by start() after state validation.
   */
  protected abstract doStart(): Promise<void>;

  /**
   * Platform-specific cleanup logic.
   * Called by stop() after state validation.
   */
  protected abstract doStop(): Promise<void>;

  /**
   * Platform-specific message sending logic.
   * Called by sendMessage() after validation.
   *
   * @returns The platform message ID if available, void otherwise
   */
  protected abstract doSendMessage(message: OutgoingMessage): Promise<string | void>;

  /**
   * Platform-specific health check.
   * Called by isHealthy() when status is 'running'.
   */
  protected abstract checkHealth(): boolean;

  /**
   * Get the capabilities of this channel.
   * Subclasses should override to provide specific capabilities.
   *
   * @returns Channel capabilities describing what features are supported
   */
  getCapabilities(): ChannelCapabilities {
    return DEFAULT_CHANNEL_CAPABILITIES;
  }
}
