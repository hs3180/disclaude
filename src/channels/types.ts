/**
 * Channel abstraction types.
 *
 * A Channel represents a communication pathway between users and the agent.
 * Different platforms (Feishu, REST API, etc.) can implement this interface
 * to provide a unified way of receiving and sending messages.
 *
 * Architecture:
 * ```
 *                    ┌─────────────────┐
 *                    │  Communication  │
 *   Feishu Channel ──│      Node       │── Execution Node
 *   REST Channel   ──│  (multiplexer)  │    (Agent)
 *   (future)       ──│                 │
 *                    └─────────────────┘
 * ```
 */

/**
 * Generic message structure received from any channel.
 */
export interface IncomingMessage {
  /** Unique message identifier for tracking and deduplication */
  messageId: string;

  /** Chat/conversation identifier (platform-specific) */
  chatId: string;

  /** User identifier (platform-specific, e.g., open_id for Feishu) */
  userId?: string;

  /** Message content (text or structured data) */
  content: string;

  /** Message type (text, image, file, etc.) */
  messageType: 'text' | 'image' | 'file' | 'media' | 'post' | 'card';

  /** Timestamp when message was created (ms since epoch) */
  timestamp?: number;

  /** Parent message ID for thread replies */
  parentId?: string;

  /** Additional metadata from the channel */
  metadata?: Record<string, unknown>;

  /** File attachments (if any) */
  attachments?: MessageAttachment[];
}

/**
 * File attachment in a message.
 */
export interface MessageAttachment {
  /** File name */
  fileName: string;

  /** Local file path (after download) */
  filePath: string;

  /** MIME type */
  mimeType?: string;

  /** File size in bytes */
  size?: number;
}

/**
 * Outgoing message content types.
 */
export type OutgoingContentType = 'text' | 'card' | 'file';

/**
 * Outgoing message to be sent through a channel.
 */
export interface OutgoingMessage {
  /** Target chat/conversation ID */
  chatId: string;

  /** Content type */
  type: OutgoingContentType;

  /** Text content (for type 'text') */
  text?: string;

  /** Card structure (for type 'card', platform-specific JSON) */
  card?: Record<string, unknown>;

  /** File path (for type 'file') */
  filePath?: string;

  /** Optional description for logging */
  description?: string;

  /** Parent message ID for thread replies */
  parentId?: string;
}

/**
 * Control command types.
 */
export type ControlCommandType = 'reset' | 'restart' | 'status';

/**
 * Control command from user to agent.
 */
export interface ControlCommand {
  /** Command type */
  type: ControlCommandType;

  /** Target chat ID */
  chatId: string;

  /** Additional command data */
  data?: Record<string, unknown>;
}

/**
 * Control response.
 */
export interface ControlResponse {
  /** Whether the command was executed successfully */
  success: boolean;

  /** Response message or error */
  message?: string;

  /** Error details if failed */
  error?: string;
}

/**
 * Message handler function type.
 * Called when a new message is received from the channel.
 */
export type MessageHandler = (message: IncomingMessage) => Promise<void>;

/**
 * Control handler function type.
 * Called when a control command is received.
 */
export type ControlHandler = (command: ControlCommand) => Promise<ControlResponse>;

/**
 * Channel status.
 */
export type ChannelStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/**
 * Channel interface.
 *
 * All communication channels must implement this interface.
 * The CommunicationNode uses this interface to interact with channels.
 */
export interface IChannel {
  /**
   * Unique channel identifier.
   * Used for logging and debugging.
   */
  readonly id: string;

  /**
   * Channel name for display purposes.
   */
  readonly name: string;

  /**
   * Current channel status.
   */
  readonly status: ChannelStatus;

  /**
   * Register a handler for incoming messages.
   * Only one handler can be registered at a time.
   *
   * @param handler - Function to handle incoming messages
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Register a handler for control commands.
   * Only one handler can be registered at a time.
   *
   * @param handler - Function to handle control commands
   */
  onControl(handler: ControlHandler): void;

  /**
   * Send a message through this channel.
   *
   * @param message - Message to send
   */
  sendMessage(message: OutgoingMessage): Promise<void>;

  /**
   * Start the channel.
   * Should initialize connections, start listeners, etc.
   */
  start(): Promise<void>;

  /**
   * Stop the channel.
   * Should clean up resources, close connections, etc.
   */
  stop(): Promise<void>;

  /**
   * Check if the channel is healthy.
   * Used for health checks and monitoring.
   */
  isHealthy(): boolean;
}

/**
 * Base configuration for all channels.
 */
export interface ChannelConfig {
  /** Channel identifier (optional, defaults to channel type) */
  id?: string;

  /** Enable/disable channel */
  enabled?: boolean;
}

/**
 * Channel factory function type.
 */
export type ChannelFactory<TConfig extends ChannelConfig = ChannelConfig> = (
  config: TConfig
) => IChannel;
