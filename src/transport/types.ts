/**
 * Transport layer types for communication between nodes.
 *
 * The Transport abstraction decouples the communication mechanism from
 * the business logic, allowing for different implementations:
 * - LocalTransport: In-process communication (single process mode)
 * - HttpTransport: HTTP-based communication (separate processes)
 */

/**
 * Task request sent from Communication Node to Execution Node.
 */
export interface TaskRequest {
  /** Unique task identifier */
  taskId: string;
  /** Platform-specific chat ID (e.g., Feishu chat ID) */
  chatId: string;
  /** User's message content */
  message: string;
  /** Unique message identifier for tracking */
  messageId: string;
  /** Optional sender's open ID for @ mentions */
  senderOpenId?: string;
  /** Additional context data */
  context?: Record<string, unknown>;
}

/**
 * Response from executing a task.
 */
export interface TaskResponse {
  /** Whether the task was accepted/started successfully */
  success: boolean;
  /** Error message if success is false */
  error?: string;
  /** Task ID for tracking */
  taskId: string;
}

/**
 * Message content types for sending to users.
 */
export type MessageContentType = 'text' | 'card' | 'file';

/**
 * Control command types for node-to-node communication.
 */
export type ControlCommandType = 'reset' | 'restart';

/**
 * Control command sent from Communication Node to Execution Node.
 */
export interface ControlCommand {
  /** Command type */
  type: ControlCommandType;
  /** Platform-specific chat ID */
  chatId: string;
  /** Optional additional data */
  data?: Record<string, unknown>;
}

/**
 * Response from executing a control command.
 */
export interface ControlResponse {
  /** Whether the command was executed successfully */
  success: boolean;
  /** Error message if success is false */
  error?: string;
  /** Command type */
  type: ControlCommandType;
}

/**
 * Message to be sent to the user via Communication Node.
 */
export interface MessageContent {
  /** Platform-specific chat ID */
  chatId: string;
  /** Content type */
  type: MessageContentType;
  /** Text content (for type 'text') */
  text?: string;
  /** Card JSON structure (for type 'card') */
  card?: Record<string, unknown>;
  /** File path (for type 'file') */
  filePath?: string;
  /** Optional description for logging */
  description?: string;
}

/**
 * Callback interface for Execution Node to send messages.
 * Implementation provided by Communication Node.
 */
export interface MessageSender {
  /**
   * Send a text message.
   */
  sendMessage(chatId: string, text: string): Promise<void>;

  /**
   * Send an interactive card.
   */
  sendCard(chatId: string, card: Record<string, unknown>, description?: string): Promise<void>;

  /**
   * Send a file.
   */
  sendFile(chatId: string, filePath: string): Promise<void>;
}

/**
 * Handler for processing task requests.
 * Used by Execution Node to receive and process tasks.
 */
export type TaskHandler = (request: TaskRequest) => Promise<TaskResponse>;

/**
 * Handler for receiving messages from Execution Node.
 * Used by Communication Node to send messages to users.
 */
export type MessageHandler = (content: MessageContent) => Promise<void>;

/**
 * Handler for processing control commands.
 * Used by Execution Node to receive control commands.
 */
export type ControlHandler = (command: ControlCommand) => Promise<ControlResponse>;

/**
 * Transport interface for node communication.
 *
 * This is the core abstraction that allows Communication Node and
 * Execution Node to communicate, regardless of whether they're in
 * the same process or separate processes.
 *
 * Implementations:
 * - LocalTransport: Direct function calls (single process)
 * - HttpTransport: HTTP-based communication (separate processes)
 */
export interface ITransport {
  /**
   * Send a task request to the Execution Node.
   * Called by Communication Node.
   *
   * @param request - Task request to send
   * @returns Response indicating if task was accepted
   */
  sendTask(request: TaskRequest): Promise<TaskResponse>;

  /**
   * Register a handler for incoming task requests.
   * Called by Execution Node.
   *
   * @param handler - Function to process task requests
   */
  onTask(handler: TaskHandler): void;

  /**
   * Send a message to the Communication Node for delivery.
   * Called by Execution Node.
   *
   * @param content - Message content to send
   */
  sendMessage(content: MessageContent): Promise<void>;

  /**
   * Register a handler for incoming messages.
   * Called by Communication Node.
   *
   * @param handler - Function to handle messages
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Send a control command to the Execution Node.
   * Called by Communication Node.
   *
   * @param command - Control command to send
   * @returns Response indicating if command was executed
   */
  sendControl(command: ControlCommand): Promise<ControlResponse>;

  /**
   * Register a handler for incoming control commands.
   * Called by Execution Node.
   *
   * @param handler - Function to handle control commands
   */
  onControl(handler: ControlHandler): void;

  /**
   * Initialize the transport.
   * Called by both nodes during startup.
   */
  start(): Promise<void>;

  /**
   * Shutdown the transport.
   * Called by both nodes during shutdown.
   */
  stop(): Promise<void>;
}
